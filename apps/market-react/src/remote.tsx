/**
 * Micro-frontend entry, exposed through Module Federation as `market/market`. The host owns the core
 * (wallet manager, engines) and the chrome (header, connect, account, activity); this remote renders
 * the marketplace pages for whatever the shared core has connected.
 */
import { MARKET_REMOTE_VERSION, type MarketMountHandle, type MarketMountProps } from '@omnimarket/app-core'
import { useAccount } from '@omnimarket/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import marketCss from './market.css?inline'
import { MarketPages } from './MarketPages'
import { Providers } from './Providers'
import './ui'

export const version = MARKET_REMOTE_VERSION

function RemotePage({ page }: Pick<MarketMountProps, 'page'>) {
  const { namespace, status } = useAccount()
  if (status !== 'connected') return <p className="muted">Connect a wallet to see the marketplace.</p>
  return <MarketPages namespace={namespace} page={page} />
}

export function mount(element: HTMLElement, props: MarketMountProps): MarketMountHandle {
  const releaseStyles = adoptStyles()
  const root = createRoot(element)
  const render = ({ core, page }: MarketMountProps) =>
    root.render(
      <StrictMode>
        <Providers core={core}>
          <div className="omni-market">
            <RemotePage page={page} />
          </div>
        </Providers>
      </StrictMode>,
    )
  render(props)
  return {
    update: render,
    unmount() {
      root.unmount()
      releaseStyles()
    },
  }
}

let styleUsers = 0
let styleElement: HTMLStyleElement | null = null

/** One `<style>` for all mounted instances, removed with the last one: no leftovers in the host. */
function adoptStyles(): () => void {
  if (styleUsers++ === 0) {
    styleElement = document.createElement('style')
    styleElement.dataset.omniRemote = 'market'
    styleElement.textContent = marketCss
    document.head.append(styleElement)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (--styleUsers === 0) {
      styleElement?.remove()
      styleElement = null
    }
  }
}
