import { mainnet, sepolia } from 'viem/chains'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEvmAdapter } from './adapters/evm'
import { WalletManager } from './manager'
import { createMemoryStorage, type KeyValueStorage } from './storage'
import { announceProvider, createMockProvider, type MockProviderOptions } from './testing'

afterEach(() => vi.useRealTimers())

const METAMASK = 'eip155:io.metamask'

function setup({ storage = createMemoryStorage(), ...options }: MockProviderOptions & { storage?: KeyValueStorage } = {}) {
  const target = new EventTarget()
  const mock = createMockProvider(options)
  const manager = new WalletManager({
    adapters: [createEvmAdapter({ chains: [mainnet, sepolia], target })],
    storage,
    reconnectTimeoutMs: 1000,
  })
  return { target, mock, manager, storage, announce: () => announceProvider(target, mock.provider, { rdns: 'io.metamask' }) }
}

describe('WalletManager', () => {
  it('lists discovered wallets', () => {
    const { manager, announce } = setup()
    manager.start()
    announce()
    expect(manager.getState().wallets.map((w) => w.id)).toEqual([METAMASK])
  })

  it('connects, persists and reacts to wallet events', async () => {
    const { manager, mock, storage, announce } = setup()
    manager.start()
    announce()
    await manager.connect(METAMASK)

    expect(manager.getState()).toMatchObject({ status: 'connected', activeWalletId: METAMASK })
    expect(storage.getItem('omni:last-wallet')).toBe(METAMASK)

    const next = mock.switchAccount()
    expect(manager.getState().connection?.accounts[0]).toBe(`eip155:1:${next.address}`)

    mock.lock()
    expect(manager.getState()).toMatchObject({ status: 'disconnected', connection: null })
    expect(storage.getItem('omni:last-wallet')).toBeNull()
  })

  it('surfaces rejection and returns to disconnected', async () => {
    const { manager, mock, announce } = setup()
    manager.start()
    announce()
    mock.rejectNextRequest()
    await expect(manager.connect(METAMASK)).rejects.toMatchObject({ code: 'USER_REJECTED' })
    expect(manager.getState()).toMatchObject({ status: 'disconnected', error: { code: 'USER_REJECTED' } })
  })

  it('silently reconnects to the last wallet once it is discovered', async () => {
    const storage = createMemoryStorage()
    storage.setItem('omni:last-wallet', METAMASK)
    const { manager, announce } = setup({ storage, authorized: true })
    manager.start()
    expect(manager.getState().status).toBe('reconnecting')

    announce()
    await vi.waitFor(() => expect(manager.getState().status).toBe('connected'))
  })

  it('gives up reconnecting when the wallet never shows up', () => {
    vi.useFakeTimers()
    const storage = createMemoryStorage()
    storage.setItem('omni:last-wallet', METAMASK)
    const { manager } = setup({ storage })
    manager.start()
    vi.advanceTimersByTime(1000)
    expect(manager.getState().status).toBe('disconnected')
  })

  it('forgets the wallet when silent reconnect is not authorized anymore', async () => {
    const storage = createMemoryStorage()
    storage.setItem('omni:last-wallet', METAMASK)
    const { manager, announce } = setup({ storage, authorized: false })
    manager.start()
    announce()
    await vi.waitFor(() => expect(manager.getState().status).toBe('disconnected'))
    expect(manager.getState().error).toBeNull()
    expect(storage.getItem('omni:last-wallet')).toBeNull()
  })

  it('ignores a connect that resolves after disconnect was called', async () => {
    const { manager, announce } = setup()
    manager.start()
    announce()
    const pending = manager.connect(METAMASK)
    await manager.disconnect()
    await pending
    expect(manager.getState().status).toBe('disconnected')
  })

  it('survives a StrictMode stop/start cycle while reconnecting', async () => {
    const storage = createMemoryStorage()
    storage.setItem('omni:last-wallet', METAMASK)
    const { manager, announce } = setup({ storage, authorized: true })
    manager.start()()
    manager.start()
    announce()
    await vi.waitFor(() => expect(manager.getState().status).toBe('connected'))
  })

  it('signs only with connected accounts', async () => {
    const { manager, announce } = setup()
    manager.start()
    await expect(manager.signMessage('x')).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
    announce()
    await manager.connect(METAMASK)
    await expect(manager.signMessage('x', 'eip155:1:0x000000000000000000000000000000000000dEaD')).rejects.toMatchObject({
      code: 'ACCOUNT_MISMATCH',
    })
    await expect(manager.signMessage('x')).resolves.toMatch(/^0x[0-9a-f]{130}$/)
  })

  it('switches chains through the active connector', async () => {
    const { manager, announce } = setup({ knownChainIds: [11155111] })
    manager.start()
    announce()
    await manager.connect(METAMASK)
    await manager.switchChain('eip155:11155111')
    expect(manager.getState().connection?.chainId).toBe('eip155:11155111')
  })
})
