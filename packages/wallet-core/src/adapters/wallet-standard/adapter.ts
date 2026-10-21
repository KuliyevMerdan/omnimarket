import type { Wallet } from '@wallet-standard/base'
import { StandardConnect } from '@wallet-standard/features'
import type { ChainAdapter, WalletConnector } from '../../types'
import { getBrowserRegistry, type WalletRegistry } from './registry'

export interface WalletStandardAdapterOptions<C extends WalletConnector> {
  readonly namespace: 'solana' | 'sui'
  /** Feature sets the dApp can work with; a wallet must have every feature of at least one set. */
  readonly requiredFeatures: readonly (readonly string[])[]
  readonly createConnector: (wallet: Wallet) => C
  readonly registry?: WalletRegistry | Promise<WalletRegistry>
}

/**
 * One discovery mechanism for every Wallet Standard ecosystem: Solana and Sui both register their
 * wallets on the same `wallet-standard` window protocol, so only the filter and the connector differ.
 */
export function createWalletStandardAdapter<C extends WalletConnector>(options: WalletStandardAdapterOptions<C>): ChainAdapter {
  return {
    namespace: options.namespace,
    discover(onChange) {
      const registry = options.registry ?? (typeof window === 'undefined' ? undefined : getBrowserRegistry())
      if (!registry) return () => {}

      const connectors = new WeakMap<Wallet, C>()
      let stopped = false
      const unsubscribes: (() => void)[] = []

      const compatible = (wallet: Wallet) =>
        wallet.chains.some((chain) => chain.startsWith(`${options.namespace}:`)) &&
        StandardConnect in wallet.features &&
        options.requiredFeatures.some((set) => set.every((feature) => feature in wallet.features))

      void Promise.resolve(registry).then((reg) => {
        if (stopped) return
        const emit = () => {
          const list = reg
            .get()
            .filter(compatible)
            .map((wallet) => {
              let connector = connectors.get(wallet)
              if (!connector) {
                connector = options.createConnector(wallet)
                connectors.set(wallet, connector)
              }
              return connector
            })
          onChange(list)
        }
        unsubscribes.push(reg.on('register', emit), reg.on('unregister', emit))
        emit()
      })

      return () => {
        stopped = true
        for (const unsubscribe of unsubscribes.splice(0)) unsubscribe()
      }
    },
  }
}
