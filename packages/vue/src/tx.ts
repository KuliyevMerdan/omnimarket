import type { AnyTxRecord, TxStore } from '@omnimarket/tx-engine'
import { computed, type ComputedRef } from 'vue'
import { useOmni } from './plugin'
import { useStore } from './store'

export function useTxStore(): TxStore {
  const store = useOmni().txStore
  if (!store) throw new Error('createOmniVue({ txStore }) is not configured')
  return store
}

/** The shared Activity list: EVM, Solana and Sui records, newest first. */
export function useTransactions(): ComputedRef<readonly AnyTxRecord[]> {
  const state = useStore(useTxStore())
  return computed(() => state.value.txs)
}
