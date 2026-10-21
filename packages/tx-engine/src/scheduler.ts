const MAX_BACKOFF_MS = 30_000

export interface PollResult {
  /** More records still need tracking on this key (chain). */
  readonly active: boolean
  /** The round had RPC errors: back off before the next one. */
  readonly failed: boolean
}

interface Loop {
  timer?: ReturnType<typeof setTimeout>
  failures: number
  queue: Promise<unknown>
}

/**
 * Per-chain polling loops, shared by every engine:
 * - rounds for one chain are serialized (a manual `now()` waits for an in-flight round);
 * - exponential backoff on RPC failures, capped at 30 s (weak networks);
 * - loops stop by themselves when nothing is left to track;
 * - `wake()` re-polls immediately (tab visible again, network back online).
 */
export class PollScheduler<K extends string | number> {
  readonly #loops = new Map<K, Loop>()
  readonly #round: (key: K) => Promise<PollResult>
  readonly #interval: (key: K) => number

  constructor(round: (key: K) => Promise<PollResult>, interval: (key: K) => number) {
    this.#round = round
    this.#interval = interval
  }

  /** Starts a loop for `key` unless one is already scheduled. */
  ensure(key: K): void {
    const loop = this.#loops.get(key)
    if (loop?.timer !== undefined) return
    if (!loop) this.#loops.set(key, { failures: 0, queue: Promise.resolve() })
    this.#schedule(key, 0)
  }

  /** Runs one round right away, after any in-flight one. */
  async now(key: K, reschedule = false): Promise<void> {
    let loop = this.#loops.get(key)
    if (!loop) {
      loop = { failures: 0, queue: Promise.resolve() }
      this.#loops.set(key, loop)
    }
    const run = loop.queue.then(() => this.#round(key))
    loop.queue = run.catch(() => {})
    const result = await run.catch((): PollResult => ({ active: true, failed: true }))
    loop.failures = result.failed ? loop.failures + 1 : 0
    if (!result.active) {
      if (this.#loops.get(key) === loop) {
        clearTimeout(loop.timer)
        this.#loops.delete(key)
      }
      return
    }
    if (reschedule && this.#loops.get(key) === loop) this.#schedule(key)
  }

  wake(keys: readonly K[]): void {
    for (const key of keys) {
      const loop = this.#loops.get(key)
      if (loop) loop.failures = 0
      this.ensure(key)
      this.#schedule(key, 0)
    }
  }

  stop(): void {
    for (const loop of this.#loops.values()) clearTimeout(loop.timer)
    this.#loops.clear()
  }

  #schedule(key: K, delay?: number): void {
    const loop = this.#loops.get(key)
    if (!loop) return
    clearTimeout(loop.timer)
    const wait = delay ?? Math.min(this.#interval(key) * 2 ** loop.failures, MAX_BACKOFF_MS)
    loop.timer = setTimeout(() => {
      loop.timer = undefined
      void this.now(key, true)
    }, wait)
  }
}

/** Re-poll as soon as the user is back: mobile browsers freeze background tabs. */
export function onWakeUp(callback: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  const onVisible = () => document.visibilityState === 'visible' && callback()
  window.addEventListener('online', callback)
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    window.removeEventListener('online', callback)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
