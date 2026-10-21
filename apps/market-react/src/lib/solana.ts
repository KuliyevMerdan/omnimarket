import type { CaipAccountId, CaipChainId } from '@omnimarket/wallet-core'
import { getSolanaRpc } from '@omnimarket/app-core/solana'
import { useAccount, useWalletManager } from '@omnimarket/react'
import { isSolanaConnector, type SolanaConnector } from '@omnimarket/wallet-core/solana'
import type { Address, Rpc, SolanaRpcApi } from '@solana/kit'
import { useMemo } from 'react'

export interface SolanaContext {
  readonly connector: SolanaConnector
  readonly account: CaipAccountId
  readonly address: Address
  readonly chain: CaipChainId
  readonly rpc: Rpc<SolanaRpcApi>
}

/** The connected Solana wallet with its RPC, or null when another ecosystem is connected. */
export function useSolana(): SolanaContext | null {
  const manager = useWalletManager()
  const { account, address, chainId, walletId } = useAccount()
  return useMemo(() => {
    const connector = manager.getActiveConnector()
    if (!isSolanaConnector(connector) || !account || !address || !chainId) return null
    return { connector, account, address: address as Address, chain: chainId, rpc: getSolanaRpc(chainId) }
    // walletId: the active connector changes together with it.
  }, [manager, account, address, chainId, walletId])
}
