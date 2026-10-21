import { createMemoryStorage } from '@omnimarket/wallet-core'
import { describe, expect, it, vi } from 'vitest'
import { TxStore, lazyEngine, type SuiTxRecord } from '../src'

function fakeEngine() {
  const stop = vi.fn()
  return { start: vi.fn(() => stop), stop }
}

const pendingSui: SuiTxRecord = {
  id: 'sui-1',
  namespace: 'sui',
  label: 'Buy',
  chain: 'sui:localnet',
  from: '0x1',
  status: 'pending',
  createdAt: 1,
  updatedAt: 1,
  confirmations: 0,
  requiredConfirmations: 1,
  stuck: false,
}

describe('lazyEngine', () => {
  it('does not load the SDK for a user who never touches the chain', () => {
    const load = vi.fn(async () => fakeEngine())
    const lazy = lazyEngine({ namespace: 'sui', store: new TxStore({ storage: createMemoryStorage() }), load })
    const stop = lazy.start()
    stop()
    expect(load).not.toHaveBeenCalled()
    expect(lazy.current).toBeNull()
  })

  it('loads on demand once, and starts the engine while started', async () => {
    const engine = fakeEngine()
    const load = vi.fn(async () => engine)
    const lazy = lazyEngine({ namespace: 'sui', store: new TxStore({ storage: createMemoryStorage() }), load })
    const stop = lazy.start()
    const [a, b] = await Promise.all([lazy.load(), lazy.load()])
    expect(a).toBe(engine)
    expect(b).toBe(engine)
    expect(load).toHaveBeenCalledOnce()
    expect(engine.start).toHaveBeenCalledOnce()
    stop()
    expect(engine.stop).toHaveBeenCalledOnce()
    // Started again later: the loaded engine starts right away.
    lazy.start()
    expect(engine.start).toHaveBeenCalledTimes(2)
  })

  it('loads by itself when the history has pending records of its chain (resume after reload)', async () => {
    const storage = createMemoryStorage()
    new TxStore({ storage }).insert(pendingSui)
    const engine = fakeEngine()
    const lazy = lazyEngine({ namespace: 'sui', store: new TxStore({ storage }), load: async () => engine })
    lazy.start()
    await vi.waitFor(() => expect(engine.start).toHaveBeenCalledOnce())

    const solana = vi.fn(async () => fakeEngine())
    lazyEngine({ namespace: 'solana', store: new TxStore({ storage }), load: solana }).start()
    expect(solana).not.toHaveBeenCalled()
  })

  it('can retry after a failed chunk load', async () => {
    const engine = fakeEngine()
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(engine)
    const lazy = lazyEngine({ namespace: 'solana', store: new TxStore({ storage: createMemoryStorage() }), load })
    await expect(lazy.load()).rejects.toThrow('offline')
    expect(await lazy.load()).toBe(engine)
  })
})
