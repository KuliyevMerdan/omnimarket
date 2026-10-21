import { useAccount, useWalletConnect, useWalletConnectSession, useWalletError, useWalletManager, useWallets } from '@omnimarket/react'
import { useState } from 'react'
import type { ChainNamespace, WalletInfo } from '@omnimarket/wallet-core'
import { WALLETCONNECT_ICON, walletConnectId } from '@omnimarket/wallet-core/walletconnect'
import { DEFAULT_CHAINS } from '../networks'
import { describeError } from '../errors'
import { WalletIcon } from './WalletIcon'

export function ConnectPanel() {
  const manager = useWalletManager()
  const wallets = useWallets()
  const error = useWalletError()
  const { status } = useAccount()
  const walletConnect = useWalletConnectSession()
  const { status: wcStatus, error: wcError } = useWalletConnect()
  const [pendingId, setPendingId] = useState<string | null>(null)

  const connect = async (wallet: WalletInfo) => {
    setPendingId(wallet.id)
    // Errors land in manager state (`useWalletError`); nothing else to do here.
    await manager.connect(wallet.id, { chainId: DEFAULT_CHAINS[wallet.namespace] }).catch(() => {})
    setPendingId(null)
  }

  /**
   * One QR scan for all ecosystems: pair first, then connect the first namespace the wallet approved.
   * The others stay one click away in the account panel, without another scan.
   */
  const connectWalletConnect = async () => {
    if (!walletConnect) return
    setPendingId('walletconnect')
    try {
      const approved = await walletConnect.pair()
      const namespace = PREFERENCE.find((ns) => approved[ns])
      if (namespace) await manager.connect(walletConnectId(namespace), { chainId: DEFAULT_CHAINS[namespace] })
    } catch {
      // Pairing errors are in `useWalletConnect().error`, connect errors in `useWalletError()`.
    } finally {
      setPendingId(null)
    }
  }

  // WalletConnect connectors are reached through the single button below, not listed per namespace.
  const browserWallets = wallets.filter((w) => w.source !== 'walletconnect')
  const groups = GROUPS.map((g) => ({ ...g, wallets: browserWallets.filter((w) => w.namespace === g.namespace) })).filter(
    (g) => g.wallets.length > 0,
  )
  const busy = status === 'connecting' || wcStatus === 'pairing'

  return (
    <section className="card card-wide">
      <h2>Connect a wallet</h2>
      {status === 'reconnecting' && <p className="muted">Restoring your previous session…</p>}

      {walletConnect && (
        <div className="wallet-group">
          <h3 className="muted small">Mobile wallet · WalletConnect v2</h3>
          <ul className="wallet-list">
            <li>
              <button className="wallet" disabled={busy} onClick={connectWalletConnect}>
                <img className="wallet-icon" src={WALLETCONNECT_ICON} alt="" width={28} height={28} />
                <span>WalletConnect</span>
                <span className="muted small">{pendingId === 'walletconnect' ? 'Waiting for your wallet…' : 'EVM · Solana · Sui'}</span>
              </button>
            </li>
          </ul>
        </div>
      )}

      {groups.length === 0 ? (
        <p className="muted">
          No browser wallets detected. Install an EIP-6963 wallet (MetaMask, Rabby) or a Wallet Standard wallet for Solana
          (Phantom, Solflare) or Sui (Slush, Suiet){walletConnect ? ', or use a mobile wallet through WalletConnect.' : '.'}
        </p>
      ) : (
        groups.map((group) => (
          <div key={group.namespace} className="wallet-group">
            <h3 className="muted small">{group.title}</h3>
            <ul className="wallet-list">
              {group.wallets.map((wallet) => (
                <li key={wallet.id}>
                  <button className="wallet" disabled={busy} onClick={() => connect(wallet)}>
                    <WalletIcon wallet={wallet} />
                    <span>{wallet.name}</span>
                    <span className="muted small">{pendingId === wallet.id ? 'Check your wallet…' : wallet.source}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}

      {(error ?? wcError) && <p className="error">{describeError(error ?? wcError)}</p>}
    </section>
  )
}

const GROUPS: { namespace: ChainNamespace; title: string }[] = [
  { namespace: 'eip155', title: 'Ethereum & EVM · EIP-6963' },
  { namespace: 'solana', title: 'Solana · Wallet Standard' },
  { namespace: 'sui', title: 'Sui · Wallet Standard' },
]

const PREFERENCE: readonly ChainNamespace[] = ['eip155', 'solana', 'sui']
