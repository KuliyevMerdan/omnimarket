import {
  createWalletClient,
  custom,
  getAddress,
  hexToNumber,
  isAddressEqual,
  numberToHex,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hex,
  type TypedData,
  type TypedDataDomain,
  type TypedDataDefinition,
  type WalletClient,
} from 'viem'
import { evmChainId, evmChainIdToNumber, parseAccountId, toAccountId } from '../../caip'
import { WalletError, toWalletError } from '../../errors'
import type {
  CaipAccountId,
  CaipChainId,
  ConnectOptions,
  Connection,
  ConnectorEvent,
  WalletConnector,
  WalletInfo,
} from '../../types'

export interface Eip1193ConnectorOptions {
  readonly info: WalletInfo
  readonly provider: EIP1193Provider
  /** Chains the dApp supports; used for `wallet_addEthereumChain` and viem clients. */
  readonly chains: readonly Chain[]
}

/** Any EIP-1193 provider: injected (EIP-6963 / `window.ethereum`) or, later, WalletConnect. */
export class Eip1193Connector implements WalletConnector {
  readonly info: WalletInfo
  readonly provider: EIP1193Provider
  readonly #chains: readonly Chain[]
  readonly #listeners = new Set<(event: ConnectorEvent) => void>()
  #accounts: Address[] = []
  #chainId: number | null = null
  #detachProvider: (() => void) | null = null

  constructor({ info, provider, chains }: Eip1193ConnectorOptions) {
    this.info = info
    this.provider = provider
    this.#chains = chains
  }

  get chainId(): number | null {
    return this.#chainId
  }

