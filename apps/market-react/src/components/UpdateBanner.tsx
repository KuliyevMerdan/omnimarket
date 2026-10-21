import { useTransactions, useWalletConnect } from '@omnimarket/react'
import { useSyncExternalStore } from 'react'
import { applyUpdate, pwaState } from '../pwa'

/**
 * "New version" prompt. Reloading while the wallet shows a prompt would orphan it (the tx would be
 * marked interrupted), and reloading during a WalletConnect pairing would drop the QR code, so the
 * button waits for those to finish.
 */
export function UpdateBanner() {
  const { updateReady } = useSyncExternalStore(pwaState.subscribe, pwaState.getState)
  const busySigning = useTransactions().some((tx) => tx.status === 'preparing' || tx.status === 'awaiting_signature')
  const pairing = useWalletConnect().status === 'pairing'
  if (!updateReady) return null

  const blocked = busySigning || pairing
  return (
    <div className="update-banner" role="status">
      <span>A new version of OmniMarket is available.</span>
      <button className="small-button" disabled={blocked} onClick={applyUpdate}>
        {blocked ? 'After your wallet confirms…' : 'Reload'}
      </button>
    </div>
  )
}
