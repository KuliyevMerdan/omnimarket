import {
  SolanaSignAndSendTransaction,
  SolanaSignMessage,
  SolanaSignTransaction,
} from '@solana/wallet-standard-features'
import type { ChainAdapter, WalletConnector } from '../../types'
import { createWalletStandardAdapter } from '../wallet-standard/adapter'
import type { WalletRegistry } from '../wallet-standard/registry'
import { SOLANA_CHAINS } from './chains'
import { SolanaConnector } from './connector'
import type { StandardChainList } from '../wallet-standard/connector'

export { SOLANA_CHAINS, SOLANA_DEVNET, SOLANA_LOCALNET, SOLANA_MAINNET, SOLANA_TESTNET } from './chains'
export { SolanaConnector } from './connector'

export interface SolanaAdapterOptions {
  readonly chains?: StandardChainList
  readonly registry?: WalletRegistry | Promise<WalletRegistry>
}

export function createSolanaAdapter(options: SolanaAdapterOptions = {}): ChainAdapter {
  const chains = options.chains ?? SOLANA_CHAINS
  return createWalletStandardAdapter({
    namespace: 'solana',
    // Message signing for sign-in, plus at least one way to get a transaction on chain.
    requiredFeatures: [
      [SolanaSignMessage, SolanaSignTransaction],
      [SolanaSignMessage, SolanaSignAndSendTransaction],
    ],
    createConnector: (wallet) => new SolanaConnector(wallet, chains),
    registry: options.registry,
  })
}

export function isSolanaConnector(connector: WalletConnector | null | undefined): connector is SolanaConnector {
  return connector instanceof SolanaConnector
}
