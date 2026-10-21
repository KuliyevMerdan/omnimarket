/**
 * Sui client and engine. A separate entry point (`@omnimarket/app-core/sui`): @mysten/sui with its gRPC
 * transport, BCS and transaction builder is the biggest chain SDK here, loaded only for Sui users.
 */
import { SuiGrpcClient } from '@mysten/sui/grpc'
import type { CaipChainId } from '@omnimarket/wallet-core'
import type { TxStore } from '@omnimarket/tx-engine'
import { SuiTxEngine } from '@omnimarket/tx-engine/sui'
import { suiNetwork } from './networks'

const SUI_RPC: Record<string, string> = {
  localnet: 'http://127.0.0.1:9000',
  testnet: 'https://fullnode.testnet.sui.io:443',
  mainnet: 'https://fullnode.mainnet.sui.io:443',
}
const suiClients = new Map<string, SuiGrpcClient>()

/** gRPC-web: Sui fullnodes no longer serve JSON-RPC (local 1.82 nodes answer 404). */
export function getSuiClient(chain: CaipChainId): SuiGrpcClient {
  const network = suiNetwork(chain)
  let client = suiClients.get(network)
  if (!client) {
    client = new SuiGrpcClient({ baseUrl: SUI_RPC[network]!, network })
    suiClients.set(network, client)
  }
  return client
}

export function createSuiEngine(store: TxStore): SuiTxEngine {
  return new SuiTxEngine({ store, getClient: getSuiClient })
}
