import { SuiSignAndExecuteTransaction, SuiSignPersonalMessage, SuiSignTransaction } from '@mysten/wallet-standard'
import type { ChainAdapter, WalletConnector } from '../../types'
import { createWalletStandardAdapter } from '../wallet-standard/adapter'
import type { StandardChain } from '../wallet-standard/connector'
import type { WalletRegistry } from '../wallet-standard/registry'
import { SuiConnector } from './connector'

export { SuiConnector, type SerializableSuiTransaction } from './connector'

export const SUI_MAINNET = { caip: 'sui:mainnet', standard: 'sui:mainnet', name: 'Sui' } as const
export const SUI_TESTNET = { caip: 'sui:testnet', standard: 'sui:testnet', name: 'Sui Testnet' } as const
export const SUI_DEVNET = { caip: 'sui:devnet', standard: 'sui:devnet', name: 'Sui Devnet' } as const
export const SUI_LOCALNET = { caip: 'sui:localnet', standard: 'sui:localnet', name: 'Sui (local)' } as const
export const SUI_CHAINS: readonly [StandardChain, ...StandardChain[]] = [SUI_MAINNET, SUI_TESTNET, SUI_DEVNET, SUI_LOCALNET]

export interface SuiAdapterOptions {
  readonly chains?: readonly [StandardChain, ...StandardChain[]]
  readonly registry?: WalletRegistry | Promise<WalletRegistry>
}

export function createSuiAdapter(options: SuiAdapterOptions = {}): ChainAdapter {
  const chains = options.chains ?? SUI_CHAINS
  return createWalletStandardAdapter({
    namespace: 'sui',
    requiredFeatures: [
      [SuiSignPersonalMessage, SuiSignTransaction],
      [SuiSignPersonalMessage, SuiSignAndExecuteTransaction],
    ],
    createConnector: (wallet) => new SuiConnector(wallet, chains),
    registry: options.registry,
  })
}

export function isSuiConnector(connector: WalletConnector | null | undefined): connector is SuiConnector {
  return connector instanceof SuiConnector
}
