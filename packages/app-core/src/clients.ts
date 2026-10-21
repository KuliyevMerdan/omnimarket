import { SuiGrpcClient } from '@mysten/sui/grpc'
import type { CaipChainId } from '@omnimarket/wallet-core'
import { createSolanaRpc, type Rpc, type SolanaRpcApi } from '@solana/kit'
import { createPublicClient, fallback, http, type Chain, type PublicClient, type Transport } from 'viem'
import { findChain } from './chains'
import { suiNetwork } from './networks'

const evmClients = new Map<number, PublicClient>()

/**
 * One read client per chain. `VITE_RPC_URL_<chainId>` (a private RPC) goes first, the chain's public
 * RPC is the fallback: when one endpoint times out or rate-limits, reads move to the next one.
 */
export function getPublicClient(chainId: number): PublicClient {
  let client = evmClients.get(chainId)
  if (client) return client
  const chain = findChain(chainId)
  if (!chain) throw new Error(`Chain ${chainId} is not supported`)

  client = createPublicClient({
    chain,
    transport: evmTransport(chain),
    pollingInterval: chainId === 31337 ? 1000 : 4000,
  }) as PublicClient
  evmClients.set(chainId, client)
  return client
}

/** Read transport for a chain; also used by the WalletConnect provider for everything but signing. */
export function evmTransport(chain: Chain): Transport {
  const custom = import.meta.env[`VITE_RPC_URL_${chain.id}`] as string | undefined
  return fallback([...(custom ? [http(custom)] : []), http(undefined, { timeout: 10_000 })])
}

const SOLANA_RPC: Record<string, string> = {
  'solana:localnet': 'http://127.0.0.1:8899',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'https://api.devnet.solana.com',
}
const solanaClients = new Map<string, Rpc<SolanaRpcApi>>()

export function getSolanaRpc(chain: CaipChainId): Rpc<SolanaRpcApi> {
  let rpc = solanaClients.get(chain)
  if (!rpc) {
    const url = (import.meta.env.VITE_SOLANA_RPC_URL as string | undefined) ?? SOLANA_RPC[chain]
    if (!url) throw new Error(`No RPC configured for ${chain}`)
    rpc = createSolanaRpc(url)
    solanaClients.set(chain, rpc)
  }
  return rpc
}

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

/**
 * Program error tables, registered by the lazily loaded chain modules (e.g. Metaplex Core's table
 * comes with the Solana page), so the main bundle doesn't carry them.
 */
const programErrorTables: ((programAddress: string, code: number) => string | undefined)[] = []

export function registerProgramErrors(table: (programAddress: string, code: number) => string | undefined): void {
  if (!programErrorTables.includes(table)) programErrorTables.push(table)
}

export function solanaProgramErrorName(programAddress: string, code: number): string | undefined {
  for (const table of programErrorTables) {
    const name = table(programAddress, code)
    if (name) return name
  }
  return undefined
}
