import { createKioskClient, getSuiDeployment, type SuiDeployment } from '@omnimarket/contracts/sui'
import type { KioskClient } from '@mysten/kiosk'
import type { SuiGrpcClient } from '@mysten/sui/grpc'
import { useAccount, useWalletManager } from '@omnimarket/react'
import type { CaipAccountId, CaipChainId } from '@omnimarket/wallet-core'
import { isSolanaConnector, type SolanaConnector } from '@omnimarket/wallet-core/solana'
import { isSuiConnector, type SuiConnector } from '@omnimarket/wallet-core/sui'
import type { Address, Rpc, SolanaRpcApi } from '@solana/kit'
import { useMemo } from 'react'
import { getSolanaRpc, getSuiClient } from '../clients'
import { suiNetwork } from '../networks'

const kioskClients = new Map<string, KioskClient>()
function getKioskClient(chain: CaipChainId): KioskClient {
  const network = suiNetwork(chain)
  let kiosk = kioskClients.get(network)
  if (!kiosk) {
    kiosk = createKioskClient(getSuiClient(chain), network)
    kioskClients.set(network, kiosk)
  }
  return kiosk
}

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

export interface SuiContext {
  readonly connector: SuiConnector
  readonly account: CaipAccountId
  readonly address: string
  readonly chain: CaipChainId
  readonly client: SuiGrpcClient
  readonly kiosk: KioskClient
  readonly deployment: SuiDeployment | undefined
}

export function useSui(): SuiContext | null {
  const manager = useWalletManager()
  const { account, address, chainId, walletId } = useAccount()
  return useMemo(() => {
    const connector = manager.getActiveConnector()
    if (!isSuiConnector(connector) || !account || !address || !chainId) return null
    return {
      connector,
      account,
      address,
      chain: chainId,
      client: getSuiClient(chainId),
      kiosk: getKioskClient(chainId),
      deployment: getSuiDeployment(suiNetwork(chainId)),
    }
  }, [manager, account, address, chainId, walletId])
}
