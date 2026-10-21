import type { SiweClient } from '@omnimarket/auth/client'
import { useAccount, useSiwe, useTransactions, useWalletManager } from '@omnimarket/react'
import { Suspense, lazy, useCallback, useState, type ReactNode } from 'react'
import { AccountPanel } from './components/AccountPanel'
import { ActivityPanel } from './components/ActivityPanel'
import { ConnectPanel } from './components/ConnectPanel'
import { MarketPage } from './components/MarketPage'
import { MyNftsPage } from './components/MyNftsPage'
import { NetworkGate } from './components/NetworkGate'
import { SiwePanel } from './components/SiwePanel'
import { UpdateBanner } from './components/UpdateBanner'
import { WalletConnectDialog } from './components/walletconnect/WalletConnectDialog'

// Chain-specific SDKs (Metaplex Core/Umi, Kiosk) load only when a wallet of that ecosystem connects.
const SolanaNftsPage = lazy(() => import('./components/solana/SolanaNftsPage').then((m) => ({ default: m.SolanaNftsPage })))
const SuiMarketPage = lazy(() => import('./components/sui/SuiPages').then((m) => ({ default: m.SuiMarketPage })))
const SuiNftsPage = lazy(() => import('./components/sui/SuiPages').then((m) => ({ default: m.SuiNftsPage })))

type Tab = 'market' | 'mine' | 'activity'

/** Pages per ecosystem; the wallet layer and the Activity list are shared. */
const PAGES: Record<string, Partial<Record<Tab, () => ReactNode>>> = {
  eip155: {
    market: () => (
      <NetworkGate>
        <MarketPage />
      </NetworkGate>
    ),
    mine: () => (
      <NetworkGate>
        <MyNftsPage />
      </NetworkGate>
    ),
  },
  // Solana listings need an escrow program (out of scope); mint and transfer Core assets.
  solana: { mine: () => <SolanaNftsPage /> },
  sui: { market: () => <SuiMarketPage />, mine: () => <SuiNftsPage /> },
}

const TAB_LABELS: Record<Tab, string> = { market: 'Market', mine: 'My NFTs', activity: 'Activity' }

export function App({ siwe }: { siwe: SiweClient }) {
  const manager = useWalletManager()
  const { status, address, namespace } = useAccount()
  const auth = useSiwe(siwe)
  const [selected, setSelected] = useState<Tab>('market')
  const inFlight = useTransactions().filter(
    (tx) => (tx.status === 'pending' || tx.status === 'confirming') && tx.from.toLowerCase() === address?.toLowerCase(),
  ).length

  const disconnect = useCallback(async () => {
    await auth.signOut()
    await manager.disconnect()
  }, [auth, manager])

  const pages = PAGES[namespace ?? ''] ?? {}
  const tabs = [...(Object.keys(pages) as Tab[]), 'activity' as const]
  const tab = tabs.includes(selected) ? selected : tabs[0]!

  const connected = status === 'connected'
  return (
    <div className="app">
      <header className="header">
        <span className="brand">
          Omni<b>Market</b>
        </span>
        {connected && (
          <nav className="tabs" aria-label="Sections">
            {tabs.map((id) => (
              <button key={id} className={tab === id ? 'tab tab-active' : 'tab'} aria-current={tab === id} onClick={() => setSelected(id)}>
                {TAB_LABELS[id]}
                {id === 'activity' && inFlight > 0 && <span className="count">{inFlight}</span>}
              </button>
            ))}
          </nav>
        )}
        <span className={`pill pill-${status}`}>{status}</span>
      </header>

      {connected ? (
        <div className="layout">
          <main className="main">
            <Suspense fallback={<p className="muted">Loading…</p>}>{tab === 'activity' ? <ActivityPanel /> : pages[tab]?.()}</Suspense>
          </main>
          <aside className="aside">
            <AccountPanel onDisconnect={disconnect} />
            <SiwePanel auth={auth} />
          </aside>
        </div>
      ) : (
        <main className="grid">
          <ConnectPanel />
        </main>
      )}
      <WalletConnectDialog />
      <UpdateBanner />
    </div>
  )
}
