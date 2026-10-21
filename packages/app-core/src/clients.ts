import { createPublicClient, fallback, http, type Chain, type PublicClient, type Transport } from 'viem'
import { findChain } from './chains'

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
