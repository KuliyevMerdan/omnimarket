import type { ChainNamespace } from '../../types'

/**
 * Mobile wallets that accept a WalletConnect pairing URI through a link. A short curated list instead
 * of the WalletConnect explorer API: no third-party request on page load, no remote icons, and every
 * link format here is one we have checked. Any other wallet still works through the QR code or the
 * generic `wc:` link.
 */
export interface MobileWallet {
  readonly id: string
  readonly name: string
  readonly namespaces: readonly ChainNamespace[]
  /** Universal link base; the pairing link is `${universal}/wc?uri=…`. */
  readonly universal: string
}

export const MOBILE_WALLETS: readonly MobileWallet[] = [
  { id: 'metamask', name: 'MetaMask', namespaces: ['eip155'], universal: 'https://metamask.app.link' },
  { id: 'trust', name: 'Trust Wallet', namespaces: ['eip155', 'solana', 'sui'], universal: 'https://link.trustwallet.com' },
  { id: 'rainbow', name: 'Rainbow', namespaces: ['eip155'], universal: 'https://rnbwapp.com' },
]

export function pairingLink(wallet: MobileWallet, uri: string): string {
  return `${wallet.universal}/wc?uri=${encodeURIComponent(uri)}`
}

const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'http:', 'about:'])

/**
 * The peer's `metadata.redirect` comes from the wallet, i.e. from whoever scanned the QR code.
 * It is only ever used as a navigation target, never rendered; still, `javascript:` and friends are
 * dropped, and plain `http:` too (a downgrade to a page anyone on the network can rewrite).
 */
export function safeDeepLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (FORBIDDEN_SCHEMES.has(url.protocol) || !/^[a-z][a-z0-9+.-]*:$/.test(url.protocol)) return null
  return value
}

/** Phones and tablets, including iPadOS which reports itself as a Mac. */
export function isMobileBrowser(nav: Navigator | undefined = globalThis.navigator): boolean {
  if (!nav) return false
  const hint = (nav as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile
  if (typeof hint === 'boolean' && hint) return true
  return /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1)
}

/**
 * Brings the wallet app to the front after a request was sent. A custom scheme (`metamask://`)
 * switches apps without leaving the page; a universal link opens in a new tab so that, if the app is
 * missing, the dApp tab survives.
 */
export function openDeepLink(link: string): void {
  if (typeof window === 'undefined') return
  if (link.startsWith('https:')) window.open(link, '_blank', 'noopener,noreferrer')
  else window.location.href = link
}
