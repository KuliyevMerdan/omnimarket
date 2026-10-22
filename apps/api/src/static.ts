import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'

/**
 * One origin for everything (the Render deployment): the API under `/api`, the standalone PWA at `/`,
 * the Vue shell at `/shell/` and the React remote it hosts at `/remote/`. Same origin means the SIWE
 * origin, the session cookie and the metadata worker need no CORS, proxy or per-app configuration.
 *
 * `dir` holds the merged builds (scripts/build-render.sh).
 */
export function withStaticApps(api: Hono, dir: string): Hono {
  const root = new Hono()
  root.route('/api', api)

  root.use('*', secureHeaders({ crossOriginOpenerPolicy: 'same-origin-allow-popups' }))
  root.use('*', async (c, next) => {
    await next()
    if (c.req.path.startsWith('/api/')) return
    // Content-hashed files never change; everything else (HTML, sw.js, manifests) revalidates.
    const hashed = /\/assets\//.test(c.req.path) && c.res.status === 200
    c.header('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache')
  })

  root.use('*', serveStatic({ root: dir }))
  // Client-side routes fall back to their app's index.html; files that don't exist stay 404.
  const spa = (index: string) => serveStatic({ root: dir, path: index })
  root.get('/shell/*', async (c, next) => (hasExtension(c.req.path) ? next() : spa('shell/index.html')(c, next)))
  root.get('*', async (c, next) => (hasExtension(c.req.path) || c.req.path.startsWith('/api/') ? next() : spa('index.html')(c, next)))
  return root
}

function hasExtension(path: string): boolean {
  return /\.[a-z0-9]+$/i.test(path)
}
