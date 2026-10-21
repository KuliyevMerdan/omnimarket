import type { ClientWithCoreApi } from '@mysten/sui/client'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { fromBase64, toBase64 } from '@mysten/sui/utils'
import { getBase58Decoder, getBase58Encoder, getBase64Decoder, getBase64Encoder } from '@solana/kit'
import { numberToHex, type Hex } from 'viem'
import type { WalletConnectClient, WalletConnectSessionStruct } from '../adapters/walletconnect/session'
import type { ProposalNamespace, SessionNamespaces } from '../adapters/walletconnect/namespaces'
import { parseChainId } from '../caip'
import { createMemoryStorage, type KeyValueStorage } from '../storage'
import type { CaipChainId } from '../types'
import { createMockProvider } from './mock-provider'
import { createMockSolanaWallet } from './solana-wallet'

export interface MockWalletConnectOptions {
  readonly name?: string
  readonly evm?: { readonly privateKey?: Hex; readonly chainIds: readonly number[]; readonly rpcUrl?: string }
  readonly solana?: { readonly privateKey?: Uint8Array; readonly chains: readonly CaipChainId[]; readonly rpcUrl?: string }
  readonly sui?: { readonly keypair?: Ed25519Keypair; readonly chains: readonly CaipChainId[]; readonly client?: ClientWithCoreApi }
  /** Approve each proposal by itself after this delay. Default: wait for `approve()`. */
  readonly autoApproveMs?: number
  /** Where settled sessions live, so a new client (a page reload) restores them. */
  readonly storage?: KeyValueStorage
  readonly redirect?: { readonly native?: string; readonly universal?: string }
  readonly now?: () => number
}

export interface MockWalletConnectRequest {
  readonly chainId: string
  readonly method: string
  readonly params: unknown
}

/** How a misbehaving wallet lies, to test that the SDK refuses its answers. */
export type MockMisbehavior = 'solana-foreign-signature' | 'sui-foreign-bytes' | null

const SESSION_KEY = 'omni:mock-wc:sessions'
const WEEK_S = 7 * 24 * 3600

/**
 * A WalletConnect wallet on the other side of a fake relay: `createClient` gives the dApp a
 * `WalletConnectClient`, the returned controls play the wallet (approve, reject, update, delete).
 * Signing uses real keys (the EIP-1193 / Wallet Standard mocks), so signatures verify for real.
 */
