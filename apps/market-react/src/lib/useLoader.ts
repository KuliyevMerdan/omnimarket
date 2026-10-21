import { useCallback, useEffect, useState } from 'react'

export interface Loaded<T> {
  readonly data: T | undefined
  readonly error: unknown
  readonly loading: boolean
  reload(): void
}

/**
 * Minimal async loader: aborts stale requests when deps change, keeps the previous data while
 * reloading (no layout flash on live updates). A data library would replace this in phase 6.
 */
export function useLoader<T>(load: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true })
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setState((s) => ({ ...s, loading: true }))
    load(controller.signal).then(
      (data) => !controller.signal.aborted && setState({ data, loading: false }),
      (error) => !controller.signal.aborted && setState((s) => ({ ...s, error, loading: false })),
    )
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version])

  const reload = useCallback(() => setVersion((v) => v + 1), [])
  return { data: state.data, error: state.error, loading: state.loading, reload }
}
