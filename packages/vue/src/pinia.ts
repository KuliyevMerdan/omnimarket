import type { TxStore } from '@omnimarket/tx-engine'
import type { CaipAccountId, CaipChainId, ConnectOptions, WalletManager } from '@omnimarket/wallet-core'
import { defineStore } from 'pinia'
import { computed } from 'vue'
import { useStore } from './store'
import { accountOf } from './wallet'

/**
 * The wallet as a Pinia store, for apps that keep their state in Pinia (devtools timeline, plugins).
 * It holds no state of its own: the manager stays the single source of truth, the store exposes
 * getters over its snapshots and actions that delegate. Two copies of "the connected account" would
 * eventually disagree.
 *
 *   export const useWalletStore = defineWalletStore(core.manager)
 */
export function defineWalletStore(manager: WalletManager, id = 'omni-wallet') {
  return defineStore(id, () => {
    const state = useStore(manager)
    const account = accountOf(state)
    return {
      snapshot: computed(() => state.value),
      status: computed(() => state.value.status),
      wallets: computed(() => state.value.wallets),
      error: computed(() => state.value.error),
      account,
      isConnected: computed(() => state.value.status === 'connected'),
      connect: (walletId: string, options?: ConnectOptions) => manager.connect(walletId, options),
      disconnect: () => manager.disconnect(),
      switchChain: (chainId: CaipChainId) => manager.switchChain(chainId),
      signMessage: (message: string, signer?: CaipAccountId) => manager.signMessage(message, signer),
    }
  })
}

/** Transactions as a Pinia store; same rule: getters over the shared TxStore, no copy. */
export function defineTxStore(store: TxStore, id = 'omni-transactions') {
  return defineStore(id, () => {
    const state = useStore(store)
    const transactions = computed(() => state.value.txs)
    return {
      transactions,
      inFlight: computed(() => transactions.value.filter((tx) => tx.status === 'pending' || tx.status === 'confirming')),
      remove: (txId: string) => store.remove(txId),
    }
  })
}
