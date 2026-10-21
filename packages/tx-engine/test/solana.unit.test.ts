import { createMemoryStorage } from '@omnimarket/wallet-core'
import { SOLANA_CHAINS, SolanaConnector } from '@omnimarket/wallet-core/solana'
import { createMockSolanaWallet } from '@omnimarket/wallet-core/testing'
import type { Address, Instruction, Rpc, SolanaRpcApi } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import { TxStore, type SolanaTxRecord } from '../src'
import { SolanaTxEngine } from '../src/solana'

const MEMO: Instruction = {
  programAddress: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' as Address,
  data: new TextEncoder().encode('omni'),
}

/** Deterministic RPC: the test decides block height, statuses and simulation results. */
function fakeRpc() {
  const state = {
    blockHeight: 100n,
    lastValidBlockHeight: 150n,
    statuses: new Map<string, unknown>(),
    sent: [] as string[],
    simulateErr: null as unknown,
    unitsConsumed: 5_000n,
    sendFails: false,
  }
  const ok = <T>(fn: () => T) => ({ send: async () => fn() })
  const rpc = {
    getLatestBlockhash: () =>
      ok(() => ({ value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: state.lastValidBlockHeight } })),
    simulateTransaction: () => ok(() => ({ value: { err: state.simulateErr, logs: [], unitsConsumed: state.unitsConsumed } })),
    getRecentPrioritizationFees: () => ok(() => [{ slot: 1n, prioritizationFee: 0n }, { slot: 2n, prioritizationFee: 700n }]),
    sendTransaction: (wire: string) =>
      ok(() => {
        if (state.sendFails) throw new Error('fetch failed')
        state.sent.push(wire)
        return 'sig'
      }),
    getSignatureStatuses: (sigs: string[]) => ok(() => ({ value: sigs.map((s) => state.statuses.get(s) ?? null) })),
    getBlockHeight: () => ok(() => state.blockHeight),
    getTransaction: () => ok(() => ({ meta: { fee: 5_000n } })),
  }
  return { state, rpc: rpc as unknown as Rpc<SolanaRpcApi> }
}

async function setup(options: { programErrors?: (p: string, c: number) => string | undefined } = {}) {
  const { state, rpc } = fakeRpc()
  let now = 1_000_000
  const store = new TxStore({ storage: createMemoryStorage(), now: () => now })
  const engine = new SolanaTxEngine({ store, getRpc: () => rpc, now: () => now, stuckAfterMs: 30_000, ...options })
  const mock = await createMockSolanaWallet()
  const connector = new SolanaConnector(mock.wallet, SOLANA_CHAINS)
  const { accounts } = await connector.connect({ chainId: 'solana:localnet' })
  const send = (patch: Partial<Parameters<SolanaTxEngine['send']>[0]> = {}) =>
    engine.send({ id: 'tx', label: 'Memo', connector, account: accounts[0]!, instructions: [MEMO], ...patch })
  const record = () => store.get('tx') as SolanaTxRecord
  const pending = async () => {
    await expect.poll(() => store.get('tx')?.status).toBe('pending')
    return record()
  }
  return { state, engine, store, mock, send, record, pending, advance: (ms: number) => (now += ms) }
}

