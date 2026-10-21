import { evmChainId, type CaipChainId } from '@omnimarket/wallet-core'
import type { Chain } from 'viem'
import { foundry, mainnet, polygon, polygonAmoy, sepolia } from 'viem/chains'

const anvil: Chain = { ...foundry, name: 'Anvil (local)' }

/** Local chain first in development: contracts are deployed there by `pnpm deploy:local`. */
export const SUPPORTED_CHAINS: readonly [Chain, ...Chain[]] = import.meta.env.DEV
  ? [anvil, sepolia, polygonAmoy, mainnet, polygon]
  : [sepolia, polygonAmoy, mainnet, polygon]

export const DEFAULT_CHAIN_ID: CaipChainId = evmChainId(SUPPORTED_CHAINS[0].id)

export function findChain(chainId: CaipChainId | number | undefined): Chain | undefined {
  return SUPPORTED_CHAINS.find((chain) => chain.id === chainId || evmChainId(chain.id) === chainId)
}

export function explorerTxUrl(chainId: number, hash: string): string | undefined {
  const explorer = findChain(chainId)?.blockExplorers?.default.url
  return explorer ? `${explorer}/tx/${hash}` : undefined
}
