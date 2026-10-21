/* OmniMarket service worker. pwa/plugin.ts fills in the build version and file lists below. */
const VERSION = '__VERSION__'
const PRECACHE = __PRECACHE__
/** Every hashed file of this build; anything else in the runtime cache belongs to an old deploy. */
const CURRENT_ASSETS = new Set(__ASSETS__)
const SHELL = `omni-shell-${VERSION}`
const ASSETS = 'omni-assets'

self.addEventListener('install', (event) => {
  // No skipWaiting() here: a new version waits until the page agrees to reload (see register.ts),
  // so it never swaps code under a user who is in the middle of signing.
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(PRECACHE)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('omni-shell-') && key !== SHELL).map((key) => caches.delete(key))))
      .then(() => caches.open(ASSETS))
      .then((cache) =>
        cache.keys().then((requests) =>
          Promise.all(requests.filter((r) => !CURRENT_ASSETS.has(new URL(r.url).pathname)).map((r) => cache.delete(r))),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  // Only our own static files. API calls (session cookies, single-use nonces), RPC endpoints,
  // the WalletConnect relay and every other origin go straight to the network, never to a cache.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    // Network first, so a deploy is visible on the next load; the cached shell only when offline.
    event.respondWith(fetch(request).catch(() => caches.match('/index.html', { cacheName: SHELL })))
    return
  }
  if (url.pathname.startsWith('/assets/')) {
    // Content-hashed file names never change meaning: cache first, forever.
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone()
              void caches.open(ASSETS).then((cache) => cache.put(request, copy))
            }
            return response
          }),
      ),
    )
  }
})
