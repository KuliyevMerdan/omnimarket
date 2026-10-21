import type { StandardChain } from '../wallet-standard/connector'

/**
 * CAIP-2 references for Solana are the first 32 chars of the genesis hash. Local validators get a
 * fresh genesis on every reset, so `solana:localnet` (the Wallet Standard name) is used instead.
 */
export const SOLANA_MAINNET = { caip: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', standard: 'solana:mainnet', name: 'Solana' } as const
export const SOLANA_DEVNET = { caip: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', standard: 'solana:devnet', name: 'Solana Devnet' } as const
export const SOLANA_TESTNET = { caip: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z', standard: 'solana:testnet', name: 'Solana Testnet' } as const
export const SOLANA_LOCALNET = { caip: 'solana:localnet', standard: 'solana:localnet', name: 'Solana (local)' } as const

export const SOLANA_CHAINS: readonly [StandardChain, ...StandardChain[]] = [SOLANA_MAINNET, SOLANA_DEVNET, SOLANA_TESTNET, SOLANA_LOCALNET]
