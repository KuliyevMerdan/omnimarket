/**
 * Performance budget: the JavaScript a first visit downloads before the app can render, gzip. Follows
 * the entry script's static imports (what the browser must fetch); `import()` chunks are not counted.
 * Fails (exit 1) over budget. Run after `vite build`: `pnpm --filter @omnimarket/market-react budget`.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'

const BUDGET_KB = Number(process.env.BUNDLE_BUDGET_KB ?? 225)
const dist = new URL('../dist/', import.meta.url).pathname

const html = readFileSync(join(dist, 'index.html'), 'utf8')
const entries = [...html.matchAll(/<script[^>]+src="\/?([^"]+)"/g)].map((m) => m[1])
const sizes = new Map()
const STATIC_IMPORT = /(?:^|[;\n}])\s*import\s*(?:[^"'()]*?from\s*)?["'](\.\/[^"']+)["']/g

const visit = (file) => {
  if (sizes.has(file)) return
  const code = readFileSync(join(dist, file), 'utf8')
  sizes.set(file, gzipSync(code, { level: 9 }).length)
  for (const [, specifier] of code.matchAll(STATIC_IMPORT)) visit(join(dirname(file), specifier))
}
entries.forEach(visit)

const kb = (bytes) => (bytes / 1024).toFixed(1)
const total = [...sizes.values()].reduce((a, b) => a + b, 0)
for (const [file, size] of [...sizes].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`${kb(size).padStart(7)} kB  ${file}`)
console.log(`${kb(total).padStart(7)} kB  startup JS (gzip), budget ${BUDGET_KB} kB`)
if (total / 1024 > BUDGET_KB) {
  console.error(`Over budget by ${kb(total - BUDGET_KB * 1024)} kB. Move chain- or page-specific code behind import().`)
  process.exit(1)
}
