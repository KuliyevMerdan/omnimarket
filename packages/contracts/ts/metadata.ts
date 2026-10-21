export interface TokenMetadata {
  readonly name: string
  readonly description: string
  /** Safe to put in `<img src>`: a raster/SVG data URI or an https URL. Empty when unusable. */
  readonly image: string
}

const SAFE_DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|svg\+xml)(;base64)?,/i
const MAX_URI_LENGTH = 200_000

/**
 * Parses an ERC-721 `tokenURI` that is attacker-controlled by definition (anyone can deploy a
 * collection). Rules:
 * - only `data:application/json` is decoded locally; http(s)/ipfs metadata must go through a
 *   fetch layer with timeouts (phase 6), so here it yields an empty result;
 * - `image` is allowed only as `data:image/*` or `https:`; `ipfs://` is mapped to a gateway;
 *   `javascript:`, `data:text/html` etc. are dropped;
 * - strings are length-capped; nothing here is ever rendered as HTML (`animation_url` is ignored).
 */
export function parseTokenUri(uri: string, ipfsGateway = 'https://ipfs.io/ipfs/'): TokenMetadata | null {
  if (uri.length > MAX_URI_LENGTH) return null
  const json = decodeJsonDataUri(uri)
  if (!json) return null

  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const { name, description, image } = raw as Record<string, unknown>
  return {
    name: typeof name === 'string' ? name.slice(0, 200) : '',
    description: typeof description === 'string' ? description.slice(0, 2000) : '',
    image: typeof image === 'string' ? sanitizeImageUrl(image, ipfsGateway) : '',
  }
}

export function sanitizeImageUrl(url: string, ipfsGateway = 'https://ipfs.io/ipfs/'): string {
  const trimmed = url.trim()
  if (SAFE_DATA_IMAGE.test(trimmed)) return trimmed
  if (trimmed.startsWith('ipfs://')) return ipfsGateway + encodeURI(trimmed.slice('ipfs://'.length).replace(/^ipfs\//, ''))
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'https:' ? parsed.href : ''
  } catch {
    return ''
  }
}

function decodeJsonDataUri(uri: string): string | null {
  const base64 = /^data:application\/json;base64,([A-Za-z0-9+/=]+)$/.exec(uri)
  if (base64) {
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(base64[1]!), (c) => c.charCodeAt(0)))
    } catch {
      return null
    }
  }
  const plain = /^data:application\/json(;charset=utf-8)?,(.*)$/s.exec(uri)
  if (plain) {
    try {
      return decodeURIComponent(plain[2]!)
    } catch {
      return null
    }
  }
  return null
}
