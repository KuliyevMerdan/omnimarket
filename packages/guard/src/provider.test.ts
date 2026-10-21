import { WalletError, toAccountId } from '@omnimarket/wallet-core'
import { Eip1193Connector } from '@omnimarket/wallet-core/evm'
import { createMockProvider } from '@omnimarket/wallet-core/testing'
import { maxUint256, verifyMessage, type EIP1193Provider } from 'viem'
import { mainnet } from 'viem/chains'
import { describe, expect, it, vi } from 'vitest'
import { createReviewGate, guardProvider, type RiskReport } from '.'

const SIWE_FOR = (domain: string, address: string) =>
  `${domain} wants you to sign in with your Ethereum account:\n${address}\n\nURI: https://${domain}\nVersion: 1\nChain ID: 1\nNonce: abcdefgh12\nIssued At: 2026-10-22T00:00:00Z`

function setup(review: (report: RiskReport) => Promise<boolean>) {
  const mock = createMockProvider({ chainId: 1, authorized: true })
  const reports: RiskReport[] = []
  const provider = guardProvider(mock.provider, { review, domain: 'omnimarket.app', onReport: (r) => reports.push(r) })
  const connector = new Eip1193Connector({
    provider,
    chains: [mainnet],
    info: { id: 'eip155:mock', name: 'Mock', icon: '', namespace: 'eip155', source: 'eip6963' },
  })
  return { mock, provider, connector, reports, account: toAccountId('eip155:1', mock.account.address) }
}

const prompts = (mock: ReturnType<typeof createMockProvider>) => mock.calls.filter((c) => c.method !== 'eth_chainId' && c.method !== 'eth_accounts')

