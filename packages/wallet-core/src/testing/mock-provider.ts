import {
  createWalletClient,
  hexToBigInt,
  hexToNumber,
  http,
  isAddressEqual,
  numberToHex,
  type Address,
  type EIP1193Provider,
  type Hex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'

export interface MockProviderOptions {
  readonly privateKey?: Hex
  readonly chainId?: number
  /** Chains the "wallet" already knows; others answer 4902 until added. */
  readonly knownChainIds?: readonly number[]
  /** Start with `eth_accounts` returning the account (as after a previous session). */
  readonly authorized?: boolean
  /**
   * JSON-RPC node (e.g. anvil). Enables `eth_sendTransaction` (signed locally, honouring a supplied
   * `nonce` like Rabby/Frame do) and forwards every other unknown method to the node.
   */
  readonly rpcUrl?: string
}

export interface MockProvider {
  readonly provider: EIP1193Provider
  readonly account: PrivateKeyAccount
  readonly calls: readonly { method: string; params: unknown }[]
  /** The next prompting request fails with 4001, as if the user clicked "Reject". */
  rejectNextRequest(): void
  /** Simulates the user switching accounts in the wallet UI. */
  switchAccount(privateKey?: Hex): PrivateKeyAccount
  /** Simulates the user locking the wallet. */
  lock(): void
  emit(event: string, payload: unknown): void
  listenerCount(event: string): number
}

const PROMPTING = new Set([
  'eth_requestAccounts',
  'eth_sendTransaction',
  'personal_sign',
  'eth_signTypedData_v4',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
])

/** A deterministic EIP-1193 wallet backed by a real private key: signatures verify for real. */
export function createMockProvider(options: MockProviderOptions = {}): MockProvider {
  let account = privateKeyToAccount(options.privateKey ?? generatePrivateKey())
  let chainId = options.chainId ?? 1
  let authorized = options.authorized ?? false
  let rejectNext = false
  const known = new Set([chainId, ...(options.knownChainIds ?? [])])
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const calls: { method: string; params: unknown }[] = []

  const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code })
  const emit = (event: string, payload: unknown) => {
    for (const fn of [...(listeners.get(event) ?? [])]) fn(payload)
  }
  const requireSigner = (address: unknown) => {
    if (!authorized) throw rpcError(4100, 'Unauthorized')
    if (typeof address !== 'string' || !isAddressEqual(address as Address, account.address)) {
      throw rpcError(4100, 'Unknown account')
    }
  }

  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    calls.push({ method, params })
    if (rejectNext && PROMPTING.has(method)) {
      rejectNext = false
      throw rpcError(4001, 'User rejected the request.')
    }
    const args = (params ?? []) as unknown[]
    switch (method) {
      case 'eth_requestAccounts':
        authorized = true
        return [account.address]
      case 'eth_accounts':
        return authorized ? [account.address] : []
      case 'eth_chainId':
        return numberToHex(chainId)
      case 'personal_sign':
        requireSigner(args[1])
        return account.signMessage({ message: { raw: args[0] as Hex } })
      case 'eth_signTypedData_v4':
        requireSigner(args[0])
        return account.signTypedData(JSON.parse(args[1] as string))
      case 'wallet_switchEthereumChain': {
        const next = hexToNumber((args[0] as { chainId: Hex }).chainId)
        if (!known.has(next)) throw rpcError(4902, `Unrecognized chain ID ${next}`)
        if (next !== chainId) {
          chainId = next
          emit('chainChanged', numberToHex(next))
        }
        return null
      }
      case 'wallet_addEthereumChain':
        known.add(hexToNumber((args[0] as { chainId: Hex }).chainId))
        return null
      case 'wallet_revokePermissions':
        authorized = false
        return null
      case 'eth_sendTransaction': {
        const tx = args[0] as Record<string, Hex | undefined>
        requireSigner(tx.from)
        if (!options.rpcUrl) throw rpcError(4200, 'eth_sendTransaction needs rpcUrl')
        const wallet = createWalletClient({ account, transport: http(options.rpcUrl, { retryCount: 0 }) })
        const big = (v?: Hex) => (v === undefined ? undefined : hexToBigInt(v))
        return wallet.sendTransaction({
          chain: null,
          to: tx.to as Address | undefined,
          data: tx.data ?? tx.input,
          value: big(tx.value),
          gas: big(tx.gas),
          nonce: tx.nonce === undefined ? undefined : hexToNumber(tx.nonce),
          ...(tx.gasPrice
            ? { gasPrice: big(tx.gasPrice) }
            : { maxFeePerGas: big(tx.maxFeePerGas), maxPriorityFeePerGas: big(tx.maxPriorityFeePerGas) }),
        } as Parameters<typeof wallet.sendTransaction>[0])
      }
      default:
        if (options.rpcUrl) return forward(options.rpcUrl, method, params)
        throw rpcError(4200, `Unsupported method: ${method}`)
    }
  }

  const provider = {
    request,
    on(event: string, fn: (payload: unknown) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(fn)
      return provider
    },
    removeListener(event: string, fn: (payload: unknown) => void) {
      listeners.get(event)?.delete(fn)
      return provider
    },
  }

  return {
    provider: provider as unknown as EIP1193Provider,
    get account() {
      return account
    },
    calls,
    rejectNextRequest: () => void (rejectNext = true),
    switchAccount(privateKey) {
      account = privateKeyToAccount(privateKey ?? generatePrivateKey())
      emit('accountsChanged', [account.address])
      return account
    },
    lock() {
      authorized = false
      emit('accountsChanged', [])
    },
    emit,
    listenerCount: (event) => listeners.get(event)?.size ?? 0,
  }
}

let rpcId = 0
async function forward(url: string, method: string, params: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params: params ?? [] }),
  })
  const body = (await response.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } }
  if (body.error) throw Object.assign(new Error(body.error.message), body.error)
  return body.result
}

/** Announces a provider the way a real extension does (EIP-6963). */
export function announceProvider(
  target: EventTarget,
  provider: EIP1193Provider,
  info: Partial<{ uuid: string; name: string; icon: string; rdns: string }> = {},
): () => void {
  const detail = Object.freeze({
    provider,
    info: Object.freeze({
      uuid: info.uuid ?? crypto.randomUUID(),
      name: info.name ?? 'Mock Wallet',
      icon: info.icon ?? 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iOCIgZmlsbD0iIzZkOGJmZiIvPjwvc3ZnPg==',
      rdns: info.rdns ?? 'dev.omnimarket.mock',
    }),
  })
  const announce = () => target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }))
  target.addEventListener('eip6963:requestProvider', announce)
  announce()
  return () => target.removeEventListener('eip6963:requestProvider', announce)
}