  async connect({ chainId, silent = false }: ConnectOptions = {}): Promise<Connection> {
    try {
      const accounts = (await this.provider.request({
        method: silent ? 'eth_accounts' : 'eth_requestAccounts',
      })) as string[]
      if (!accounts?.length) throw new WalletError('UNAUTHORIZED', 'Wallet returned no accounts')

      this.#accounts = accounts.map((account) => getAddress(account))
      this.#chainId = parseChainIdValue(await this.provider.request({ method: 'eth_chainId' }))
      this.#attachProvider()
    } catch (error) {
      throw toWalletError(error)
    }

    if (chainId && !silent && chainId !== evmChainId(this.#chainId)) {
      // Connected on the wrong network is still connected; the UI shows a "switch network" state.
      await this.switchChain(chainId).catch(() => {})
    }
    return this.#connection()
  }

  async disconnect(): Promise<void> {
    this.#detachProvider?.()
    this.#detachProvider = null
    this.#accounts = []
    // EIP-2255. Without it the next `eth_accounts` would silently reconnect.
    // Wallets that don't implement it answer 4200 — that's fine.
    await this.provider
      .request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] })
      .catch(() => {})
  }

  async signMessage({ account, message }: { account: CaipAccountId; message: string }): Promise<Hex> {
    const address = this.#resolveAccount(account)
    try {
      return await this.getWalletClient().signMessage({ account: address, message })
    } catch (error) {
      throw toWalletError(error)
    }
  }

  /**
   * EIP-712. Refuses to sign when the domain's chainId differs from the wallet's chain:
   * a signature for another chain is a classic cross-chain replay vector.
   */
  async signTypedData<
    const typedData extends TypedData | Record<string, unknown>,
    primaryType extends keyof typedData | 'EIP712Domain',
  >(account: CaipAccountId, typedData: TypedDataDefinition<typedData, primaryType>): Promise<Hex> {
    const address = this.#resolveAccount(account)
    const domainChainId = (typedData.domain as TypedDataDomain | undefined)?.chainId
    if (domainChainId !== undefined && Number(domainChainId) !== this.#chainId) {
      throw new WalletError(
        'CHAIN_MISMATCH',
        `Typed data is for chain ${domainChainId}, wallet is on ${this.#chainId}`,
      )
    }
    try {
      return await this.getWalletClient().signTypedData({ ...typedData, account: address } as Parameters<
        WalletClient['signTypedData']
      >[0])
    } catch (error) {
      throw toWalletError(error)
    }
  }

  async switchChain(chainId: CaipChainId): Promise<void> {
    const id = evmChainIdToNumber(chainId)
    const chain = this.#chains.find((c) => c.id === id)
    if (!chain) throw new WalletError('UNRECOGNIZED_CHAIN', `Chain ${chainId} is not configured in this dApp`)

    try {
      await this.#requestSwitch(id)
    } catch (cause) {
      const error = toWalletError(cause)
      if (error.code !== 'UNRECOGNIZED_CHAIN') throw error
      try {
        await this.provider.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: numberToHex(id),
              chainName: chain.name,
              nativeCurrency: chain.nativeCurrency,
              rpcUrls: [...chain.rpcUrls.default.http],
              blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
            },
          ],
        })
        // Most wallets switch after adding, some don't.
        const current = parseChainIdValue(await this.provider.request({ method: 'eth_chainId' }))
        if (current !== id) await this.#requestSwitch(id)
      } catch (addError) {
        throw toWalletError(addError)
      }
    }
    // Not every wallet emits `chainChanged` reliably after a programmatic switch.
    this.#setChain(id)
  }

  /** viem wallet client for the advanced paths (transactions, typed data). Never retries prompts. */
  getWalletClient(): WalletClient {
    const chain = this.#chains.find((c) => c.id === this.#chainId)
    return createWalletClient({ chain, transport: custom(this.provider, { retryCount: 0 }) })
  }

  subscribe(listener: (event: ConnectorEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #requestSwitch(id: number): Promise<unknown> {
    return this.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: numberToHex(id) }] })
  }

  #resolveAccount(account: CaipAccountId): Address {
    const { namespace, address } = parseAccountId(account)
    const match = namespace === 'eip155' ? this.#accounts.find((a) => isAddressEqual(a, address as Address)) : undefined
    if (!match) throw new WalletError('ACCOUNT_MISMATCH', `Account ${account} is not connected to ${this.info.name}`)
    return match
  }

  #attachProvider(): void {
    if (this.#detachProvider) return
    const onAccounts = (accounts: string[]) => {
      if (accounts.length === 0) {
        this.#accounts = []
        this.#emit({ type: 'disconnect' })
        return
      }
      this.#accounts = accounts.map((a) => getAddress(a))
      this.#emit({ type: 'change', connection: this.#connection() })
    }
    const onChain = (chainId: string) => this.#setChain(parseChainIdValue(chainId))
    // EIP-1193 `disconnect` means the provider lost every chain (not a user logout).
    const onDisconnect = (error: unknown) => this.#emit({ type: 'disconnect', error: toWalletError(error) })

    this.provider.on('accountsChanged', onAccounts)
    this.provider.on('chainChanged', onChain)
    this.provider.on('disconnect', onDisconnect)
    this.#detachProvider = () => {
      this.provider.removeListener('accountsChanged', onAccounts)
      this.provider.removeListener('chainChanged', onChain)
      this.provider.removeListener('disconnect', onDisconnect)
    }
  }

  #setChain(id: number): void {
    if (this.#chainId === id) return
    this.#chainId = id
    if (this.#accounts.length > 0) this.#emit({ type: 'change', connection: this.#connection() })
  }

  #connection(): Connection {
    const chainId = evmChainId(this.#chainId!)
    return { chainId, accounts: this.#accounts.map((address) => toAccountId(chainId, address)) }
  }

  #emit(event: ConnectorEvent): void {
    for (const listener of [...this.#listeners]) listener(event)
  }
}

function parseChainIdValue(value: unknown): number {
  // Spec says hex string; a few wallets return a decimal string or a number.
  if (typeof value === 'number') return value
  if (typeof value === 'string') return value.startsWith('0x') ? hexToNumber(value as Hex) : Number(value)
  throw new WalletError('UNKNOWN', `Unexpected chain id: ${String(value)}`)
}
