import { useAccount, useWalletManager, useWalletState } from '@omnimarket/react'
import type { CaipChainId, ChainNamespace } from '@omnimarket/wallet-core'
import { useState } from 'react'
import { describeError } from '../errors'
import { networksFor } from '../networks'
import { WalletIcon } from './WalletIcon'

export function AccountPanel({ onDisconnect }: { onDisconnect: () => void }) {
  const manager = useWalletManager()
  const { address, chainId, walletId, namespace } = useAccount()
  const wallet = useWalletState((s) => s.wallets.find((w) => w.id === walletId))
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const networks = networksFor(namespace as ChainNamespace)
  const supported = networks.some((n) => n.caip === chainId)

  const switchChain = async (next: CaipChainId) => {
    setError(null)
    setSwitching(true)
    try {
      // EVM asks the wallet; Wallet Standard chains are selected app-side (signing calls carry the chain).
      await manager.switchChain(next)
    } catch (e) {
      setError(e)
    } finally {
      setSwitching(false)
    }
  }

  return (
    <section className="card">
      <h2>Wallet</h2>
      <div className="row">
        {wallet && <WalletIcon wallet={wallet} />}
        <div>
          <div>{wallet?.name}</div>
          <code className="small" title={address}>
            {address}
          </code>
        </div>
      </div>

      <label className="field">
        <span className="muted small">Network</span>
        <select value={supported ? chainId : ''} disabled={switching} onChange={(e) => switchChain(e.target.value as CaipChainId)}>
          {!supported && <option value="">Unsupported ({chainId})</option>}
          {networks.map((n) => (
            <option key={n.caip} value={n.caip}>
              {n.name}
            </option>
          ))}
        </select>
      </label>
      {!supported && <p className="warning">Your wallet is on a network this app does not support.</p>}
      {Boolean(error) && <p className="error">{describeError(error)}</p>}

      <button className="secondary" onClick={onDisconnect}>
        Disconnect
      </button>
    </section>
  )
}
