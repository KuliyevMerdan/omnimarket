import { createSiweClient, type SiweClient } from '@omnimarket/auth/client'
import { omniMarketAbi, omniNftAbi } from '@omnimarket/contracts'
import type { ReviewGate } from '@omnimarket/guard'
import { TxEngine, TxStore, lazyEngine, type LazyEngine, type SolanaTxEngine, type SuiTxEngine } from '@omnimarket/tx-engine'
import { WalletManager, parseChainId } from '@omnimarket/wallet-core'
import { createEvmAdapter } from '@omnimarket/wallet-core/evm'
import { createSolanaAdapter } from '@omnimarket/wallet-core/solana'
import { createSuiAdapter } from '@omnimarket/wallet-core/sui'
import type { WalletConnect } from '@omnimarket/wallet-core/walletconnect'
import { SUPPORTED_CHAINS } from './chains'
import { getPublicClient } from './clients'
import { createAppGuard } from './guard'
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
  /** Loaded with @solana/kit on first use (a Solana wallet connects, or Solana transactions are pending). */
  readonly solana: LazyEngine<SolanaTxEngine>
  /** Loaded with @mysten/sui on first use. */
  readonly sui: LazyEngine<SuiTxEngine>
  readonly siwe: SiweClient
  readonly walletConnect: WalletConnect | null
  /** Security reviews raised by the EVM provider middleware; render with `<omni-risk-review>`. */
  readonly guard: ReviewGate
}

export interface OmniCoreOptions {
  /** Same-origin API prefix (the dev servers proxy it), so the session cookie stays first-party. */
  readonly apiBaseUrl?: string
}

/** Composition root. Call once per page, outside any component tree. */
export function createOmniCore({ apiBaseUrl = '/api' }: OmniCoreOptions = {}): OmniCore {
  // EIP-6963 for EVM; Solana and Sui share the Wallet Standard registry; WalletConnect adds one
  // relay-backed connector per namespace, all on a single session.
  // Every EVM request that signs is decoded and checked before a wallet sees it.
  const guard = createAppGuard()
  const walletConnect = createAppWalletConnect(guard.wrapProvider)
  const manager = new WalletManager({
    adapters: [
      createEvmAdapter({ chains: SUPPORTED_CHAINS, wrapProvider: guard.wrapProvider }),
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
  const solana = lazyEngine({ namespace: 'solana', store: txStore, load: () => import('./solana').then((m) => m.createSolanaEngine(txStore)) })
  const sui = lazyEngine({ namespace: 'sui', store: txStore, load: () => import('./sui').then((m) => m.createSuiEngine(txStore)) })
  // Start fetching a chain's SDK as soon as its wallet connects, not when its page first renders.
  manager.subscribe(() => {
    const chainId = manager.getState().connection?.chainId
    const namespace = chainId && parseChainId(chainId).namespace
    if (namespace === 'solana' || namespace === 'sui') void (namespace === 'solana' ? solana : sui).load().catch(() => {})
  })
  const siwe = createSiweClient({ baseUrl: apiBaseUrl, statement: 'Sign in to OmniMarket.' })

  return { manager, txStore, evm, solana, sui, siwe, walletConnect, guard: guard.gate }
}
