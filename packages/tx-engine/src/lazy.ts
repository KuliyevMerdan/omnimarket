import type { TxStore } from './store'
import { TRACKED_STATUSES, namespaceOf, type TxNamespace } from './types'

/**
 * An engine whose chain SDK is loaded on demand. Solana and Sui engines pull in @solana/kit and
 * @mysten/sui (gRPC, BCS, …), which an EVM user never needs. Loaded when:
 * - something asks for it (`load()`: a wallet of that ecosystem connects, its page renders), or
 * - while started, the shared history holds pending records of its namespace (resume after reload).
 * Once loaded it behaves exactly like the engine it wraps; `start()` is ref-counted like theirs.
 */
export interface LazyEngine<E extends { start(): () => void }> {
  readonly namespace: TxNamespace
  /** The engine once loaded, else `null`. */
  readonly current: E | null
  /** Same promise on every call. */
  load(): Promise<E>
  start(): () => void
}

export function lazyEngine<E extends { start(): () => void }>(options: {
  readonly namespace: TxNamespace
  readonly store: TxStore
  readonly load: () => Promise<E>
}): LazyEngine<E> {
  let promise: Promise<E> | null = null
  let current: E | null = null
  let starts = 0
  let stopEngine: (() => void) | null = null

  const hasTracked = () => options.store.getState().txs.some((tx) => namespaceOf(tx) === options.namespace && TRACKED_STATUSES.has(tx.status))

  const load = (): Promise<E> => {
    promise ??= options.load().then(
      (engine) => {
        current = engine
        if (starts > 0) stopEngine = engine.start()
        return engine
      },
      (error: unknown) => {
        // A failed chunk load (offline) can be retried.
        promise = null
        throw error
      },
    )
    return promise
  }

  return {
    namespace: options.namespace,
    get current() {
      return current
    },
    load,
    start() {
      if (starts++ === 0) {
        if (current) stopEngine = current.start()
        // Only this engine writes records of its namespace, so pending ones can only come from a previous page load.
        else if (hasTracked()) void load().catch(() => {})
      }
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        if (--starts > 0) return
        stopEngine?.()
        stopEngine = null
      }
    },
  }
}
