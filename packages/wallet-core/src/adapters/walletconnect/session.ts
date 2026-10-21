import { parseChainId } from '../../caip'
import { WalletError, toWalletError } from '../../errors'
import { createStore, type ReadableStore } from '../../store'
import type { CaipChainId, ChainNamespace } from '../../types'
import { isMobileBrowser, openDeepLink, safeDeepLink } from './links'
import {
  buildOptionalNamespaces,
  parseApprovedNamespaces,
  type ApprovedNamespaces,
  type ProposalNamespace,
  type RequestedChains,
  type SessionNamespaces,
} from './namespaces'

/** The settled session as the SignClient stores it (structural subset of `SessionTypes.Struct`). */
export interface WalletConnectSessionStruct {
  readonly topic: string
  /** Unix seconds. */
  readonly expiry: number
  readonly namespaces: SessionNamespaces
  readonly sessionProperties?: Record<string, string>
  readonly peer: { readonly metadata: WalletConnectMetadata }
}

export interface WalletConnectMetadata {
  readonly name: string
  readonly description: string
  readonly url: string
  readonly icons: readonly string[]
  readonly redirect?: { readonly native?: string; readonly universal?: string }
}

/**
 * The part of `@walletconnect/sign-client` we use. Everything goes through this seam, so the real
 * client is loaded lazily (it is the heaviest dependency of the SDK) and tests or the in-browser mock
 * wallet can stand in for the relay.
 */
export interface WalletConnectClient {
  connect(params: {
    optionalNamespaces: Record<string, ProposalNamespace>
  }): Promise<{ uri?: string; approval(): Promise<WalletConnectSessionStruct> }>
  request<T>(params: { topic: string; chainId: string; request: { method: string; params: unknown }; expiry?: number }): Promise<T>
  disconnect(params: { topic: string; reason: { code: number; message: string } }): Promise<void>
  readonly session: { getAll(): WalletConnectSessionStruct[] }
  on(event: string, listener: (args: any) => void): unknown
  off(event: string, listener: (args: any) => void): unknown
  readonly core?: { readonly relayer?: { readonly connected?: boolean; restartTransport?(): Promise<void> } }
}

export type WalletConnectStatus = 'idle' | 'initializing' | 'pairing' | 'connected'

export interface WalletConnectPeer {
  /** Self-reported by the wallet: display only, never proof of identity. */
  readonly name: string
  readonly url: string
  /** Sanitized deep link back into the wallet app, if it gave one. */
  readonly redirect: string | null
}

export interface WalletConnectState {
  readonly status: WalletConnectStatus
  /** Pairing URI to show as a QR code or pass to a wallet link, while `status === 'pairing'`. */
  readonly uri: string | null
  readonly peer: WalletConnectPeer | null
  readonly namespaces: ApprovedNamespaces
  /** Session expiry, ms since epoch. */
  readonly expiresAt: number | null
  readonly error: WalletError | null
}

export type WalletConnectSessionEvent =
  | { readonly type: 'update' }
  | { readonly type: 'end' }
  | { readonly type: 'event'; readonly namespace: ChainNamespace; readonly chainId: CaipChainId; readonly name: string; readonly data: unknown }

export interface WalletConnectSessionOptions {
  readonly projectId: string
  readonly metadata: WalletConnectMetadata
  readonly chains: RequestedChains
  readonly relayUrl?: string
  /** Replaces the real SignClient: tests, or the in-browser mock wallet in development. */
  readonly createClient?: () => Promise<WalletConnectClient>
  /**
   * After sending a request, bring the wallet app to the front. `auto` (default) does it on mobile
   * browsers when the wallet gave a redirect link; a function receives that link instead.
   */
  readonly openWallet?: 'auto' | 'never' | ((link: string) => void)
  /** Seconds a request waits for the wallet. WalletConnect enforces 300–604800. */
  readonly requestExpirySeconds?: number
  readonly now?: () => number
}

const INITIAL: WalletConnectState = { status: 'idle', uri: null, peer: null, namespaces: {}, expiresAt: null, error: null }
const USER_DISCONNECTED = { code: 6000, message: 'User disconnected.' }
/** Don't restore a session that would expire mid-flow. */
const MIN_REMAINING_MS = 60_000

