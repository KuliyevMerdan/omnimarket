import type { SiweClient } from '@omnimarket/auth/client'
import { useAccount, useSiwe, useTransactions, useWalletManager } from '@omnimarket/react'
import type { MarketPage } from '@omnimarket/app-core'
import { useCallback, useState } from 'react'
import { AccountPanel } from './components/AccountPanel'
import { ActivityPanel } from './components/ActivityPanel'
import { ConnectPanel } from './components/ConnectPanel'
import { SiwePanel } from './components/SiwePanel'
import { UpdateBanner } from './components/UpdateBanner'
import { WalletConnectDialog } from './components/walletconnect/WalletConnectDialog'
import { MarketPages, pagesFor } from './MarketPages'

type Tab = MarketPage | 'activity'

const TAB_LABELS: Record<Tab, string> = { market: 'Market', mine: 'My NFTs', inspect: 'Check a request', activity: 'Activity' }

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

  const tabs: Tab[] = [...pagesFor(namespace), 'activity']
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
            {tab === 'activity' ? <ActivityPanel /> : <MarketPages namespace={namespace} page={tab} />}
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
