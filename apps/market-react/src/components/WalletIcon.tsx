import type { WalletInfo } from '@omnimarket/wallet-core'
import { useState } from 'react'

/** Icons come from untrusted extensions. `<img>` never executes SVG script; never inline them as HTML. */
export function WalletIcon({ wallet }: { wallet: WalletInfo }) {
  const [broken, setBroken] = useState(false)
  return wallet.icon && !broken ? (
    <img className="wallet-icon" src={wallet.icon} alt="" width={28} height={28} onError={() => setBroken(true)} />
  ) : (
    <span className="wallet-icon wallet-icon-fallback">{wallet.name.slice(0, 1)}</span>
  )
}
