import { federation } from '@module-federation/vite'
import { FEDERATED_OUTPUT, MARKET_REMOTE, OMNI_SHARED } from '@omnimarket/app-core/federation'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { serviceWorker } from './pwa/plugin.ts'

const REMOTE_PORT = 5181

/**
 * Two builds from one codebase:
 * - default: the standalone PWA (own core, own chrome), served at :5173;
 * - `--mode remote`: the marketplace micro-frontend for the Vue shell (`remoteEntry.js`), at :5181.
 *
 * The remote is served built (`pnpm dev:remote` = build --watch + preview), not from the dev server:
 * React Fast Refresh needs its runtime installed by the host page, and the host is Vue. Day-to-day
 * React work happens in the standalone app with full HMR.
 */
export default defineConfig(({ mode }) => {
  if (mode === 'remote') {
    const origin = process.env.MARKET_REMOTE_ORIGIN ?? `http://localhost:${REMOTE_PORT}`
    return {
      // Absolute: chunks are requested from the host's page, they must not resolve against its origin.
      base: `${origin}/`,
      // Icons and the web manifest belong to the standalone PWA, not to the micro-frontend.
      publicDir: false,
      plugins: [
        react(),
        federation({
          name: MARKET_REMOTE.name,
          filename: 'remoteEntry.js',
          exposes: { [MARKET_REMOTE.expose]: './src/remote.tsx' },
          shared: OMNI_SHARED,
          manifest: true,
          // The host/remote contract is typed in @omnimarket/app-core; no generated type bundles.
          dts: false,
        }),
      ],
      build: { outDir: 'dist-remote', target: 'esnext', rolldownOptions: { output: FEDERATED_OUTPUT } },
      // ES module workers: spawned through a same-origin blob when the page is the shell (lib/metadata.ts).
      worker: { format: 'es' },
      server: { port: REMOTE_PORT, strictPort: true, origin, cors: true },
      preview: { port: REMOTE_PORT, strictPort: true, cors: true },
    }
  }
  return {
    plugins: [react(), serviceWorker()],
    worker: { format: 'es' },
    server: {
      port: 5173,
      // SIWE binds signatures to this exact origin; a silently different port would fail verification.
      strictPort: true,
      proxy: {
        // Same-origin API keeps the session cookie first-party (no third-party cookie issues).
        '/api': { target: 'http://localhost:8787', rewrite: (path) => path.replace(/^\/api/, '') },
      },
    },
  }
})
