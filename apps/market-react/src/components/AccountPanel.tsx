import { useAccount, useWalletConnect, useWalletManager, useWalletState } from '@omnimarket/react'
import type { CaipChainId, ChainNamespace } from '@omnimarket/wallet-core'
import { walletConnectId } from '@omnimarket/wallet-core/walletconnect'
import { useState } from 'react'
import { describeError } from '../errors'
import { DEFAULT_CHAINS, networksFor } from '@omnimarket/app-core'
import { WalletIcon } from './WalletIcon'

const ECOSYSTEMS: Record<ChainNamespace, string> = { eip155: 'EVM', solana: 'Solana', sui: 'Sui' }

export function AccountPanel({ onDisconnect }: { onDisconnect: () => void }) {
  const manager = useWalletManager()
  const { address, chainId, walletId, namespace } = useAccount()
  const wallet = useWalletState((s) => s.wallets.find((w) => w.id === walletId))
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const networks = networksFor(namespace as ChainNamespace)
  const supported = networks.some((n) => n.caip === chainId)
  const wc = useWalletConnect()
  const viaWalletConnect = wallet?.source === 'walletconnect'
  const otherEcosystems = viaWalletConnect
    ? (Object.keys(wc.namespaces) as ChainNamespace[]).filter((ns) => ns !== namespace)
    : []

  /** Another namespace of the same WalletConnect session: no QR code, no wallet prompt. */
  const switchEcosystem = async (next: ChainNamespace) => {
    setError(null)
    try {
      await manager.connect(walletConnectId(next), { chainId: DEFAULT_CHAINS[next] })
    } catch (e) {
      setError(e)
    }
  }

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
          <div>{viaWalletConnect && wc.peer ? `${wc.peer.name} · WalletConnect` : wallet?.name}</div>
          <omni-address value={address} chars={6} />
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

      {viaWalletConnect && (
        <div className="wc-session">
          {otherEcosystems.length > 0 && (
            <div className="row">
              <span className="muted small">Same session:</span>
              {otherEcosystems.map((ns) => (
                <button key={ns} className="secondary small-button" onClick={() => switchEcosystem(ns)}>
                  Use {ECOSYSTEMS[ns]}
                </button>
              ))}
            </div>
          )}
          {wc.expiresAt && (
            <p className="muted small">Session valid until {new Date(wc.expiresAt).toLocaleString()}</p>
          )}
        </div>
      )}
      {Boolean(error) && <p className="error">{describeError(error)}</p>}

      <button className="secondary" onClick={onDisconnect}>
        Disconnect
      </button>
    </section>
  )
}
