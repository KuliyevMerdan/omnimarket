import { OmniAddress } from './components/address'
import { OmniButton } from './components/button'
import { OmniNetworkBadge } from './components/network-badge'
import { OmniQr } from './components/qr'
import { OmniTxStatus } from './components/tx-status'
import { OmniWalletOption } from './components/wallet-option'
import { defineOnce } from './define'

export { OmniAddress, shortenAddress } from './components/address'
export { OmniButton } from './components/button'
export { OmniNetworkBadge } from './components/network-badge'
export { OmniQr } from './components/qr'
export { OmniTxStatus, TX_STATUS } from './components/tx-status'
export { OmniWalletOption } from './components/wallet-option'
export { defineOnce } from './define'

/** Importing the package registers every element (idempotent across bundles). */
defineOnce('omni-button', OmniButton)
defineOnce('omni-address', OmniAddress)
defineOnce('omni-tx-status', OmniTxStatus)
defineOnce('omni-network-badge', OmniNetworkBadge)
defineOnce('omni-wallet-option', OmniWalletOption)
defineOnce('omni-qr', OmniQr)

declare global {
  interface HTMLElementTagNameMap {
    'omni-button': OmniButton
    'omni-address': OmniAddress
    'omni-tx-status': OmniTxStatus
    'omni-network-badge': OmniNetworkBadge
    'omni-wallet-option': OmniWalletOption
    'omni-qr': OmniQr
  }
}