describe('guardProvider', () => {
  it('forwards described requests without a review', async () => {
    const review = vi.fn(async (_report: RiskReport) => true)
    const { connector, account, mock } = setup(review)
    await connector.connect({ silent: true })
    const signature = await connector.signMessage({ account, message: SIWE_FOR('omnimarket.app', mock.account.address) })
    expect(review).not.toHaveBeenCalled()
    expect(await verifyMessage({ address: mock.account.address, message: SIWE_FOR('omnimarket.app', mock.account.address), signature })).toBe(true)
  })

  it('asks before a dangerous request and never reaches the wallet when rejected', async () => {
    const review = vi.fn(async (_report: RiskReport) => false)
    const { connector, account, mock, reports } = setup(review)
    await connector.connect({ silent: true })
    const error = await connector.signMessage({ account, message: SIWE_FOR('evil.example', mock.account.address) }).catch((e) => e)

    expect(review).toHaveBeenCalledOnce()
    expect(reports[0]!.level).toBe('danger')
    // Thrown by the middleware, wrapped by viem, unwrapped by the connector: still the same code.
    expect(error).toBeInstanceOf(WalletError)
    expect((error as WalletError).code).toBe('USER_REJECTED')
    expect(prompts(mock).some((c) => c.method === 'personal_sign')).toBe(false)
  })

  it('forwards a dangerous request the user accepted', async () => {
    const { connector, account, mock } = setup(async () => true)
    await connector.connect({ silent: true })
    await connector.signMessage({ account, message: SIWE_FOR('evil.example', mock.account.address) })
    expect(prompts(mock).some((c) => c.method === 'personal_sign')).toBe(true)
  })

  it('blocks eth_sign and cross-chain typed data without asking', async () => {
    const review = vi.fn(async (_report: RiskReport) => true)
    const { provider, mock } = setup(review)
    const blocked = await provider.request({ method: 'eth_sign', params: [mock.account.address, `0x${'11'.repeat(32)}`] }).catch((e) => e)
    expect((blocked as WalletError).code).toBe('BLOCKED')

    const typed = JSON.stringify({
      domain: { chainId: 137, verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3' },
      types: { EIP712Domain: [], Order: [] },
      primaryType: 'Order',
      message: {},
    })
    const crossChain = await provider.request({ method: 'eth_signTypedData_v4', params: [mock.account.address, typed] }).catch((e) => e)
    expect((crossChain as WalletError).code).toBe('BLOCKED')
    expect((crossChain as WalletError).message).toContain('chain 137')

    expect(review).not.toHaveBeenCalled()
    expect(prompts(mock)).toEqual([])
  })

  it('fails closed into a review when the request cannot be inspected', async () => {
    const review = vi.fn(async (_report: RiskReport) => false)
    // A wallet answering garbage for the chain id: the report can't be built.
    const broken = { request: async ({ method }: { method: string }) => (method === 'eth_chainId' ? 'nope' : []), on() {}, removeListener() {} }
    const provider = guardProvider(broken as unknown as EIP1193Provider, { review })
    const error = await provider.request({ method: 'eth_sendTransaction', params: [{ from: '0x0000000000000000000000000000000000000001' }] } as never).catch((e) => e)
    expect(review.mock.calls[0]![0]).toMatchObject({ level: 'warning', findings: [{ code: 'INSPECTION_FAILED' }] })
    expect((error as WalletError).code).toBe('USER_REJECTED')
  })

  it('blocks malformed typed data', async () => {
    const { provider, mock } = setup(async () => true)
    const error = await provider.request({ method: 'eth_signTypedData_v4', params: [mock.account.address, '{not json'] }).catch((e) => e)
    expect((error as WalletError).code).toBe('BLOCKED')
  })

  it('passes everything else and the provider’s own properties through', async () => {
    const raw = Object.assign(createMockProvider({ chainId: 1 }).provider, { isMetaMask: true })
    const guarded = guardProvider(raw, { review: async () => true })
    expect((guarded as unknown as { isMetaMask: boolean }).isMetaMask).toBe(true)
    expect(await guarded.request({ method: 'eth_chainId' })).toBe('0x1')
    const listener = () => {}
    guarded.on('accountsChanged', listener)
    guarded.removeListener('accountsChanged', listener)
  })

  it('reviews an unlimited approval inside wallet_sendCalls', async () => {
    const review = vi.fn(async (_report: RiskReport) => false)
    const { provider, mock } = setup(review)
    const approve = `0x095ea7b3${'000000000000000000000000000000000000000000000000000000000000dead'}${maxUint256.toString(16)}` as const
    await provider
      .request({ method: 'wallet_sendCalls', params: [{ from: mock.account.address, chainId: '0x1', calls: [{ to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', data: approve }] }] } as never)
      .catch(() => {})
    expect(review.mock.calls[0]![0]).toMatchObject({ method: 'wallet_sendCalls', intent: { kind: 'batch' } })
    expect(review.mock.calls[0]![0].findings.map((f) => f.code)).toContain('UNLIMITED_ALLOWANCE')
  })
})

describe('createReviewGate', () => {
  const report = { level: 'warning', summary: 'x' } as RiskReport

  it('rejects when no UI is attached to show the review', async () => {
    expect(await createReviewGate().review(report)).toBe(false)
  })

  it('shows one review at a time, in order', async () => {
    const gate = createReviewGate()
    gate.attach()
    const first = gate.review(report)
    const second = gate.review({ ...report, summary: 'y' })
    expect(gate.getState()).toMatchObject({ current: { report: { summary: 'x' } }, queued: 1 })

    gate.resolve(gate.getState().current!.id, true)
    expect(await first).toBe(true)
    expect(gate.getState()).toMatchObject({ current: { report: { summary: 'y' } }, queued: 0 })
    gate.resolve(gate.getState().current!.id, false)
    expect(await second).toBe(false)
    expect(gate.getState().current).toBeNull()
  })

  it('rejects open reviews when the last UI detaches', async () => {
    const gate = createReviewGate()
    const detachA = gate.attach()
    const detachB = gate.attach()
    const pending = gate.review(report)
    detachA()
    expect(gate.getState().current).not.toBeNull()
    detachB()
    detachB()
    expect(await pending).toBe(false)
    expect(gate.getState().current).toBeNull()
  })
})
