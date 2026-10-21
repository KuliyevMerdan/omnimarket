import type { WalletError } from './errors'

/** CAIP-2 namespaces this SDK knows how to talk to. */
export type ChainNamespace = 'eip155' | 'solana' | 'sui'

/** CAIP-2 chain id, e.g. `eip155:1`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, `sui:mainnet`. */
export type CaipChainId = `${string}:${string}`

/** CAIP-10 account id, e.g. `eip155:1:0xab16…`. */
export type CaipAccountId = `${string}:${string}:${string}`

export type WalletSource = 'eip6963' | 'legacy-injected' | 'wallet-standard' | 'walletconnect'

export interface WalletInfo {
  /** Stable across page loads — used to persist the last connected wallet. */
  readonly id: string
  readonly name: string
  /** Sanitized `data:image/*` URI or an empty string. Render it only via `<img src>`. */
  readonly icon: string
  readonly namespace: ChainNamespace
  readonly source: WalletSource
  readonly rdns?: string
}

export interface Connection {
  /** CAIP-10 ids; the first one is the active account. */
  readonly accounts: readonly CaipAccountId[]
  readonly chainId: CaipChainId
}

export type ConnectorEvent =
  | { readonly type: 'change'; readonly connection: Connection }
  | { readonly type: 'disconnect'; readonly error?: WalletError }

export interface ConnectOptions {
  /** Ask the wallet to switch to this chain after connecting. Failure to switch does not fail the connect. */
  readonly chainId?: CaipChainId
  /** Do not prompt the user: only restore an already authorized session (`eth_accounts` on EVM). */
  readonly silent?: boolean
}

/**
 * One wallet in one ecosystem. Chain-specific capabilities (typed data, transactions)
 * live on the concrete connector classes; this is the common denominator.
 */
export interface WalletConnector {
  readonly info: WalletInfo
  connect(options?: ConnectOptions): Promise<Connection>
  disconnect(): Promise<void>
  signMessage(params: { account: CaipAccountId; message: string }): Promise<string>
  switchChain?(chainId: CaipChainId): Promise<void>
  subscribe(listener: (event: ConnectorEvent) => void): () => void
}

/** Discovers wallets of a single ecosystem (EIP-6963, Wallet Standard, WalletConnect…). */
export interface ChainAdapter {
  readonly namespace: ChainNamespace
  /**
   * Starts discovery. `onChange` receives the full current list every time it changes;
   * connector instances must stay referentially stable for the same wallet.
   * Returns a function that stops discovery.
   */
  discover(onChange: (connectors: readonly WalletConnector[]) => void): () => void
}

export type WalletStatus = 'disconnected' | 'connecting' | 'reconnecting' | 'connected'

export interface WalletState {
  readonly status: WalletStatus
  readonly wallets: readonly WalletInfo[]
  readonly activeWalletId: string | null
  readonly connection: Connection | null
  readonly error: WalletError | null
}
