import { createOmniCore } from '@omnimarket/app-core'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Providers } from './Providers'
import { registerServiceWorker } from './pwa'
import './ui'
import './styles.css'

// Standalone mode: this app owns the core. As a micro-frontend (remote.tsx) it receives the host's.
// Created once, outside React: the wallet and tx layers must not depend on component lifecycles.
const core = createOmniCore()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers core={core}>
      <div className="omni-market">
        <App siwe={core.siwe} />
      </div>
    </Providers>
  </StrictMode>,
)

registerServiceWorker()
