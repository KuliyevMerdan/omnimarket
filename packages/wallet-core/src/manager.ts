import { WalletError, toWalletError } from './errors'
import { createBrowserStorage, type KeyValueStorage } from './storage'
import { createStore, type ReadableStore } from './store'
import type {
  CaipAccountId,
  CaipChainId,
  ChainAdapter,
  ConnectOptions,
  Connection,
  ConnectorEvent,
  WalletConnector,
  WalletState,
} from './types'

export interface WalletManagerOptions {
  readonly adapters: readonly ChainAdapter[]
  readonly storage?: KeyValueStorage
  readonly storageKey?: string
  /** How long to wait for the previously used wallet to be discovered before giving up. */
  readonly reconnectTimeoutMs?: number
}

const INITIAL_STATE: WalletState = {
  status: 'disconnected',
  wallets: [],
  activeWalletId: null,
  connection: null,
  error: null,
}

interface ActiveConnection {
  readonly connector: WalletConnector
  readonly unsubscribe: () => void
}

/**
 * Framework-agnostic orchestrator over all chain adapters: aggregates discovered wallets,
 * owns the single active connection, persists it, and silently restores it on load.
 */
export class WalletManager implements ReadableStore<WalletState> {
  readonly #store = createStore<WalletState>(INITIAL_STATE)
  readonly #adapters: readonly ChainAdapter[]
  readonly #storage: KeyValueStorage
  readonly #storageKey: string
  readonly #reconnectTimeoutMs: number

  readonly #connectorsByAdapter = new Map<ChainAdapter, readonly WalletConnector[]>()
  #connectors = new Map<string, WalletConnector>()
  #active: ActiveConnection | null = null

  /** Incremented on every connect/disconnect; stale async results compare against it and bail. */
  #attempt = 0
  #pendingReconnectId: string | null = null
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined
  #startCount = 0
  #stopDiscovery: (() => void)[] = []

  constructor(options: WalletManagerOptions) {
    this.#adapters = options.adapters
    this.#storage = options.storage ?? createBrowserStorage()
    this.#storageKey = options.storageKey ?? 'omni:last-wallet'
    this.#reconnectTimeoutMs = options.reconnectTimeoutMs ?? 3000
  }

  getState = (): WalletState => this.#store.getState()

  subscribe = (listener: () => void): (() => void) => this.#store.subscribe(listener)

  /**
   * Starts discovery and auto-reconnect. Ref-counted, so it is safe under React StrictMode
   * double effects and with several mounted roots. Returns the matching stop function.
   */
  start(): () => void {
    if (this.#startCount++ === 0) this.#startDiscovery()
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      if (--this.#startCount === 0) this.#stopAll()
    }
  }

  getConnector(walletId: string): WalletConnector | undefined {
    return this.#connectors.get(walletId)
  }

  getActiveConnector(): WalletConnector | null {
    return this.#active?.connector ?? null
  }

  connect(walletId: string, options: ConnectOptions = {}): Promise<Connection> {
    return this.#connect(walletId, options)
  }

  async disconnect(): Promise<void> {
    this.#attempt++
    this.#cancelPendingReconnect()
    const active = this.#active
    this.#detachActive()
    this.#storage.removeItem(this.#storageKey)
    this.#store.setState({ status: 'disconnected', activeWalletId: null, connection: null, error: null })
    await active?.connector.disconnect().catch(() => {})
  }

  /** Signs with the active account unless another connected account is given. */
  async signMessage(message: string, account?: CaipAccountId): Promise<string> {
    const { connector, connection } = this.#requireActive()
    const signer = account ?? connection.accounts[0]!
    if (!connection.accounts.includes(signer)) {
      throw new WalletError('ACCOUNT_MISMATCH', `Account ${signer} is not connected`)
    }
    try {
      return await connector.signMessage({ account: signer, message })
    } catch (error) {
      throw toWalletError(error)
    }
  }

  async switchChain(chainId: CaipChainId): Promise<void> {
    const { connector } = this.#requireActive()
    if (!connector.switchChain) {
      throw new WalletError('UNSUPPORTED_METHOD', `${connector.info.name} cannot switch chains`)
    }
    try {
      await connector.switchChain(chainId)
    } catch (error) {
      throw toWalletError(error)
    }
  }

  async #connect(walletId: string, options: ConnectOptions): Promise<Connection> {
    const connector = this.#connectors.get(walletId)
    if (!connector) throw new WalletError('WALLET_NOT_FOUND', `Wallet ${walletId} is not available`)

    const attempt = ++this.#attempt
    this.#cancelPendingReconnect()
    this.#store.setState({ status: options.silent ? 'reconnecting' : 'connecting', error: null })

    try {
      const connection = await connector.connect(options)
      if (attempt !== this.#attempt) return connection // superseded by a newer connect/disconnect

      const previous = this.#active
      if (previous?.connector !== connector) {
        this.#detachActive()
        void previous?.connector.disconnect().catch(() => {})
        this.#active = {
          connector,
          unsubscribe: connector.subscribe((event) => this.#onConnectorEvent(connector, event)),
        }
      }
      this.#storage.setItem(this.#storageKey, walletId)
      this.#store.setState({ status: 'connected', activeWalletId: walletId, connection, error: null })
      return connection
    } catch (cause) {
      const error = toWalletError(cause)
      if (attempt === this.#attempt) {
        if (options.silent) this.#storage.removeItem(this.#storageKey)
        // A failed attempt to switch wallets keeps the previous session alive.
        const shownError = options.silent ? null : error
        this.#store.setState(
          this.#active
            ? { status: 'connected', error: shownError }
            : { status: 'disconnected', activeWalletId: null, connection: null, error: shownError },
        )
      }
      throw error
    }
  }

