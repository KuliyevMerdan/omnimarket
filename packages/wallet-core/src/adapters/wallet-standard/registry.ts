import type { Wallet } from '@wallet-standard/base'

/** The part of `@wallet-standard/app`'s `getWallets()` we use; injectable for tests and iframes. */
export interface WalletRegistry {
  get(): readonly Wallet[]
  on(event: 'register' | 'unregister', listener: (...wallets: Wallet[]) => void): () => void
}

let browserRegistry: Promise<WalletRegistry> | null = null

/**
 * Lazily loads the shared browser registry. The `wallet-standard:*` window-event protocol lets a
 * wallet register before or after the app starts, so late-injected extensions still show up.
 */
export function getBrowserRegistry(): Promise<WalletRegistry> {
  browserRegistry ??= import('@wallet-standard/app').then(({ getWallets }) => getWallets())
  return browserRegistry
}

/** In-memory registry with the same semantics, for tests and non-browser hosts. */
export function createMemoryRegistry(): WalletRegistry & { register(wallet: Wallet): () => void } {
  const wallets = new Set<Wallet>()
  const listeners = { register: new Set<(...w: Wallet[]) => void>(), unregister: new Set<(...w: Wallet[]) => void>() }
  return {
    get: () => [...wallets],
    on(event, listener) {
      listeners[event].add(listener)
      return () => {
        listeners[event].delete(listener)
      }
    },
    register(wallet) {
      wallets.add(wallet)
      for (const l of listeners.register) l(wallet)
      return () => {
        wallets.delete(wallet)
        for (const l of listeners.unregister) l(wallet)
      }
    },
  }
}
