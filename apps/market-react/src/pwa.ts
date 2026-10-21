import { createStore } from '@omnimarket/wallet-core'

/** `updateReady`: a new version is installed and waits for `applyUpdate()`. */
export const pwaState = createStore({ updateReady: false })

let waiting: ServiceWorker | null = null

/**
 * Production only (a service worker would fight Vite's dev server). The new version never takes over
 * by itself: the page decides when to reload, so a wallet prompt or a WalletConnect pairing in progress
 * is not cut off by a deploy.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  window.addEventListener('load', async () => {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => null)
    if (!registration) return

    const track = (worker: ServiceWorker | null) => {
      if (!worker) return
      const check = () => {
        // With no controller this is the first install, not an update.
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          waiting = worker
          pwaState.setState({ updateReady: true })
        }
      }
      worker.addEventListener('statechange', check)
      check()
    }
    track(registration.waiting)
    registration.addEventListener('updatefound', () => track(registration.installing))

    // Installed PWAs can stay open for days: look for a new version whenever the app comes back.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void registration.update().catch(() => {})
    })
  })

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The first install also changes the controller (`clients.claim()`); only an accepted update reloads.
    if (!updating) return
    updating = false
    window.location.reload()
  })
}

let updating = false

export function applyUpdate(): void {
  if (!waiting) return
  updating = true
  waiting.postMessage({ type: 'SKIP_WAITING' })
}