export async function createMockWalletConnect(options: MockWalletConnectOptions) {
  const now = () => options.now?.() ?? Date.now()
  const storage = options.storage ?? createMemoryStorage()
  const clients = new Set<ReturnType<typeof createClient>>()
  const requests: MockWalletConnectRequest[] = []
  let proposals = 0
  let rejectNext = false
  let misbehavior: MockMisbehavior = null
  let pending: { optionalNamespaces: Record<string, ProposalNamespace>; resolve: (s: WalletConnectSessionStruct) => void; reject: (e: unknown) => void } | null = null
  let pendingUri: string | null = null

  const evm = options.evm
    ? createMockProvider({ privateKey: options.evm.privateKey, chainId: options.evm.chainIds[0], knownChainIds: options.evm.chainIds, authorized: true, rpcUrl: options.evm.rpcUrl })
    : null
  const solana = options.solana ? await createMockSolanaWallet({ privateKey: options.solana.privateKey, rpcUrl: options.solana.rpcUrl, authorized: true, chains: ['solana:localnet'] }) : null
  const sui = options.sui ? { keypair: options.sui.keypair ?? new Ed25519Keypair() } : null
  const suiAddress = sui?.keypair.toSuiAddress()

  const supported: Record<string, { chains: readonly string[]; address: string }> = {
    ...(evm && { eip155: { chains: options.evm!.chainIds.map((id) => `eip155:${id}`), address: evm.account.address } }),
    ...(solana && { solana: { chains: options.solana!.chains, address: solana.signer.address } }),
    ...(sui && { sui: { chains: options.sui!.chains, address: suiAddress! } }),
  }

  const load = (): WalletConnectSessionStruct[] => JSON.parse(storage.getItem(SESSION_KEY) ?? '[]')
  const save = (sessions: WalletConnectSessionStruct[]) => storage.setItem(SESSION_KEY, JSON.stringify(sessions))
  const broadcast = (event: string, args: unknown) => {
    for (const client of clients) client.emit(event, args)
  }

  /** What a cooperative wallet grants: requested ∩ supported chains, every requested method. */
  const defaultNamespaces = (proposal: Record<string, ProposalNamespace>): SessionNamespaces => {
    const namespaces: SessionNamespaces = {}
    for (const [key, requested] of Object.entries(proposal)) {
      const own = supported[key]
      if (!own) continue
      const chains = requested.chains.filter((c) => own.chains.includes(c))
      if (chains.length === 0) continue
      namespaces[key] = { chains, accounts: chains.map((c) => `${c}:${own.address}`), methods: [...requested.methods], events: [...requested.events] }
    }
    return namespaces
  }

  const metadata = {
    name: options.name ?? 'Mock Mobile Wallet',
    description: 'In-memory WalletConnect wallet for tests',
    url: 'https://wallet.example',
    icons: [],
    ...(options.redirect && { redirect: options.redirect }),
  }

  const handle = async ({ chainId, method, params }: MockWalletConnectRequest): Promise<unknown> => {
    const { namespace } = parseChainId(chainId)
    const p = params as Record<string, string>
    if (namespace === 'eip155' && evm) {
      const id = Number(parseChainId(chainId).reference)
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') {
        const target = Number((params as [{ chainId: string }])[0].chainId)
        await evm.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: numberToHex(target) }] })
        controls.update((namespaces) => {
          const ns = namespaces.eip155!
          const chain = `eip155:${target}`
          if (!ns.accounts.some((a) => a.startsWith(`${chain}:`))) ns.accounts.push(`${chain}:${evm.account.address}`)
          ns.chains = [...new Set([...(ns.chains ?? []), chain])]
          return namespaces
        })
        return null
      }
      await evm.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: numberToHex(id) }] })
      return evm.provider.request({ method, params } as never)
    }
    if (namespace === 'solana' && solana) {
      const features = solana.wallet.features as any
      const account = solana.wallet.accounts[0]!
      const b58 = { enc: getBase58Encoder(), dec: getBase58Decoder() }
      const b64 = { enc: getBase64Encoder(), dec: getBase64Decoder() }
      switch (method) {
        case 'solana_signMessage': {
          const message = new Uint8Array(b58.enc.encode(p.message!))
          const signed = misbehavior === 'solana-foreign-signature' ? new Uint8Array([...message, 0x21]) : message
          const [out] = await features['solana:signMessage'].signMessage({ account, message: signed })
          return { signature: b58.dec.decode(out.signature) }
        }
        case 'solana_signTransaction': {
          const [out] = await features['solana:signTransaction'].signTransaction({ account, transaction: new Uint8Array(b64.enc.encode(p.transaction!)) })
          return { signature: '', transaction: b64.dec.decode(out.signedTransaction) }
        }
        case 'solana_signAndSendTransaction': {
          const [out] = await features['solana:signAndSendTransaction'].signAndSendTransaction({
            account,
            chain: 'solana:localnet',
            transaction: new Uint8Array(b64.enc.encode(p.transaction!)),
          })
          return { signature: b58.dec.decode(out.signature) }
        }
      }
    }
    if (namespace === 'sui' && sui) {
      switch (method) {
        case 'sui_signPersonalMessage':
          return { signature: (await sui.keypair.signPersonalMessage(new TextEncoder().encode(p.message!))).signature }
        case 'sui_signTransaction': {
          let bytes = fromBase64(p.transaction!)
          if (misbehavior === 'sui-foreign-bytes') bytes = new Uint8Array([...bytes.slice(0, -1), bytes.at(-1)! ^ 1])
          const { signature } = await sui.keypair.signTransaction(bytes)
          return { signature, transactionBytes: toBase64(bytes) }
        }
        case 'sui_signAndExecuteTransaction': {
          if (!options.sui?.client) throw { code: 5101, message: 'Mock Sui wallet needs a client to execute' }
          const bytes = fromBase64(p.transaction!)
          const { signature } = await sui.keypair.signTransaction(bytes)
          const result = await options.sui.client.core.executeTransaction({ transaction: bytes, signatures: [signature] })
          return { digest: (result.Transaction ?? result.FailedTransaction).digest }
        }
      }
    }
    throw { code: 5101, message: `Unsupported method ${method}` }
  }

  function createClient() {
    const listeners = new Map<string, Set<(args: any) => void>>()
    const client = {
      emit(event: string, args: unknown) {
        for (const listener of [...(listeners.get(event) ?? [])]) listener(args)
      },
      on(event: string, listener: (args: any) => void) {
        let set = listeners.get(event)
        if (!set) listeners.set(event, (set = new Set()))
        set.add(listener)
        return client
      },
      off(event: string, listener: (args: any) => void) {
        listeners.get(event)?.delete(listener)
        return client
      },
      session: { getAll: () => load() },
      async connect({ optionalNamespaces }: { optionalNamespaces: Record<string, ProposalNamespace> }) {
        proposals++
        pending?.reject({ code: 5000, message: 'Proposal replaced' })
        const symKey = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')
        pendingUri = `wc:${symKey.slice(0, 64)}@2?relay-protocol=irn&symKey=${symKey}&expiryTimestamp=${Math.floor(now() / 1000) + 300}`
        const approval = new Promise<WalletConnectSessionStruct>((resolve, reject) => {
          pending = { optionalNamespaces, resolve, reject }
        })
        if (options.autoApproveMs !== undefined) setTimeout(() => controls.approve(), options.autoApproveMs)
        return { uri: pendingUri, approval: () => approval }
      },
      async request<T>({ topic, chainId, request }: { topic: string; chainId: string; request: { method: string; params: unknown } }): Promise<T> {
        if (!load().some((s) => s.topic === topic)) throw new Error(`No matching key. session topic doesn't exist: ${topic}`)
        requests.push({ chainId, method: request.method, params: request.params })
        client.emit('session_request_sent', { topic, chainId, request, id: requests.length })
        if (rejectNext) {
          rejectNext = false
          throw { code: 5000, message: 'User rejected.' }
        }
        return (await handle({ chainId, method: request.method, params: request.params })) as T
      },
      async disconnect({ topic }: { topic: string }) {
        save(load().filter((s) => s.topic !== topic))
      },
    }
    clients.add(client)
    return client
  }

  const controls = {
    /** Returns a client for the dApp; call again to simulate a reload (sessions persist in `storage`). */
    createClient: async (): Promise<WalletConnectClient> => createClient(),
    get proposals() {
      return proposals
    },
    get pendingUri() {
      return pending ? pendingUri : null
    },
    requests: requests as readonly MockWalletConnectRequest[],
    evm,
    solana: solana && { address: solana.signer.address, signer: solana.signer },
    sui: sui && { address: suiAddress!, keypair: sui.keypair },
    rejectNextRequest: () => void (rejectNext = true),
    misbehave: (mode: MockMisbehavior) => void (misbehavior = mode),
    /** The user approves the pending proposal (optionally granting something else). */
    approve(grant?: { namespaces?: SessionNamespaces; expiry?: number }) {
      if (!pending) throw new Error('No pending proposal')
      const session: WalletConnectSessionStruct = {
        topic: Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join(''),
        expiry: grant?.expiry ?? Math.floor(now() / 1000) + WEEK_S,
        namespaces: grant?.namespaces ?? defaultNamespaces(pending.optionalNamespaces),
        peer: { metadata },
      }
      save([...load(), session])
      const { resolve } = pending
      pending = null
      resolve(session)
      return session
    },
    reject() {
      if (!pending) throw new Error('No pending proposal')
      const { reject } = pending
      pending = null
      reject({ code: 5000, message: 'User rejected.' })
    },
    /** `session_update` from the wallet: the user added or removed chains/accounts. */
    update(change: (namespaces: SessionNamespaces) => SessionNamespaces) {
      const sessions = load()
      const session = sessions.at(-1)
      if (!session) throw new Error('No session')
      const namespaces = change(structuredClone(session.namespaces))
      save(sessions.map((s) => (s.topic === session.topic ? { ...s, namespaces } : s)))
      broadcast('session_update', { id: Date.now(), topic: session.topic, params: { namespaces } })
    },
    /** `session_event`, e.g. `chainChanged` after the user switched networks in the wallet. */
    emitEvent(chainId: string, name: string, data: unknown) {
      const session = load().at(-1)
      if (session) broadcast('session_event', { id: Date.now(), topic: session.topic, params: { chainId, event: { name, data } } })
    },
    /** The user disconnects from the wallet's side. */
    deleteSession() {
      const session = load().at(-1)
      if (!session) return
      save(load().filter((s) => s.topic !== session.topic))
      broadcast('session_delete', { id: Date.now(), topic: session.topic })
    },
    get sessions() {
      return load()
    },
  }
  return controls
}

export type MockWalletConnect = Awaited<ReturnType<typeof createMockWalletConnect>>
