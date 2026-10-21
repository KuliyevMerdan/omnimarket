import type { IdentifierString, Wallet, WalletAccount } from '@wallet-standard/base'
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
} from '@wallet-standard/features'
import { parseAccountId, toAccountId } from '../../caip'
import { WalletError, toWalletError } from '../../errors'
import { sanitizeWalletIcon } from '../../icons'
import type {
  CaipAccountId,
  CaipChainId,
  ChainNamespace,
  ConnectOptions,
  Connection,
  ConnectorEvent,
  WalletConnector,
  WalletInfo,
} from '../../types'

/**
 * A dApp chain as two ids: our CAIP-2 id and the Wallet Standard identifier. They differ for Solana
 * (`solana:5eykt4…` vs `solana:mainnet`) and match for Sui (`sui:mainnet`).
 */
export interface StandardChain {
  readonly caip: CaipChainId
  readonly standard: IdentifierString
  readonly name: string
}

export type StandardChainList = readonly [StandardChain, ...StandardChain[]]

export interface WalletStandardConnectorOptions {
  readonly namespace: Extract<ChainNamespace, 'solana' | 'sui'>
  readonly chains: StandardChainList
  /** How the wallet was found; `walletconnect` for the relay-backed wallets. */
  readonly source?: WalletInfo['source']
}

/**
 * Connection lifecycle shared by every Wallet Standard ecosystem: `standard:connect` / `disconnect` /
 * `events`, account filtering, and dApp-side chain selection. Wallet Standard has no
 * "switch chain" request: the chain is a parameter of every signing call, so switching is local,
 * limited to chains the wallet declares.
 */
export abstract class WalletStandardConnector implements WalletConnector {
  readonly info: WalletInfo
  readonly wallet: Wallet
  protected readonly namespace: 'solana' | 'sui'
  protected readonly chains: readonly [StandardChain, ...StandardChain[]]
  protected chain: StandardChain
  #accounts: readonly WalletAccount[] = []
  readonly #listeners = new Set<(event: ConnectorEvent) => void>()
  #detach: (() => void) | null = null

  constructor(wallet: Wallet, { namespace, chains, source = 'wallet-standard' }: WalletStandardConnectorOptions) {
    this.wallet = wallet
    this.namespace = namespace
    this.chains = chains
    this.chain = chains.find((c) => wallet.chains.includes(c.standard)) ?? chains[0]
    this.info = {
      id: `${namespace}:${slug(wallet.name)}`,
      name: wallet.name.slice(0, 64),
      icon: sanitizeWalletIcon(wallet.icon),
      namespace,
      source,
    }
  }

  get activeChain(): StandardChain {
    return this.chain
  }

  async connect({ chainId, silent = false }: ConnectOptions = {}): Promise<Connection> {
    const feature = this.wallet.features[StandardConnect] as StandardConnectFeature[typeof StandardConnect] | undefined
    if (!feature) throw new WalletError('UNSUPPORTED_METHOD', `${this.wallet.name} does not support connect`)
    try {
      const { accounts } = await feature.connect({ silent })
      this.#accounts = this.#ownAccounts(accounts)
    } catch (error) {
      throw toWalletError(error)
    }
    if (this.#accounts.length === 0) throw new WalletError('UNAUTHORIZED', 'Wallet returned no accounts for this chain')
    const wanted = chainId ? this.chains.find((c) => c.caip === chainId) : undefined
    if (wanted && this.wallet.chains.includes(wanted.standard)) this.chain = wanted
    // The wallet's chain list can change between discovery and connect (a WalletConnect session
    // approves a subset); never stay on a chain the wallet no longer declares.
    else if (!this.wallet.chains.includes(this.chain.standard)) {
      this.chain = this.chains.find((c) => this.wallet.chains.includes(c.standard)) ?? this.chain
    }
    this.#attach()
    return this.connection()
  }

  async disconnect(): Promise<void> {
    this.#detach?.()
    this.#detach = null
    this.#accounts = []
    const feature = this.wallet.features[StandardDisconnect] as StandardDisconnectFeature[typeof StandardDisconnect] | undefined
    await feature?.disconnect().catch(() => {})
  }

  async switchChain(chainId: CaipChainId): Promise<void> {
    const target = this.chains.find((c) => c.caip === chainId)
    if (!target) throw new WalletError('UNRECOGNIZED_CHAIN', `Chain ${chainId} is not configured in this dApp`)
    if (!this.wallet.chains.includes(target.standard)) {
      throw new WalletError('UNRECOGNIZED_CHAIN', `${this.wallet.name} does not support ${target.name}`)
    }
    if (target === this.chain) return
    this.chain = target
    if (this.#accounts.length > 0) this.#emit({ type: 'change', connection: this.connection() })
  }

  subscribe(listener: (event: ConnectorEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  abstract signMessage(params: { account: CaipAccountId; message: string }): Promise<string>

  protected connection(): Connection {
    return {
      chainId: this.chain.caip,
      accounts: this.#accounts.map((account) => toAccountId(this.chain.caip, account.address)),
    }
  }

  /** Resolves a CAIP-10 id to the wallet's account object, which signing features require. */
  protected walletAccount(account: CaipAccountId): WalletAccount {
    const { namespace, address } = parseAccountId(account)
    const match = namespace === this.namespace ? this.#accounts.find((a) => a.address === address) : undefined
    if (!match) throw new WalletError('ACCOUNT_MISMATCH', `Account ${account} is not connected to ${this.wallet.name}`)
    return match
  }

  protected feature<T>(name: string): T {
    const feature = this.wallet.features[name as IdentifierString] as T | undefined
    if (!feature) throw new WalletError('UNSUPPORTED_METHOD', `${this.wallet.name} does not support ${name}`)
    return feature
  }

  hasFeature(name: string): boolean {
    return name in this.wallet.features
  }

  #ownAccounts(accounts: readonly WalletAccount[]): readonly WalletAccount[] {
    // Multi-chain wallets return EVM and Bitcoin accounts here too; keep this namespace only.
    return accounts.filter((a) => a.chains.some((c) => c.startsWith(`${this.namespace}:`)))
  }

  #attach(): void {
    if (this.#detach) return
    const events = this.wallet.features[StandardEvents] as StandardEventsFeature[typeof StandardEvents] | undefined
    if (!events) return
    this.#detach = events.on('change', ({ accounts }) => {
      if (!accounts) return
      this.#accounts = this.#ownAccounts(accounts)
      this.#emit(this.#accounts.length === 0 ? { type: 'disconnect' } : { type: 'change', connection: this.connection() })
    })
  }

  #emit(event: ConnectorEvent): void {
    for (const listener of [...this.#listeners]) listener(event)
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'wallet'
}