/**
 * One WalletConnect session shared by every namespace: a single QR scan gives EVM, Solana and Sui
 * connectors at once (whatever the wallet approved). Connectors `attach` while they use the session
 * and `detach` when the app disconnects them; the session itself ends when the last one detaches,
 * when the wallet deletes it, or when it expires.
 */
export class WalletConnectSession implements ReadableStore<WalletConnectState> {
  readonly #store = createStore<WalletConnectState>(INITIAL)
  readonly #options: WalletConnectSessionOptions
  readonly #listeners = new Set<(event: WalletConnectSessionEvent) => void>()
  readonly #attached = new Set<ChainNamespace>()
  #client: Promise<WalletConnectClient> | null = null
  #init: Promise<void> | null = null
  #topic: string | null = null
  #pairing: Promise<ApprovedNamespaces> | null = null
  #cancelPairing: ((error: WalletError) => void) | null = null
  /** Bumped by every pairing start/cancel: a late approval for a cancelled proposal is disconnected. */
  #pairingId = 0

  constructor(options: WalletConnectSessionOptions) {
    this.#options = options
  }

  getState = (): WalletConnectState => this.#store.getState()
  subscribe = (listener: () => void): (() => void) => this.#store.subscribe(listener)

  get chains(): RequestedChains {
    return this.#options.chains
  }

  onEvent(listener: (event: WalletConnectSessionEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Loads the client and restores a stored session. Safe to call many times. */
  init(): Promise<void> {
    this.#init ??= this.#restore().catch((error) => {
      this.#init = null
      this.#store.setState({ status: 'idle', error: toWalletError(error) })
      throw toWalletError(error)
    })
    return this.#init
  }