describe('SolanaTxEngine', () => {
  it('sends once, then confirms through processed → confirmed', async () => {
    const t = await setup()
    const done = t.send()
    const { signature } = await t.pending()
    expect(t.state.sent).toHaveLength(1)

    t.state.statuses.set(signature!, { slot: 10n, confirmations: 0n, err: null, confirmationStatus: 'processed' })
    await t.engine.pollNow('solana:localnet')
    expect(t.record()).toMatchObject({ status: 'confirming', commitment: 'processed' })

    t.state.statuses.set(signature!, { slot: 10n, confirmations: 1n, err: null, confirmationStatus: 'confirmed' })
    await t.engine.pollNow('solana:localnet')
    expect(await done).toMatchObject({ status: 'confirmed', commitment: 'confirmed', slot: '10' })
  })

  it('waits for finalized when asked to', async () => {
    const t = await setup()
    const done = t.send({ commitment: 'finalized' })
    const { signature } = await t.pending()
    t.state.statuses.set(signature!, { slot: 10n, confirmations: 5n, err: null, confirmationStatus: 'confirmed' })
    await t.engine.pollNow('solana:localnet')
    expect(t.record().status).toBe('confirming')
    t.state.statuses.set(signature!, { slot: 10n, confirmations: null, err: null, confirmationStatus: 'finalized' })
    await t.engine.pollNow('solana:localnet')
    expect((await done).status).toBe('confirmed')
  })

  it('rebroadcasts while the blockhash is valid, even after a failed send', async () => {
    const t = await setup()
    t.state.sendFails = true
    void t.send()
    await t.pending()
    await expect.poll(() => t.record().syncError).toMatch(/fetch failed/) // not a failure: still pending

    t.state.sendFails = false
    t.advance(2_000)
    await t.engine.pollNow('solana:localnet')
    t.advance(2_000)
    await t.engine.pollNow('solana:localnet')
    expect(t.state.sent).toHaveLength(2)
    expect(t.record().status).toBe('pending')
  })

  it('expires (safe to retry) once the block height passes lastValidBlockHeight', async () => {
    const t = await setup()
    const done = t.send()
    await t.pending()
    t.state.blockHeight = 151n
    await t.engine.pollNow('solana:localnet')
    expect((await done).error).toMatchObject({ kind: 'expired' })
  })

  it('flags stuck transactions', async () => {
    const t = await setup()
    void t.send()
    await t.pending()
    t.advance(31_000)
    await t.engine.pollNow('solana:localnet')
    expect(t.record().stuck).toBe(true)
  })

  it('goes back to pending when a processed transaction is dropped with its fork', async () => {
    const t = await setup()
    void t.send()
    const { signature } = await t.pending()
    t.state.statuses.set(signature!, { slot: 10n, confirmations: 0n, err: null, confirmationStatus: 'processed' })
    await t.engine.pollNow('solana:localnet')
    t.state.statuses.delete(signature!)
    await t.engine.pollNow('solana:localnet')
    expect(t.record()).toMatchObject({ status: 'pending', commitment: undefined })
  })

  it('stops at simulation with the program error name and never prompts', async () => {
    const t = await setup({ programErrors: (p, code) => (p.startsWith('Memo') && code === 3 ? 'InvalidAuthority' : undefined) })
    t.state.simulateErr = { InstructionError: [1, { Custom: 3 }] } // index 1: the memo, after SetComputeUnitLimit
    const result = await t.send()
    expect(result.error).toMatchObject({ kind: 'simulation_reverted', errorName: 'InvalidAuthority', errorArgs: ['3'] })
    expect(t.mock.calls).not.toContain('solana:signTransaction')
  })

  it('maps an empty fee payer to insufficient funds', async () => {
    const t = await setup()
    t.state.simulateErr = 'AccountNotFound'
    expect((await t.send()).error?.kind).toBe('insufficient_funds')
  })

  it('records a wallet rejection', async () => {
    const t = await setup()
    t.mock.rejectNextRequest()
    expect((await t.send()).error?.kind).toBe('user_rejected')
  })

  it('sizes compute units from the simulation and adds a priority fee', async () => {
    const t = await setup()
    void t.send()
    const { wireTransaction, programs } = await t.pending()
    expect(wireTransaction).toBeTypeOf('string')
    // SetComputeUnitLimit + SetComputeUnitPrice (median of non-zero recent fees) + Memo, as signed.
    expect(programs).toEqual([
      'ComputeBudget111111111111111111111111111111',
      'ComputeBudget111111111111111111111111111111',
      'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
    ])
  })

  it('records an on-chain failure with the program at the failing index', async () => {
    const t = await setup({ programErrors: (p, code) => (p.startsWith('Memo') && code === 1 ? 'MemoFailed' : undefined) })
    const done = t.send()
    const { signature } = await t.pending()
    t.state.statuses.set(signature!, { slot: 11n, confirmations: 1n, err: { InstructionError: [2, { Custom: 1 }] }, confirmationStatus: 'confirmed' })
    await t.engine.pollNow('solana:localnet')
    expect((await done).error).toMatchObject({ kind: 'reverted', errorName: 'MemoFailed' })
  })
})