  #onConnectorEvent(connector: WalletConnector, event: ConnectorEvent): void {
    if (this.#active?.connector !== connector) return
    if (event.type === 'change') {
      this.#store.setState({ connection: event.connection })
      return
    }
    // The wallet ended the session (user locked it or revoked access).
    this.#attempt++
    this.#detachActive()
    this.#storage.removeItem(this.#storageKey)
    this.#store.setState({
      status: 'disconnected',
      activeWalletId: null,
      connection: null,
      error: event.error ?? null,
    })
  }

  #startDiscovery(): void {
    const lastWalletId = this.#storage.getItem(this.#storageKey)
    // `!this.#active` rather than a status check: a StrictMode stop/start cycle can leave us in "reconnecting".
    if (lastWalletId && !this.#active) {
      this.#pendingReconnectId = lastWalletId
      this.#store.setState({ status: 'reconnecting' })
      // Extensions can inject late; don't keep the UI in "reconnecting" forever.
      this.#reconnectTimer = setTimeout(() => {
        if (this.#pendingReconnectId === null) return
        this.#pendingReconnectId = null
        if (this.getState().status === 'reconnecting') this.#store.setState({ status: 'disconnected' })
      }, this.#reconnectTimeoutMs)
    }

    for (const adapter of this.#adapters) {
      this.#stopDiscovery.push(adapter.discover((connectors) => this.#onConnectors(adapter, connectors)))
    }
  }

  #onConnectors(adapter: ChainAdapter, connectors: readonly WalletConnector[]): void {
    this.#connectorsByAdapter.set(adapter, connectors)
    const next = new Map<string, WalletConnector>()
    for (const list of this.#connectorsByAdapter.values()) {
      for (const connector of list) if (!next.has(connector.info.id)) next.set(connector.info.id, connector)
    }
    this.#connectors = next
    this.#store.setState({ wallets: [...next.values()].map((c) => c.info) })

    const pending = this.#pendingReconnectId
    if (pending && next.has(pending)) {
      this.#connect(pending, { silent: true }).catch(() => {})
    }
  }

  #requireActive(): { connector: WalletConnector; connection: Connection } {
    const connection = this.getState().connection
    if (!this.#active || !connection || connection.accounts.length === 0) {
      throw new WalletError('NOT_CONNECTED', 'No wallet is connected')
    }
    return { connector: this.#active.connector, connection }
  }

  #cancelPendingReconnect(): void {
    this.#pendingReconnectId = null
    clearTimeout(this.#reconnectTimer)
  }

  #detachActive(): void {
    this.#active?.unsubscribe()
    this.#active = null
  }

  #stopAll(): void {
    this.#cancelPendingReconnect()
    for (const stop of this.#stopDiscovery.splice(0)) stop()
    this.#connectorsByAdapter.clear()
  }
}
