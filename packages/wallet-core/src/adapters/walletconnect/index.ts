import type { ClientWithCoreApi } from '@mysten/sui/client'
import type { Chain, Transport } from 'viem'
import { evmChainId } from '../../caip'
import type { CaipChainId, ChainAdapter, ChainNamespace, WalletConnector, WalletInfo } from '../../types'
import { Eip1193Connector } from '../evm/connector'
import type { ProviderWrapper } from '../evm'
import { SolanaConnector } from '../solana/connector'
import { SuiConnector } from '../sui/connector'
import type { StandardChainList } from '../wallet-standard/connector'
import { createWalletConnectEip1193Provider } from './evm'
import type { RequestedChains } from './namespaces'
import { WalletConnectSession, type WalletConnectSessionOptions } from './session'
import { WALLETCONNECT_ICON, createWalletConnectSolanaWallet, createWalletConnectSuiWallet } from './standard'

export { createWalletConnectEip1193Provider, type WalletConnectEip1193Options } from './evm'
export { MOBILE_WALLETS, isMobileBrowser, pairingLink, safeDeepLink, type MobileWallet } from './links'
export {
  WC_EVENTS,
  WC_METHODS,
  addressesOn,
  buildOptionalNamespaces,
  parseApprovedNamespaces,
  type ApprovedNamespace,
  type ApprovedNamespaces,
  type RequestedChains,
  type SessionNamespaces,
} from './namespaces'
export {
  WalletConnectSession,
  type WalletConnectClient,
  type WalletConnectMetadata,
  type WalletConnectPeer,
  type WalletConnectSessionEvent,
  type WalletConnectSessionOptions,
  type WalletConnectSessionStruct,
  type WalletConnectState,
  type WalletConnectStatus,
} from './session'
export { WALLETCONNECT_ICON } from './standard'

export interface WalletConnectOptions extends Omit<WalletConnectSessionOptions, 'chains'> {
  readonly eip155?: {
    readonly chains: readonly [Chain, ...Chain[]]
    readonly transport?: (chain: Chain) => Transport
    /** Same as the EVM adapter's `wrapProvider`: requests over the relay pass the same checks. */
    readonly wrapProvider?: ProviderWrapper
  }
  readonly solana?: { readonly chains: StandardChainList }
  readonly sui?: { readonly chains: StandardChainList; readonly getClient: (chain: CaipChainId) => ClientWithCoreApi | Promise<ClientWithCoreApi> }
}

export interface WalletConnect {
  readonly session: WalletConnectSession
  /** One adapter per configured namespace; all share `session`. Pass them to `WalletManager`. */
  readonly adapters: readonly ChainAdapter[]
}

/** Stable wallet id of the WalletConnect connector for a namespace, e.g. `solana:walletconnect`. */
export function walletConnectId(namespace: ChainNamespace): string {
  return `${namespace}:walletconnect`
}

/**
 * WalletConnect v2 as "just more connectors": the session proposes every configured namespace at
 * once, and each namespace gets a regular connector (`Eip1193Connector`, `SolanaConnector`,
 * `SuiConnector`). Nothing above the connectors knows the wallet is on a phone.
 */
export function createWalletConnect(options: WalletConnectOptions): WalletConnect {
  const chains: RequestedChains = {
    ...(options.eip155 && { eip155: options.eip155.chains.map((c) => evmChainId(c.id)) }),
    ...(options.solana && { solana: options.solana.chains.map((c) => c.caip) }),
    ...(options.sui && { sui: options.sui.chains.map((c) => c.caip) }),
  }
  const session = new WalletConnectSession({ ...options, chains })
  const adapters: ChainAdapter[] = []

  if (options.eip155) {
    const { chains: evmChains, transport, wrapProvider } = options.eip155
    adapters.push(
      single('eip155', () => {
        const info: WalletInfo = { id: walletConnectId('eip155'), name: 'WalletConnect', icon: WALLETCONNECT_ICON, namespace: 'eip155', source: 'walletconnect' }
        const provider = createWalletConnectEip1193Provider({ session, chains: evmChains, transport })
        return new Eip1193Connector({ provider: wrapProvider?.(provider, info) ?? provider, chains: evmChains, info })
      }),
    )
  }
  if (options.solana) {
    const { chains: solanaChains } = options.solana
    adapters.push(
      single('solana', () =>
        new SolanaConnector(createWalletConnectSolanaWallet({ session, chains: solanaChains }), solanaChains, { source: 'walletconnect' }),
      ),
    )
  }
  if (options.sui) {
    const { chains: suiChains, getClient } = options.sui
    adapters.push(
      single('sui', () =>
        new SuiConnector(createWalletConnectSuiWallet({ session, chains: suiChains, getClient }), suiChains, { source: 'walletconnect' }),
      ),
    )
  }
  return { session, adapters }
}

/** WalletConnect needs no discovery: the connector exists as soon as the adapter starts. */
function single(namespace: ChainNamespace, create: () => WalletConnector): ChainAdapter {
  let connector: WalletConnector | null = null
  return {
    namespace,
    discover(onChange) {
      connector ??= create()
      onChange([connector])
      return () => {}
    },
  }
}
