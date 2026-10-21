/**
 * Solana RPC and engine. A separate entry point (`@omnimarket/app-core/solana`), loaded only when a
 * Solana wallet connects or Solana transactions are pending: an EVM user never downloads @solana/kit's
 * RPC stack.
 */
import type { CaipChainId } from '@omnimarket/wallet-core'
import type { TxStore } from '@omnimarket/tx-engine'
import { SolanaTxEngine } from '@omnimarket/tx-engine/solana'
import { createDefaultRpcTransport, createSolanaRpcFromTransport, type Rpc, type RpcTransport, type SolanaRpcApi } from '@solana/kit'
import { solanaProgramErrorName } from './clients'

const SOLANA_RPC: Record<string, readonly string[]> = {
  'solana:localnet': ['http://127.0.0.1:8899'],
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': ['https://api.devnet.solana.com'],
}
const solanaClients = new Map<string, Rpc<SolanaRpcApi>>()

/** `VITE_SOLANA_RPC_URL` (a private RPC) first, the public endpoint as fallback, like the EVM transport. */
export function getSolanaRpc(chain: CaipChainId): Rpc<SolanaRpcApi> {
  let rpc = solanaClients.get(chain)
  if (!rpc) {
    const custom = import.meta.env.VITE_SOLANA_RPC_URL as string | undefined
    const urls = [...(custom ? [custom] : []), ...(SOLANA_RPC[chain] ?? [])]
    if (urls.length === 0) throw new Error(`No RPC configured for ${chain}`)
    rpc = createSolanaRpcFromTransport(failover(urls.map((url) => createDefaultRpcTransport({ url }))))
    solanaClients.set(chain, rpc)
  }
  return rpc
}

/**
 * Tries transports in order and sticks with the last one that answered. Only transport failures
 * (network, HTTP 429/5xx) move on: a JSON-RPC error is an answer, and the next node would give the same.
 */
export function failover(transports: readonly RpcTransport[]): RpcTransport {
  let preferred = 0
  return (async (config: Parameters<RpcTransport>[0]) => {
    let lastError: unknown
    for (let attempt = 0; attempt < transports.length; attempt++) {
      const index = (preferred + attempt) % transports.length
      try {
        const response = await transports[index]!(config)
        preferred = index
        return response
      } catch (error) {
        if (config.signal?.aborted) throw error
        lastError = error
      }
    }
    throw lastError
  }) as RpcTransport
}

export function createSolanaEngine(store: TxStore): SolanaTxEngine {
  return new SolanaTxEngine({ store, getRpc: getSolanaRpc, programErrors: solanaProgramErrorName })
}
