import { serve } from '@hono/node-server'
import { createPublicClient, http, type Chain, type PublicClient } from 'viem'
import { getDeployment } from '@omnimarket/contracts'
import { foundry, mainnet, polygon, polygonAmoy, sepolia } from 'viem/chains'
import { createApp } from './app'
import { withStaticApps } from './static'
import type { MarketConfig } from './orders'

const chains: readonly Chain[] = [mainnet, sepolia, polygon, polygonAmoy, foundry]
const env = process.env
const port = Number(env.PORT ?? 8787)
// Render sets RENDER_EXTERNAL_URL to the service's public URL.
const origin = env.SIWE_ORIGIN ?? env.RENDER_EXTERNAL_URL ?? 'http://localhost:5173'

// Lazily created; only hit for smart-contract wallet signatures (EIP-1271 / 6492).
const clients = new Map<number, PublicClient>()
function getPublicClient(chainId: number): PublicClient | undefined {
  const chain = chains.find((c) => c.id === chainId)
  if (!chain) return undefined
  let client = clients.get(chainId)
  if (!client) {
    client = createPublicClient({ chain, transport: http(env[`RPC_URL_${chainId}`]) }) as PublicClient
    clients.set(chainId, client)
  }
  return client
}

const markets = new Map<number, MarketConfig>()
for (const chain of chains) {
  const deployment = getDeployment(chain.id)
  if (deployment) markets.set(chain.id, { market: deployment.OmniMarket, collections: [deployment.OmniNFT] })
}

const app = createApp(
  {
    siweDomain: env.SIWE_DOMAIN ?? new URL(origin).host,
    siweOrigin: origin,
    chainIds: chains.map((c) => c.id),
    signInChains: (env.SIGN_IN_CHAINS ?? 'solana:localnet,solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1,sui:localnet,sui:testnet').split(','),
    sessionTtlMs: 24 * 60 * 60 * 1000,
    secureCookies: origin.startsWith('https://'),
    markets,
  },
  { getPublicClient },
)

// STATIC_DIR: also serve the frontends, with the API under /api (production, one origin).
const server = env.STATIC_DIR ? withStaticApps(app, env.STATIC_DIR) : app

serve({ fetch: server.fetch, port }, ({ port }) => {
  console.log(`api listening on http://localhost:${port}${env.STATIC_DIR ? ' (API under /api, frontends from ' + env.STATIC_DIR + ')' : ''} (SIWE origin ${origin})`)
  console.log(`order books: ${[...markets.keys()].join(', ') || 'none (run pnpm --filter @omnimarket/contracts deploy:local)'}`)
})
