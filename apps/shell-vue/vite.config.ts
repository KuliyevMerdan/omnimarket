import { federation } from '@module-federation/vite'
import { MARKET_REMOTE, OMNI_SHARED } from '@omnimarket/app-core/federation'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * The Vue shell: owns the core and the chrome (connect, account, sign-in, activity) and hosts the
 * React marketplace as a Module Federation remote (`market/market`).
 */
export default defineConfig({
  plugins: [
    // `<omni-*>` are web components from @omnimarket/ui, not Vue components.
    vue({ template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith('omni-') } } }),
    federation({
      name: 'shell',
      remotes: {
        [MARKET_REMOTE.name]: {
          type: 'module',
          name: MARKET_REMOTE.name,
          entry: process.env.VITE_MARKET_REMOTE_URL ?? MARKET_REMOTE.defaultEntry,
        },
      },
      shared: OMNI_SHARED,
      dts: false,
    }),
  ],
  build: { target: 'esnext' },
  server: {
    port: 5180,
    // SIWE binds signatures to this exact origin.
    strictPort: true,
    proxy: {
      '/api': { target: process.env.OMNI_API_URL ?? 'http://localhost:8787', rewrite: (path) => path.replace(/^\/api/, '') },
    },
  },
  preview: { port: 5180, strictPort: true },
})
