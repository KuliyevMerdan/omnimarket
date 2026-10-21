import { defineConfig } from 'vitest/config'

// One Vitest process for the whole monorepo: shared cache, single report, parallel workers.
export default defineConfig({
  test: { projects: ['packages/*', 'apps/*'] },
})
