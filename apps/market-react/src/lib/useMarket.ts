import { getDeployment, type Deployment } from '@omnimarket/contracts'
import { useAccount, useWalletManager } from '@omnimarket/react'
import { parseChainId, type CaipAccountId } from '@omnimarket/wallet-core'
import { isEvmConnector, type Eip1193Connector } from '@omnimarket/wallet-core/evm'
import { useMemo } from 'react'
import type { Address, Chain, PublicClient } from 'viem'
import { findChain, getPublicClient } from '@omnimarket/app-core'

export interface MarketContext {
  readonly chainId: number | undefined
  readonly chain: Chain | undefined
  readonly deployment: Deployment | undefined
  readonly client: PublicClient | undefined
  readonly signer: Eip1193Connector | null
  readonly address: Address | undefined
  readonly account: CaipAccountId | undefined
}

export function useMarket(): MarketContext {
  const manager = useWalletManager()
  const { address, account, chainId: caip, walletId } = useAccount()

  return useMemo(() => {
    const chainId = caip && parseChainId(caip).namespace === 'eip155' ? Number(parseChainId(caip).reference) : undefined
    const chain = findChain(chainId)
    const connector = manager.getActiveConnector()
    return {
      chainId,
      chain,
      deployment: chainId ? getDeployment(chainId) : undefined,
      client: chain && chainId ? getPublicClient(chainId) : undefined,
      signer: isEvmConnector(connector) ? connector : null,
      address: address as Address | undefined,
      account,
    }
    // walletId: the active connector changes together with it.
  }, [manager, caip, address, account, walletId])
}
