import { http, numberToHex, type Chain, type EIP1193Provider, type Transport } from 'viem'
import { evmChainId } from '../../caip'
import { WalletError } from '../../errors'
import { addressesOn } from './namespaces'
import type { WalletConnectSession } from './session'

export interface WalletConnectEip1193Options {
  readonly session: WalletConnectSession
  readonly chains: readonly Chain[]
  /** Read-only RPC per chain; defaults to the chain's public RPC. */
  readonly transport?: (chain: Chain) => Transport
}

/** Requests the wallet must answer: they show a prompt or need its key. */
const WALLET_METHODS = new Set([
  'personal_sign',
  'eth_signTypedData_v4',
  'eth_sendTransaction',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
])
const UNSUPPORTED = new Set(['eth_sign', 'eth_signTransaction', 'eth_signTypedData', 'eth_signTypedData_v3', 'eth_sendRawTransaction'])

type Listener = (...args: any[]) => void

/**
 * EIP-1193 over a WalletConnect session, so the regular `Eip1193Connector` (and viem, and the tx
 * engine) drive a mobile wallet exactly like an extension.
 *
 * - Wallet methods go over the relay with the *current* chain as the CAIP-2 scope.
 * - Everything else (`eth_call`, gas estimation, receipts) goes to a public RPC: a phone should not
 *   be woken up to read chain state, and a wallet that drops reads would break the app.
 * - Switching between chains the wallet approved is local and instant; other chains are asked for.
 */
export function createWalletConnectEip1193Provider({ session, chains, transport }: WalletConnectEip1193Options): EIP1193Provider {
  const listeners = new Map<string, Set<Listener>>()
  const rpc = new Map<number, ReturnType<Transport>>()
  let chainId: number | null = null
  let accounts: string[] = []

  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
  }
  const approved = () => session.getState().namespaces.eip155

  /** The chain to use: the current one while it stays approved, else the dApp's first approved chain. */
  const resolveChain = (): number | null => {
    const ns = approved()
    if (!ns) return null
    if (chainId !== null && ns.chains.includes(evmChainId(chainId))) return chainId
    const first = chains.find((c) => ns.chains.includes(evmChainId(c.id)))
    return first?.id ?? null
  }

  const sync = () => {
    const nextChain = resolveChain()
    const nextAccounts = nextChain === null ? [] : addressesOn(approved(), evmChainId(nextChain))
    if (nextChain !== null && nextChain !== chainId) {
      chainId = nextChain
      emit('chainChanged', numberToHex(nextChain))
    }
    if (nextAccounts.join() !== accounts.join()) {
      accounts = nextAccounts
      emit('accountsChanged', [...accounts])
    }
  }

  session.onEvent((event) => {
    if (event.type === 'end') {
      if (accounts.length) {
        accounts = []
        emit('accountsChanged', [])
      }
      return
    }
    if (event.type === 'event' && event.namespace === 'eip155' && event.name === 'chainChanged') {
      // Wallets send a number or a hex string.
      const id = Number(event.data)
      if (Number.isSafeInteger(id) && id !== chainId && approved()?.chains.includes(evmChainId(id))) {
        chainId = id
        emit('chainChanged', numberToHex(id))
      }
    }
    sync()
  })

  const readRpc = (id: number) => {
    let client = rpc.get(id)
    if (!client) {
      const chain = chains.find((c) => c.id === id)
      if (!chain) throw new WalletError('UNRECOGNIZED_CHAIN', `Chain ${id} is not configured in this dApp`)
      client = (transport?.(chain) ?? http())({ chain, retryCount: 1 })
      rpc.set(id, client)
    }
    return client
  }

  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    switch (method) {
      case 'eth_chainId': {
        const id = resolveChain() ?? chainId
        if (id === null) throw new WalletError('DISCONNECTED', 'No WalletConnect session for EVM chains')
        return numberToHex(id)
      }
      case 'eth_accounts':
        await session.init()
        sync()
        if (accounts.length) session.attach('eip155')
        return [...accounts]
      case 'eth_requestAccounts':
        await session.pair()
        session.attach('eip155')
        sync()
        return [...accounts]
      case 'wallet_revokePermissions':
        // `Eip1193Connector.disconnect`: this namespace is no longer used by the app.
        await session.detach('eip155')
        return null
      case 'wallet_switchEthereumChain': {
        const target = Number((params as [{ chainId: string }] | undefined)?.[0]?.chainId)
        if (approved()?.chains.includes(evmChainId(target))) {
          // Approved in the session: switching is our choice, not a wallet prompt.
          if (target !== chainId) {
            chainId = target
            emit('chainChanged', numberToHex(target))
            sync()
          }
          return null
        }
        return walletRequest(method, params)
      }
    }
    if (UNSUPPORTED.has(method)) throw new WalletError('UNSUPPORTED_METHOD', `${method} is not supported over WalletConnect`)
    if (WALLET_METHODS.has(method)) return walletRequest(method, params)

    const id = resolveChain()
    if (id === null) throw new WalletError('DISCONNECTED', 'No WalletConnect session for EVM chains')
    return readRpc(id).request({ method, params } as never)
  }

  const walletRequest = async (method: string, params: unknown) => {
    const id = resolveChain()
    if (id === null) throw new WalletError('DISCONNECTED', 'No WalletConnect session for EVM chains')
    return session.request('eip155', evmChainId(id), method, params)
  }

  return {
    request: request as EIP1193Provider['request'],
    on: ((event: string, listener: Listener) => {
      let set = listeners.get(event)
      if (!set) listeners.set(event, (set = new Set()))
      set.add(listener)
    }) as EIP1193Provider['on'],
    removeListener: ((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener)
    }) as EIP1193Provider['removeListener'],
  }
}
