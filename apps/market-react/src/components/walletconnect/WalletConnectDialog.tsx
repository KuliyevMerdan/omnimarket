import { useWalletConnect, useWalletConnectSession } from '@omnimarket/react'
import { MOBILE_WALLETS, isMobileBrowser, pairingLink } from '@omnimarket/wallet-core/walletconnect'
import { Suspense, lazy, useEffect, useRef, useState } from 'react'

// The QR encoder is only needed once someone actually connects through WalletConnect.
const QrCode = lazy(() => import('./QrCode').then((m) => ({ default: m.QrCode })))

/**
 * Shown while a WalletConnect proposal waits for a wallet. Desktop: a QR code for the phone.
 * Mobile: links that open the wallet app with the pairing URI (the QR stays available for a second
 * device). A native `<dialog>` gives focus trapping, Escape and inert background for free.
 */
export function WalletConnectDialog() {
  const session = useWalletConnectSession()
  const { status, uri } = useWalletConnect()
  const dialog = useRef<HTMLDialogElement>(null)
  const [copied, setCopied] = useState(false)
  const [mobile] = useState(() => isMobileBrowser())
  const open = status === 'pairing'

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])

  useEffect(() => setCopied(false), [uri])

  const copy = async () => {
    if (!uri) return
    await navigator.clipboard.writeText(uri).catch(() => {})
    setCopied(true)
  }

  return (
    // `onClose` fires for Escape too: closing the dialog cancels the proposal.
    <dialog ref={dialog} className="wc-dialog" aria-labelledby="wc-title" onClose={() => open && session?.cancelPairing()}>
      <h2 id="wc-title">{mobile ? 'Open your wallet' : 'Scan with your phone'}</h2>
      {!uri ? (
        <p className="muted">Contacting the WalletConnect relay…</p>
      ) : (
        <>
          {mobile && (
            <ul className="wallet-list">
              {MOBILE_WALLETS.map((wallet) => (
                <li key={wallet.id}>
                  {/* New tab: if the app isn't installed, the store page must not replace this one. */}
                  <a className="wallet" href={pairingLink(wallet, uri)} target="_blank" rel="noopener noreferrer">
                    <span>{wallet.name}</span>
                  </a>
                </li>
              ))}
              <li>
                <a className="wallet" href={uri}>
                  <span>Other wallet</span>
                  <span className="muted small">wc: link</span>
                </a>
              </li>
            </ul>
          )}
          <details open={!mobile}>
            <summary className="muted small">{mobile ? 'Show QR code for another device' : 'QR code'}</summary>
            <Suspense fallback={<div className="qr" />}>
              <QrCode value={uri} label="WalletConnect pairing QR code" />
            </Suspense>
          </details>
          <p className="muted small">
            One approval connects every chain your wallet supports here: Ethereum, Solana and Sui.
          </p>
          <div className="row">
            <button className="secondary" onClick={copy}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
        </>
      )}
      <form method="dialog">
        <button className="secondary">Cancel</button>
      </form>
    </dialog>
  )
}
