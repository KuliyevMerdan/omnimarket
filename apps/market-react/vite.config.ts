import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // SIWE binds signatures to this exact origin; a silently different port would fail verification.
    strictPort: true,
    proxy: {
      // Same-origin API keeps the session cookie first-party (no third-party cookie issues).
      '/api': { target: 'http://localhost:8787', rewrite: (path) => path.replace(/^\/api/, '') },
    },
  },
})
