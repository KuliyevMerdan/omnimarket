import { MARKET_PAGES, type MarketPage } from '@omnimarket/app-core'
import { lazy, Suspense, type ReactNode } from 'react'
import { InspectPage } from './components/InspectPage'
import { MarketPage as EvmMarketPage } from './components/MarketPage'
import { MyNftsPage } from './components/MyNftsPage'
import { NetworkGate } from './components/NetworkGate'

// Chain-specific SDKs (Metaplex Core/Umi, Kiosk) load only when a wallet of that ecosystem connects.
const SolanaNftsPage = lazy(() => import('./components/solana/SolanaNftsPage').then((m) => ({ default: m.SolanaNftsPage })))
const SuiMarketPage = lazy(() => import('./components/sui/SuiPages').then((m) => ({ default: m.SuiMarketPage })))
const SuiNftsPage = lazy(() => import('./components/sui/SuiPages').then((m) => ({ default: m.SuiNftsPage })))

/** Renderers for the pages listed in MARKET_PAGES (app-core), which the host also reads. */
const PAGES: Record<string, Partial<Record<MarketPage, () => ReactNode>>> = {
  eip155: {
    market: () => (
      <NetworkGate>
        <EvmMarketPage />
      </NetworkGate>
    ),
    mine: () => (
      <NetworkGate>
        <MyNftsPage />
      </NetworkGate>
    ),
    inspect: () => (
      <NetworkGate>
        <InspectPage />
      </NetworkGate>
    ),
  },
  solana: { mine: () => <SolanaNftsPage /> },
  sui: { market: () => <SuiMarketPage />, mine: () => <SuiNftsPage /> },
}

export function pagesFor(namespace: string | undefined): MarketPage[] {
  return [...(MARKET_PAGES[namespace ?? ''] ?? [])]
}

export function MarketPages({ namespace, page }: { namespace: string | undefined; page: MarketPage }) {
  const render = PAGES[namespace ?? '']?.[page]
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      {render ? render() : <p className="muted">This section is not available for the connected ecosystem.</p>}
    </Suspense>
  )
}