  /**
   * Returns the approved namespaces, pairing first if there is no session. Concurrent callers (three
   * connectors, a double click) share one proposal and one QR code.
   */
  async pair(): Promise<ApprovedNamespaces> {
    await this.init()
    if (this.#topic) return this.getState().namespaces
    this.#pairing ??= this.#startPairing().finally(() => {
      this.#pairing = null
    })
    return this.#pairing
  }

  /** The user closed the QR dialog. A wallet approving later gets disconnected right away. */
  cancelPairing(): void {
    if (!this.#cancelPairing) return
    this.#cancelPairing(new WalletError('USER_REJECTED', 'Connection request cancelled'))
  }

  attach(namespace: ChainNamespace): void {
    if (!this.getState().namespaces[namespace]) {
      throw new WalletError('UNRECOGNIZED_CHAIN', `${this.getState().peer?.name ?? 'The wallet'} did not approve ${namespace}`)
    }
    this.#attached.add(namespace)
  }

  /** The app stopped using this namespace; ends the session if nothing else uses it. */
  async detach(namespace: ChainNamespace): Promise<void> {
    if (!this.#attached.delete(namespace)) return
    if (this.#attached.size === 0) await this.disconnect()
  }

  async disconnect(): Promise<void> {
    const topic = this.#topic
    this.cancelPairing()
    if (!topic) return
    this.#end(topic)
    const client = await this.#client
    await client?.disconnect({ topic, reason: USER_DISCONNECTED }).catch(() => {})
  }

  /**
   * Sends a JSON-RPC request to the wallet. Chain and method must be in what the wallet approved;
   * we check locally first, so the user never gets a request the wallet would reject unseen.
   */
  async request<T>(namespace: ChainNamespace, chainId: CaipChainId, method: string, params: unknown): Promise<T> {
    const topic = this.#topic
    const { namespaces, peer } = this.getState()
    const approved = namespaces[namespace]
    if (!topic || !approved) throw new WalletError('NOT_CONNECTED', 'No WalletConnect session for this chain')
    if (!approved.chains.includes(chainId)) {
      throw new WalletError('UNRECOGNIZED_CHAIN', `${peer?.name ?? 'The wallet'} did not approve ${chainId}`)
    }
    if (!approved.methods.has(method)) {
      throw new WalletError('UNSUPPORTED_METHOD', `${peer?.name ?? 'The wallet'} did not approve ${method}`)
    }
    const client = await this.#getClient()
    this.#openWalletAfterPublish(client, topic, peer?.redirect ?? null)
    const pending = client.request<T>({
      topic,
      chainId,
      request: { method, params },
      expiry: this.#options.requestExpirySeconds,
    })
    try {
      return await pending
    } catch (error) {
      throw toSessionError(error)
    }
  }

  async #restore(): Promise<void> {
    this.#store.setState({ status: 'initializing', error: null })
    const client = await this.#getClient()
    const now = this.#now()
    const sessions = [...client.session.getAll()].sort((a, b) => b.expiry - a.expiry)

    let adopted = false
    for (const session of sessions) {
      if (!adopted && session.expiry * 1000 - now > MIN_REMAINING_MS && this.#adopt(session)) adopted = true
      // Stale or unusable sessions would stay listed as "connected" in the wallet for days.
      else void client.disconnect({ topic: session.topic, reason: USER_DISCONNECTED }).catch(() => {})
    }
    if (!adopted) this.#store.setState({ status: 'idle' })
  }

  async #startPairing(): Promise<ApprovedNamespaces> {
    const id = ++this.#pairingId
    const client = await this.#getClient()
    const cancelled = new Promise<never>((_, reject) => {
      this.#cancelPairing = (error) => {
        this.#pairingId++
        reject(error)
      }
    })
    this.#store.setState({ status: 'pairing', uri: null, error: null })

    try {
      const { uri, approval } = await Promise.race([client.connect({ optionalNamespaces: buildOptionalNamespaces(this.chains) }), cancelled])
      if (uri) this.#store.setState({ uri })
      const pendingApproval = approval()
      const session = await Promise.race([pendingApproval, cancelled]).catch((error: unknown) => {
        // The proposal can still be approved after a cancel: don't leave that session open in the wallet.
        void pendingApproval.then((late) => client.disconnect({ topic: late.topic, reason: USER_DISCONNECTED })).catch(() => {})
        throw error
      })
      if (id !== this.#pairingId) throw new WalletError('USER_REJECTED', 'Connection request cancelled')
      if (!this.#adopt(session)) {
        void client.disconnect({ topic: session.topic, reason: USER_DISCONNECTED }).catch(() => {})
        throw new WalletError(
          'UNSUPPORTED_METHOD',
          `${sanitizeName(session.peer.metadata.name)} did not approve any chain this app supports`,
        )
      }
      return this.getState().namespaces
    } catch (cause) {
      const error = toSessionError(cause)
      if (!this.#topic) {
        // A user cancel is not an error to show.
        this.#store.setState({ status: 'idle', uri: null, error: error.code === 'USER_REJECTED' ? null : error })
      }
      throw error
    } finally {
      this.#cancelPairing = null
    }
  }

  /** Validates and takes over a settled session. Returns false if nothing in it is usable. */
  #adopt(session: WalletConnectSessionStruct): boolean {
    const namespaces = parseApprovedNamespaces(session.namespaces, this.chains)
    if (Object.keys(namespaces).length === 0) return false
    const metadata = session.peer?.metadata
    this.#topic = session.topic
    this.#store.setState({
      status: 'connected',
      uri: null,
      error: null,
      namespaces,
      expiresAt: session.expiry * 1000,
      peer: {
        name: sanitizeName(metadata?.name),
        url: typeof metadata?.url === 'string' ? metadata.url.slice(0, 256) : '',
        redirect: safeDeepLink(metadata?.redirect?.native) ?? safeDeepLink(metadata?.redirect?.universal),
      },
    })
    this.#emit({ type: 'update' })
    return true
  }

  #end(topic: string): void {
    if (topic !== this.#topic) return
    this.#topic = null
    this.#attached.clear()
    this.#store.setState({ ...INITIAL })
    this.#emit({ type: 'end' })
  }

  #getClient(): Promise<WalletConnectClient> {
    this.#client ??= (this.#options.createClient?.() ?? loadSignClient(this.#options)).then((client) => {
      this.#listen(client)
      return client
    })
    this.#client.catch(() => {
      this.#client = null
    })
    return this.#client
  }

  #listen(client: WalletConnectClient): void {
    client.on('session_update', ({ topic, params }: { topic: string; params: { namespaces: SessionNamespaces } }) => {
      if (topic !== this.#topic) return
      const namespaces = parseApprovedNamespaces(params.namespaces, this.chains)
      if (Object.keys(namespaces).length === 0) {
        void this.disconnect()
        return
      }
      this.#store.setState({ namespaces })
      this.#emit({ type: 'update' })
    })
    client.on('session_event', ({ topic, params }: { topic: string; params: { chainId: string; event: { name: string; data: unknown } } }) => {
      if (topic !== this.#topic) return
      const chainId = params.chainId as CaipChainId
      let namespace: ChainNamespace
      try {
        namespace = parseChainId(chainId).namespace as ChainNamespace
      } catch {
        return
      }
      const approved = this.getState().namespaces[namespace]
      if (!approved?.events.has(params.event?.name)) return
      this.#emit({ type: 'event', namespace, chainId, name: params.event.name, data: params.event.data })
    })
    client.on('session_delete', ({ topic }: { topic: string }) => this.#end(topic))
    client.on('session_expire', ({ topic }: { topic: string }) => this.#end(topic))

    // Mobile browsers kill the relay WebSocket of a background tab, exactly while the user approves in
    // the wallet app. Reopen it as soon as the tab is visible again so the response is picked up.
    const relayer = client.core?.relayer
    if (relayer?.restartTransport && typeof document !== 'undefined') {
      const revive = () => {
        if (document.visibilityState !== 'visible' || relayer.connected !== false) return
        void relayer.restartTransport!().catch(() => {})
      }
      document.addEventListener('visibilitychange', revive)
      globalThis.addEventListener?.('online', revive)
    }
  }

  /**
   * Brings the wallet app forward once the request is on the relay: switching apps first would
   * background this tab, and mobile browsers may freeze it before the request is published.
   */
  #openWalletAfterPublish(client: WalletConnectClient, topic: string, redirect: string | null): void {
    const mode = this.#options.openWallet ?? 'auto'
    if (!redirect || mode === 'never' || (mode === 'auto' && !isMobileBrowser())) return
    let done = false
    const open = () => {
      if (done) return
      done = true
      client.off('session_request_sent', onSent)
      clearTimeout(fallback)
      if (typeof mode === 'function') mode(redirect)
      else openDeepLink(redirect)
    }
    const onSent = (event: { topic: string }) => {
      if (event.topic === topic) open()
    }
    client.on('session_request_sent', onSent)
    const fallback = setTimeout(open, 1000)
  }

  #emit(event: WalletConnectSessionEvent): void {
    for (const listener of [...this.#listeners]) listener(event)
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now()
  }
}

async function loadSignClient(options: WalletConnectSessionOptions): Promise<WalletConnectClient> {
  if (!options.projectId) throw new WalletError('WALLET_NOT_FOUND', 'WalletConnect is not configured (missing project id)')
  const { SignClient } = await import('@walletconnect/sign-client')
  const client = await SignClient.init({
    projectId: options.projectId,
    relayUrl: options.relayUrl,
    metadata: { ...options.metadata, icons: [...options.metadata.icons] },
    // Telemetry is opt-in for us: the user's wallet activity is nobody else's business.
    telemetryEnabled: false,
  })
  return client as unknown as WalletConnectClient
}

/** WalletConnect errors are plain `Error`s or `{ code, message }` objects; timeouts only have a message. */
function toSessionError(error: unknown): WalletError {
  const wallet = toWalletError(error)
  if (wallet.code === 'UNKNOWN' && /expired|timed? ?out/i.test(wallet.message)) {
    return new WalletError('TIMEOUT', 'The wallet did not respond in time', { cause: error })
  }
  return wallet
}

function sanitizeName(name: unknown): string {
  // Display text only (React escapes it); still, no control characters or bidi overrides.
  const clean = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim() : ''
  return clean.slice(0, 64) || 'Wallet'
}
