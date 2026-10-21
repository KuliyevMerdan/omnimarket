import { createStore, type ReadableStore } from '@omnimarket/wallet-core'
import type { RiskReport } from './types'

export interface PendingReview {
  readonly id: number
  readonly report: RiskReport
}

export interface ReviewGateState {
  /** The review on screen; others wait behind it (a wallet shows one prompt at a time, too). */
  readonly current: PendingReview | null
  readonly queued: number
}

/**
 * Connects the provider middleware to whichever UI shows the review. Framework-free: the Vue shell or
 * the standalone React app renders `current` and calls `resolve`. With no UI attached a review can't
 * be shown, so it is rejected (fail closed) instead of waiting forever or passing.
 */
export interface ReviewGate extends ReadableStore<ReviewGateState> {
  /** Use as `GuardOptions.review`. */
  review(report: RiskReport): Promise<boolean>
  resolve(id: number, accepted: boolean): void
  /** A UI that renders reviews registers itself; the returned function unregisters it. */
  attach(): () => void
}

export function createReviewGate(): ReviewGate {
  const store = createStore<ReviewGateState>({ current: null, queued: 0 })
  const waiting: { review: PendingReview; settle: (accepted: boolean) => void }[] = []
  let presenters = 0
  let nextId = 1

  const sync = () => store.setState({ current: waiting[0]?.review ?? null, queued: Math.max(0, waiting.length - 1) })

  const settle = (index: number, accepted: boolean) => {
    const [entry] = waiting.splice(index, 1)
    entry?.settle(accepted)
    sync()
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    review(report) {
      if (presenters === 0) return Promise.resolve(false)
      return new Promise<boolean>((resolve) => {
        waiting.push({ review: { id: nextId++, report }, settle: resolve })
        sync()
      })
    },
    resolve(id, accepted) {
      const index = waiting.findIndex((entry) => entry.review.id === id)
      if (index !== -1) settle(index, accepted)
    },
    attach() {
      presenters++
      let attached = true
      return () => {
        if (!attached) return
        attached = false
        // The last UI went away (unmount, navigation): nobody can answer the open reviews.
        if (--presenters === 0) while (waiting.length) settle(0, false)
      }
    },
  }
}
