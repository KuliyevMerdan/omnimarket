/** Recursively converts bigints to decimal strings so values are JSON- and storage-safe. */
export function toSerializable(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(toSerializable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toSerializable(v)]))
  }
  return value
}

export function stringifyArgs(args: unknown): Record<string, string> {
  if (!args || typeof args !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(args)) {
    const plain = toSerializable(value)
    out[key] = typeof plain === 'string' ? plain : JSON.stringify(plain)
  }
  return out
}
