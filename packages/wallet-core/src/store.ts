export interface ReadableStore<T> {
  getState(): T
  subscribe(listener: () => void): () => void
}

export interface Store<T extends object> extends ReadableStore<T> {
  setState(patch: Partial<T> | ((state: T) => Partial<T>)): void
}

/**
 * Minimal immutable store compatible with React's `useSyncExternalStore` and Vue's `shallowRef`.
 * Every update produces a new frozen snapshot; unchanged updates are dropped so subscribers
 * never re-render for nothing.
 */
export function createStore<T extends object>(initial: T): Store<T> {
  let state = Object.freeze({ ...initial })
  const listeners = new Set<() => void>()

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setState(patch) {
      const partial = typeof patch === 'function' ? patch(state) : patch
      const keys = Object.keys(partial) as (keyof T)[]
      if (keys.every((key) => Object.is(state[key], partial[key]))) return
      state = Object.freeze({ ...state, ...partial })
      for (const listener of [...listeners]) listener()
    },
  }
}
