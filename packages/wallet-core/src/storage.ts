export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function createMemoryStorage(): KeyValueStorage {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}

/**
 * `localStorage` that never throws: it is missing during SSR, and throws in some
 * private-browsing modes and sandboxed iframes. Falls back to memory in those cases.
 */
export function createBrowserStorage(): KeyValueStorage {
  const fallback = createMemoryStorage()
  const local = (() => {
    try {
      const storage = globalThis.localStorage
      const probe = '__omni_probe__'
      storage.setItem(probe, probe)
      storage.removeItem(probe)
      return storage
    } catch {
      return null
    }
  })()
  if (!local) return fallback

  return {
    getItem(key) {
      try {
        return local.getItem(key)
      } catch {
        return fallback.getItem(key)
      }
    },
    setItem(key, value) {
      try {
        local.setItem(key, value)
      } catch {
        fallback.setItem(key, value)
      }
    },
    removeItem(key) {
      try {
        local.removeItem(key)
      } catch {
        fallback.removeItem(key)
      }
    },
  }
}
