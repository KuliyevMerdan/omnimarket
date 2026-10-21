import { createSiweClient, type SiweClient } from '@omnimarket/auth/client'
import { omniMarketAbi, omniNftAbi } from '@omnimarket/contracts'
import { SolanaTxEngine, SuiTxEngine, TxEngine, TxStore } from '@omnimarket/tx-engine'
import { WalletManager } from '@omnimarket/wallet-core'
import { createEvmAdapter } from '@omnimarket/wallet-core/evm'
import { createSolanaAdapter } from '@omnimarket/wallet-core/solana'
import { createSuiAdapter } from '@omnimarket/wallet-core/sui'
import type { WalletConnect } from '@omnimarket/wallet-core/walletconnect'
import { SUPPORTED_CHAINS } from './chains'
import { getPublicClient, getSolanaRpc, getSuiClient, solanaProgramErrorName } from './clients'
import { SOLANA_NETWORKS, SUI_NETWORKS } from './networks'
import { createAppWalletConnect } from './walletconnect'

/**
 * Everything stateful the UI talks to. Framework-free: the Vue shell and the React micro-frontend
 * bind to the *same* instances, so there is one wallet connection, one WalletConnect session and one
 * transaction history per page, whichever framework renders it.
 */
export interface OmniCore {
  readonly manager: WalletManager
  readonly txStore: TxStore
  readonly evm: TxEngine
  readonly solana: SolanaTxEngine
  readonly sui: SuiTxEngine
  readonly siwe: SiweClient
  readonly walletConnect: WalletConnect | null
}

export interface OmniCoreOptions {
  /** Same-origin API prefix (the dev servers proxy it), so the session cookie stays first-party. */
  readonly apiBaseUrl?: string
}

/** Composition root. Call once per page, outside any component tree. */
export function createOmniCore({ apiBaseUrl = '/api' }: OmniCoreOptions = {}): OmniCore {
  // EIP-6963 for EVM; Solana and Sui share the Wallet Standard registry; WalletConnect adds one
  // relay-backed connector per namespace, all on a single session.
  const walletConnect = createAppWalletConnect()
  const manager = new WalletManager({
    adapters: [
      createEvmAdapter({ chains: SUPPORTED_CHAINS }),
      createSolanaAdapter({ chains: SOLANA_NETWORKS }),
      createSuiAdapter({ chains: SUI_NETWORKS }),
      ...(walletConnect?.adapters ?? []),
    ],
  })

  // One persisted history for all three lifecycles.
  const txStore = new TxStore()
  const evm = new TxEngine({
    store: txStore,
    getPublicClient,
    abis: [omniMarketAbi, omniNftAbi],
    stuckAfterMs: (chainId) => (chainId === 31337 ? 20_000 : 3 * 60_000),
    // Only wallets known to honour a dApp-supplied nonce get in-app speed-up/cancel.
    // Everyone else uses the wallet's own button; the tracker follows the replacement.
    canReplace: (wallet) => wallet.rdns?.startsWith('dev.omnimarket') ?? false,
  })
  const solana = new SolanaTxEngine({ store: txStore, getRpc: getSolanaRpc, programErrors: solanaProgramErrorName })
  const sui = new SuiTxEngine({ store: txStore, getClient: getSuiClient })
  const siwe = createSiweClient({ baseUrl: apiBaseUrl, statement: 'Sign in to OmniMarket.' })

  return { manager, txStore, evm, solana, sui, siwe, walletConnect }
}
