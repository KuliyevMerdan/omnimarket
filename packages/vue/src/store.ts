import type { ReadableStore } from '@omnimarket/wallet-core'
import { getCurrentScope, onScopeDispose, shallowRef, type ShallowRef } from 'vue'

/**
 * A core store as a Vue ref. Snapshots are immutable and replaced on every change, so `shallowRef`
 * is exact: no deep proxies over frozen objects, and one reactive trigger per change. Unsubscribes
 * with the calling component / effect scope.
 */
export function useStore<T>(store: ReadableStore<T>): Readonly<ShallowRef<T>> {
  const state = shallowRef(store.getState())
  const unsubscribe = store.subscribe(() => {
    state.value = store.getState()
  })
  if (getCurrentScope()) onScopeDispose(unsubscribe)
  return state
}
