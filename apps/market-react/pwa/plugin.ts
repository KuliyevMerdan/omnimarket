import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'

/**
 * Emits `sw.js` at build time, with a version derived from the bundle and a precache list of the
 * app shell: `index.html`, the entry chunk, its static imports and CSS. Lazily loaded chain modules
 * (Solana, Sui) are cached the first time they are used, so installing the app costs little data.
 * About 60 lines instead of a Workbox dependency, and every caching rule is visible in one file.
 */
export function serviceWorker(): Plugin {
  return {
    name: 'omni-service-worker',
    apply: 'build',
    generateBundle(_, bundle) {
      const shell = new Set<string>(['/index.html', '/manifest.webmanifest', '/icon-192.png'])
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk' || !file.isEntry) continue
        for (const name of [file.fileName, ...file.imports, ...(file.viteMetadata?.importedCss ?? [])]) shell.add(`/${name}`)
      }
      const version = createHash('sha256').update(Object.keys(bundle).sort().join('\n')).digest('hex').slice(0, 12)
      const source = readFileSync(new URL('./sw.template.js', import.meta.url), 'utf8')
        .replace("'__VERSION__'", () => JSON.stringify(version))
        .replace('__PRECACHE__', () => JSON.stringify([...shell], null, 2))
        .replace('__ASSETS__', () => JSON.stringify(Object.keys(bundle).filter((name) => name.startsWith('assets/')).map((name) => `/${name}`)))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}
