import { coreErrorName, createAssetInstruction, fetchAssetsByOwner, transferAssetInstruction } from '@omnimarket/contracts/solana'
import { createMemoryStorage } from '@omnimarket/wallet-core'
import { SOLANA_CHAINS, SolanaConnector } from '@omnimarket/wallet-core/solana'
import { createMockSolanaWallet } from '@omnimarket/wallet-core/testing'
import { createSolanaRpc, generateKeyPairSigner, lamports, type Address } from '@solana/kit'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TxStore } from '../src'
import { SolanaTxEngine } from '../src/solana'

const hasValidator = spawnSync('solana-test-validator', ['--version'], { stdio: 'ignore' }).status === 0
const CORE_SO = resolve(import.meta.dirname, '../../contracts/solana/mpl_core.so')
const PORT = 18899

describe.skipIf(!hasValidator)('SolanaTxEngine on solana-test-validator with Metaplex Core', { timeout: 60_000 }, () => {
  let validator: ChildProcess
  let ledger: string
  const rpc = createSolanaRpc(`http://127.0.0.1:${PORT}`)

  beforeAll(async () => {
    ledger = mkdtempSync(join(tmpdir(), 'omni-ledger-'))
    validator = spawn(
      'solana-test-validator',
      [
        '--reset', '--quiet', '--ledger', ledger,
        '--rpc-port', String(PORT), '--faucet-port', '19900', '--gossip-port', '18001', '--dynamic-port-range', '18002-18040',
        '--bpf-program', 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', CORE_SO,
      ],
      { stdio: 'ignore' },
    )
    for (let i = 0; i < 120; i++) {
      if (await rpc.getHealth().send().catch(() => null)) return
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('validator did not start')
  }, 60_000)

  afterAll(() => {
    validator?.kill()
    // The ledger grows fast; never leave it behind.
    if (ledger) rmSync(ledger, { recursive: true, force: true })
  })

  async function fundedWallet() {
    const mock = await createMockSolanaWallet({ rpcUrl: `http://127.0.0.1:${PORT}` })
    await rpc.requestAirdrop(mock.signer.address, lamports(2_000_000_000n)).send()
    await expect.poll(async () => (await rpc.getBalance(mock.signer.address).send()).value, { timeout: 20_000 }).toBeGreaterThan(0n)
    const connector = new SolanaConnector(mock.wallet, SOLANA_CHAINS)
    const { accounts } = await connector.connect({ chainId: 'solana:localnet' })
    return { mock, connector, account: accounts[0]!, address: mock.signer.address }
  }

  const engine = () =>
    new SolanaTxEngine({
      store: new TxStore({ storage: createMemoryStorage() }),
      getRpc: () => rpc,
      programErrors: coreErrorName,
      pollingIntervalMs: 300,
    })

  it('mints a Core asset, finds it by owner, transfers it, and decodes Core errors', async () => {
    const txs = engine()
    const seller = await fundedWallet()
    const buyer = await generateKeyPairSigner()
    const asset = await generateKeyPairSigner()

    const minted = await txs.send({
      label: 'Mint Core asset',
      connector: seller.connector,
      account: seller.account,
      instructions: [
        createAssetInstruction({
          payer: seller.address,
          owner: seller.address,
          asset: asset.address,
          name: 'Omni Solana #1',
          uri: 'data:application/json;base64,eyJuYW1lIjoiT21uaSJ9',
        }),
      ],
      signers: [asset], // the new asset account signs its own creation
    })
    expect(minted).toMatchObject({ status: 'confirmed', commitment: expect.stringMatching(/confirmed|finalized/) })
    expect(minted.fee).toBeTypeOf('string')

    const owned = await fetchAssetsByOwner(rpc, seller.address)
    expect(owned).toEqual([expect.objectContaining({ address: asset.address, name: 'Omni Solana #1', owner: seller.address })])

    const transferred = await txs.send({
      label: 'Transfer',
      connector: seller.connector,
      account: seller.account,
      instructions: [transferAssetInstruction({ payer: seller.address, asset: asset.address, newOwner: buyer.address as Address })],
    })
    expect(transferred.status).toBe('confirmed')
    expect(await fetchAssetsByOwner(rpc, buyer.address)).toHaveLength(1)

    // The seller no longer owns it: Core rejects in simulation, before any wallet prompt.
    const prompts = seller.mock.calls.length
    const again = await txs.send({
      label: 'Transfer again',
      connector: seller.connector,
      account: seller.account,
      instructions: [transferAssetInstruction({ payer: seller.address, asset: asset.address, newOwner: seller.address })],
    })
    expect(again.error).toMatchObject({ kind: 'simulation_reverted', errorName: expect.any(String) })
    expect(again.error?.errorName).not.toMatch(/^Custom\(/) // resolved through mpl-core's error table
    expect(seller.mock.calls.length).toBe(prompts)
  })
})
