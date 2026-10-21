import { SOLANA_DEVNET, SOLANA_LOCALNET } from '@omnimarket/wallet-core/solana'
import { SUI_LOCALNET, SUI_TESTNET } from '@omnimarket/wallet-core/sui'
import type { StandardChain, StandardChainList } from '@omnimarket/wallet-core/wallet-standard'
import type { CaipChainId, ChainNamespace } from '@omnimarket/wallet-core'
import { DEFAULT_CHAIN_ID, SUPPORTED_CHAINS, explorerTxUrl } from './chains'

/** Local validators first in development (`pnpm dev:solana`, `pnpm dev:sui`). */
export const SOLANA_NETWORKS: StandardChainList = import.meta.env.DEV ? [SOLANA_LOCALNET, SOLANA_DEVNET] : [SOLANA_DEVNET]
export const SUI_NETWORKS: StandardChainList = import.meta.env.DEV ? [SUI_LOCALNET, SUI_TESTNET] : [SUI_TESTNET]

/** Where a fresh connection starts, per ecosystem. */
export const DEFAULT_CHAINS: Record<ChainNamespace, CaipChainId> = {
  eip155: DEFAULT_CHAIN_ID,
  solana: SOLANA_NETWORKS[0].caip,
  sui: SUI_NETWORKS[0].caip,
}

export interface NetworkOption {
  readonly caip: CaipChainId
  readonly name: string
}

export function networksFor(namespace: ChainNamespace | undefined): NetworkOption[] {
  switch (namespace) {
    case 'eip155':
      return SUPPORTED_CHAINS.map((c) => ({ caip: `eip155:${c.id}`, name: c.testnet ? `${c.name} (testnet)` : c.name }))
    case 'solana':
      return SOLANA_NETWORKS.map(toOption)
    case 'sui':
      return SUI_NETWORKS.map(toOption)
    default:
      return []
  }
}

const toOption = (chain: StandardChain): NetworkOption => ({ caip: chain.caip, name: chain.name })

export function networkName(caip: CaipChainId | undefined): string {
  const [namespace] = caip?.split(':') ?? []
  return networksFor(namespace as ChainNamespace).find((n) => n.caip === caip)?.name ?? caip ?? '—'
}

/** `sui:testnet` → `testnet` (Sui SDK network names). */
export function suiNetwork(caip: CaipChainId): 'localnet' | 'testnet' | 'devnet' | 'mainnet' {
  return caip.slice('sui:'.length) as 'localnet' | 'testnet' | 'devnet' | 'mainnet'
}

export function explorerUrl(kind: { namespace: 'eip155'; chainId: number } | { namespace: 'solana' | 'sui'; chain: CaipChainId }, id: string) {
  if (kind.namespace === 'eip155') return explorerTxUrl(kind.chainId, id)
  if (kind.namespace === 'solana') {
    if (kind.chain === SOLANA_DEVNET.caip) return `https://explorer.solana.com/tx/${id}?cluster=devnet`
    if (kind.chain === SOLANA_LOCALNET.caip) {
      return `https://explorer.solana.com/tx/${id}?cluster=custom&customUrl=${encodeURIComponent('http://127.0.0.1:8899')}`
    }
    return `https://explorer.solana.com/tx/${id}`
  }
  const network = suiNetwork(kind.chain)
  return network === 'localnet' ? undefined : `https://suiscan.xyz/${network}/tx/${id}`
}
