import { useAccount, useWalletError, useWalletManager, useWallets } from '@omnimarket/react'
import { useState } from 'react'
import type { CaipChainId, ChainNamespace, WalletInfo } from '@omnimarket/wallet-core'
import { DEFAULT_CHAIN_ID } from '../chains'
import { SOLANA_NETWORKS, SUI_NETWORKS } from '../networks'
import { describeError } from '../errors'
import { WalletIcon } from './WalletIcon'

export function ConnectPanel() {
  const manager = useWalletManager()
  const wallets = useWallets()
  const error = useWalletError()
  const { status } = useAccount()
  const [pendingId, setPendingId] = useState<string | null>(null)

  const connect = async (wallet: WalletInfo) => {
    setPendingId(wallet.id)
    // Errors land in manager state (`useWalletError`); nothing else to do here.
    await manager.connect(wallet.id, { chainId: DEFAULT_CHAINS[wallet.namespace] }).catch(() => {})
    setPendingId(null)
  }
  const groups = GROUPS.map((g) => ({ ...g, wallets: wallets.filter((w) => w.namespace === g.namespace) })).filter(
    (g) => g.wallets.length > 0,
  )

  return (
    <section className="card card-wide">
      <h2>Connect a wallet</h2>
      {status === 'reconnecting' && <p className="muted">Restoring your previous session…</p>}

      {wallets.length === 0 ? (
        <p className="muted">
          No browser wallets detected. Install an EIP-6963 wallet (MetaMask, Rabby) or a Wallet Standard wallet for Solana
          (Phantom, Solflare) or Sui (Slush, Suiet). WalletConnect (mobile wallets) arrives in phase 4.
        </p>
      ) : (
        groups.map((group) => (
          <div key={group.namespace} className="wallet-group">
            <h3 className="muted small">{group.title}</h3>
            <ul className="wallet-list">
              {group.wallets.map((wallet) => (
                <li key={wallet.id}>
                  <button className="wallet" disabled={status === 'connecting'} onClick={() => connect(wallet)}>
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

      {error && <p className="error">{describeError(error)}</p>}
    </section>
  )
}

const GROUPS: { namespace: ChainNamespace; title: string }[] = [
  { namespace: 'eip155', title: 'Ethereum & EVM · EIP-6963' },
  { namespace: 'solana', title: 'Solana · Wallet Standard' },
  { namespace: 'sui', title: 'Sui · Wallet Standard' },
]

const DEFAULT_CHAINS: Record<ChainNamespace, CaipChainId> = {
  eip155: DEFAULT_CHAIN_ID,
  solana: SOLANA_NETWORKS[0].caip,
  sui: SUI_NETWORKS[0].caip,
}
