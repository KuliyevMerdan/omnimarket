import { isAddress as isSolanaAddress } from '@solana/kit'
import { getAddress, isAddress as isEvmAddress } from 'viem'
import { parseAccountId, parseChainId, toAccountId } from '../../caip'
import type { CaipAccountId, CaipChainId, ChainNamespace } from '../../types'

/** dApp chains per namespace, as CAIP-2 ids in the dApp's order of preference. */
export type RequestedChains = Partial<Record<ChainNamespace, readonly CaipChainId[]>>

/** Every method the SDK may call per namespace. Asking for more than we use only widens what a wallet grants. */
export const WC_METHODS: Readonly<Record<ChainNamespace, readonly string[]>> = {
  eip155: [
    'personal_sign',
    'eth_signTypedData_v4',
    'eth_sendTransaction',
    'wallet_switchEthereumChain',
    'wallet_addEthereumChain',
  ],
  solana: ['solana_signMessage', 'solana_signTransaction', 'solana_signAndSendTransaction'],
  sui: ['sui_signPersonalMessage', 'sui_signTransaction', 'sui_signAndExecuteTransaction'],
}

export const WC_EVENTS: Readonly<Record<ChainNamespace, readonly string[]>> = {
  eip155: ['accountsChanged', 'chainChanged'],
  solana: ['accountsChanged'],
  sui: ['accountsChanged'],
}

/**
 * A namespace is usable only with message signing (sign-in) plus one way to transact.
 * Same rule as the Wallet Standard adapters' `requiredFeatures`.
 */
const REQUIRED_METHODS: Readonly<Record<ChainNamespace, readonly (readonly string[])[]>> = {
  eip155: [['personal_sign', 'eth_sendTransaction']],
  solana: [
    ['solana_signMessage', 'solana_signTransaction'],
    ['solana_signMessage', 'solana_signAndSendTransaction'],
  ],
  sui: [
    ['sui_signPersonalMessage', 'sui_signTransaction'],
    ['sui_signPersonalMessage', 'sui_signAndExecuteTransaction'],
  ],
}

const NAMESPACES: readonly ChainNamespace[] = ['eip155', 'solana', 'sui']
const MAX_ACCOUNTS = 64

export interface ProposalNamespace {
  readonly chains: string[]
  readonly methods: string[]
  readonly events: string[]
}

/**
 * Everything goes into `optionalNamespaces`: a wallet that can't satisfy a *required* namespace must
 * reject the whole proposal, so an EVM-only mobile wallet could never connect to a multi-chain dApp.
 * We decide what is usable after approval instead (`parseApprovedNamespaces`).
 */
export function buildOptionalNamespaces(chains: RequestedChains): Record<string, ProposalNamespace> {
  const result: Record<string, ProposalNamespace> = {}
  for (const namespace of NAMESPACES) {
    const list = chains[namespace]
    if (!list?.length) continue
    result[namespace] = { chains: [...list], methods: [...WC_METHODS[namespace]], events: [...WC_EVENTS[namespace]] }
  }
  return result
}

/** What the wallet granted, after validation, for one namespace. */
export interface ApprovedNamespace {
  /** Approved ∩ requested, in the dApp's order. */
  readonly chains: readonly CaipChainId[]
  /** Normalized CAIP-10 ids on those chains only, deduplicated. */
  readonly accounts: readonly CaipAccountId[]
  readonly methods: ReadonlySet<string>
  readonly events: ReadonlySet<string>
}

export type ApprovedNamespaces = Partial<Record<ChainNamespace, ApprovedNamespace>>

/** Shape of `SessionTypes.Namespaces` (kept structural so tests don't need the WalletConnect types). */
export type SessionNamespaces = Record<string, { chains?: string[]; accounts: string[]; methods: string[]; events: string[] }>

/**
 * The session a wallet settles is untrusted input. Keys may be namespaces (`eip155`) or chains
 * (`eip155:1`, CAIP-25), accounts may sit on chains we never asked for, addresses may be malformed or
 * in a different case. Keep only accounts on requested chains with valid addresses, and only
 * namespaces whose methods cover sign-in plus one transaction path.
 */
export function parseApprovedNamespaces(namespaces: SessionNamespaces, requested: RequestedChains): ApprovedNamespaces {
  const merged = new Map<ChainNamespace, { accounts: Set<string>; methods: Set<string>; events: Set<string> }>()

  for (const [key, value] of Object.entries(namespaces ?? {})) {
    const namespace = key.split(':')[0] as ChainNamespace
    if (!NAMESPACES.includes(namespace) || !value || !Array.isArray(value.accounts)) continue
    const entry = merged.get(namespace) ?? { accounts: new Set(), methods: new Set(), events: new Set() }
    for (const account of value.accounts.slice(0, MAX_ACCOUNTS)) if (typeof account === 'string') entry.accounts.add(account)
    for (const method of value.methods ?? []) if (typeof method === 'string') entry.methods.add(method)
    for (const event of value.events ?? []) if (typeof event === 'string') entry.events.add(event)
    merged.set(namespace, entry)
  }

  const result: ApprovedNamespaces = {}
  for (const [namespace, entry] of merged) {
    const wanted = requested[namespace] ?? []
    if (!REQUIRED_METHODS[namespace].some((set) => set.every((m) => entry.methods.has(m)))) continue

    const accounts: CaipAccountId[] = []
    for (const raw of entry.accounts) {
      const account = normalizeAccount(namespace, raw)
      if (account && wanted.includes(parseAccountId(account).chainId) && !accounts.includes(account)) accounts.push(account)
    }
    const chains = wanted.filter((chain) => accounts.some((a) => parseAccountId(a).chainId === chain))
    if (chains.length === 0) continue

    // Only the methods we asked for: a wallet "granting" extra methods doesn't make us call them.
    const methods = new Set(WC_METHODS[namespace].filter((m) => entry.methods.has(m)))
    const events = new Set(WC_EVENTS[namespace].filter((e) => entry.events.has(e)))
    result[namespace] = { chains, accounts, methods, events }
  }
  return result
}

/** Accounts of one namespace on one chain (or on any approved chain), as plain addresses. */
export function addressesOn(approved: ApprovedNamespace | undefined, chainId?: CaipChainId): string[] {
  const addresses: string[] = []
  for (const account of approved?.accounts ?? []) {
    const parsed = parseAccountId(account)
    if ((!chainId || parsed.chainId === chainId) && !addresses.includes(parsed.address)) addresses.push(parsed.address)
  }
  return addresses
}

function normalizeAccount(namespace: ChainNamespace, raw: string): CaipAccountId | null {
  let parsed
  try {
    parsed = parseAccountId(raw)
    parseChainId(parsed.chainId)
  } catch {
    return null
  }
  if (parsed.namespace !== namespace) return null
  const { address, chainId } = parsed
  switch (namespace) {
    case 'eip155':
      return isEvmAddress(address, { strict: false }) ? toAccountId(chainId, getAddress(address)) : null
    case 'solana':
      return isSolanaAddress(address) ? toAccountId(chainId, address) : null
    case 'sui':
      return SUI_ADDRESS.test(address) ? toAccountId(chainId, `0x${address.slice(2).toLowerCase().padStart(64, '0')}`) : null
  }
}

/**
 * Same rule as `isValidSuiAddress` + `normalizeSuiAddress` from `@mysten/sui/utils`, whose barrel
 * import would pull blake2 and BCS into the startup bundle for one regex.
 */
const SUI_ADDRESS = /^0x[0-9a-fA-F]{1,64}$/
