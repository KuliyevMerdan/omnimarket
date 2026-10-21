const SAFE_ICON = /^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i

/**
 * Wallet icons come from untrusted extensions (EIP-6963 announcements, Wallet Standard registrations).
 * Only raster/SVG data URIs are kept; render them via `<img src>` only, where SVG can't run script.
 */
export function sanitizeWalletIcon(icon: unknown): string {
  return typeof icon === 'string' && SAFE_ICON.test(icon) ? icon : ''
}
