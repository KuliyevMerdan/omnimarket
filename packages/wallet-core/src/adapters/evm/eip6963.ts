import type { EIP1193Provider } from 'viem'
import { sanitizeWalletIcon } from '../../icons'

export interface Eip6963ProviderInfo {
  readonly uuid: string
  readonly name: string
  readonly icon: string
  readonly rdns: string
}

export interface Eip6963ProviderDetail {
  readonly info: Eip6963ProviderInfo
  readonly provider: EIP1193Provider
}

const ANNOUNCE = 'eip6963:announceProvider'
const REQUEST = 'eip6963:requestProvider'

/**
 * EIP-6963 multi-injected-provider discovery. Unlike `window.ethereum`, wallets don't
 * overwrite each other, so the user picks explicitly instead of whoever injected last.
 *
 * Announcements are untrusted input from any extension: they are shape-checked, icons are
 * restricted to raster/SVG data URIs (an SVG in `<img>` cannot run script), and the first
 * provider announced for an rdns wins.
 */
export function watchEip6963Providers(
  target: EventTarget,
  onChange: (providers: readonly Eip6963ProviderDetail[]) => void,
): () => void {
  const byRdns = new Map<string, Eip6963ProviderDetail>()

  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail
    if (!isProviderDetail(detail)) return
    const key = detail.info.rdns || detail.info.uuid
    if (byRdns.has(key)) return
    byRdns.set(
      key,
      Object.freeze({
        provider: detail.provider,
        info: Object.freeze({
          uuid: detail.info.uuid,
          name: detail.info.name.slice(0, 64),
          rdns: detail.info.rdns,
          icon: sanitizeWalletIcon(detail.info.icon),
        }),
      }),
    )
    onChange([...byRdns.values()])
  }

  target.addEventListener(ANNOUNCE, onAnnounce)
  target.dispatchEvent(new Event(REQUEST))
  return () => target.removeEventListener(ANNOUNCE, onAnnounce)
}

export function isEip1193Provider(value: unknown): value is EIP1193Provider {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { request?: unknown }).request === 'function' &&
    typeof (value as { on?: unknown }).on === 'function'
  )
}

function isProviderDetail(value: unknown): value is Eip6963ProviderDetail {
  if (!value || typeof value !== 'object') return false
  const { info, provider } = value as { info?: Record<string, unknown>; provider?: unknown }
  return (
    !!info &&
    typeof info.uuid === 'string' &&
    typeof info.name === 'string' &&
    typeof info.rdns === 'string' &&
    typeof info.icon === 'string' &&
    isEip1193Provider(provider)
  )
}
