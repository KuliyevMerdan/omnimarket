import { createWalletConnect, type WalletConnect } from '@omnimarket/wallet-core/walletconnect'
import { SUPPORTED_CHAINS } from './chains'
import { evmTransport, getSuiClient } from './clients'
import { SOLANA_NETWORKS, SUI_NETWORKS } from './networks'

const projectId = import.meta.env.VITE_WC_PROJECT_ID as string | undefined

/**
 * Development only: `localStorage.setItem('omni:wc-mock', '1')` swaps the relay for an in-page mock
 * wallet with real keys (anvil, local validators), so the whole QR → approve → sign flow runs without
 * a phone. `import.meta.env.DEV` is false in production builds, so the mock is never bundled there.
 */
function mockEnabled(): boolean {
  if (!import.meta.env.DEV) return false
  try {
    return localStorage.getItem('omni:wc-mock') === '1'
  } catch {
    return false
  }
}

/** `null` when no WalletConnect project id is configured: the app then offers browser wallets only. */
export function createAppWalletConnect(): WalletConnect | null {
  const mock = mockEnabled()
  if (!projectId && !mock) return null
  const origin = window.location.origin
  return createWalletConnect({
    projectId: projectId ?? 'mock',
    // `url` must be the real origin: wallets check it with the Verify API and warn on a mismatch.
    metadata: {
      name: 'OmniMarket',
      description: 'Multi-chain NFT marketplace',
      url: origin,
      icons: [`${origin}/icon-192.png`],
      // Lets the wallet send the user back here (the installed PWA included) after approving.
      redirect: { universal: origin },
    },
    // `import.meta.env.DEV &&` is a build-time constant: production builds drop the mock chunk entirely.
    createClient: import.meta.env.DEV && mock ? () => import('./dev/mockWalletConnect').then((m) => m.createMockClient()) : undefined,
    eip155: { chains: SUPPORTED_CHAINS, transport: evmTransport },
    solana: { chains: SOLANA_NETWORKS },
    sui: { chains: SUI_NETWORKS, getClient: getSuiClient },
  })
}
