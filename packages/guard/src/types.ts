import type { Address, Hex, PublicClient } from 'viem'

/**
 * - `info`: described, nothing unusual; goes straight to the wallet.
 * - `warning`: the user reviews it first (unlimited allowance, gasless permit, unknown contract).
 * - `danger`: the user must acknowledge the risk explicitly (approval to a personal address, blind hash).
 * - `blocked`: never forwarded (`eth_sign`, a signature for another chain).
 */
export type RiskLevel = 'info' | 'warning' | 'danger' | 'blocked'

export const RISK_ORDER: Readonly<Record<RiskLevel, number>> = { info: 0, warning: 1, danger: 2, blocked: 3 }

export type FindingCode =
  | 'SPENDER_KNOWN'
  | 'SPENDER_EOA'
  | 'SPENDER_DELEGATED'
  | 'SPENDER_UNVERIFIED'
  | 'SPENDER_UNCHECKED'
  | 'UNLIMITED_ALLOWANCE'
  | 'APPROVAL_FOR_ALL'
  | 'REVOKE'
  | 'OFFCHAIN_APPROVAL'
  | 'LONG_EXPIRY'
  | 'NO_EXPIRY'
  | 'PERMIT2_IMPOSTOR'
  | 'TRANSFER_OUT'
  | 'NATIVE_VALUE'
  | 'CONTRACT_DEPLOYMENT'
  | 'KNOWN_CONTRACT'
  | 'UNKNOWN_CONTRACT'
  | 'UNKNOWN_TYPED_DATA'
  | 'CHAIN_MISMATCH'
  | 'MISSING_CHAIN_ID'
  | 'MALFORMED_REQUEST'
  | 'BLIND_SIGNATURE'
  | 'RAW_SIGNATURE'
  | 'HIDDEN_CHARACTERS'
  | 'SIGN_IN'
  | 'SIGN_IN_DOMAIN_MISMATCH'
  | 'SIGN_IN_CHAIN_MISMATCH'
  | 'INSPECTION_FAILED'

export interface Finding {
  readonly code: FindingCode
  readonly level: RiskLevel
  /** One line, user language. */
  readonly title: string
  readonly detail?: string
}

export interface TokenAmount {
  readonly token: Address
  readonly amount: bigint
  readonly unlimited: boolean
}

/** What the request does, decoded. Amounts are raw integers; `details` on the report has them formatted. */
export type Intent =
  | { readonly kind: 'erc20_approve'; readonly token: Address; readonly spender: Address; readonly amount: bigint; readonly unlimited: boolean }
  | { readonly kind: 'nft_approve'; readonly collection: Address; readonly spender: Address; readonly tokenId: bigint }
  | { readonly kind: 'approval_for_all'; readonly collection: Address; readonly operator: Address; readonly approved: boolean }
  | {
      readonly kind: 'permit'
      readonly standard: 'eip2612' | 'dai' | 'permit2'
      /** Permit2 SignatureTransfer: a one-time transfer instead of a standing allowance. */
      readonly transfer: boolean
      readonly spender: Address
      readonly tokens: readonly TokenAmount[]
      /** Unix seconds; when the signature, or the allowance it creates, stops working. */
      readonly deadline?: bigint
    }
  | { readonly kind: 'permit2_approve'; readonly token: Address; readonly spender: Address; readonly amount: bigint; readonly unlimited: boolean; readonly expiration: bigint }
  | { readonly kind: 'token_transfer'; readonly token: Address; readonly from: Address; readonly to: Address; readonly amount: bigint; readonly standard: TokenStandard }
  | { readonly kind: 'native_transfer'; readonly to: Address; readonly value: bigint }
  | { readonly kind: 'contract_call'; readonly to: Address; readonly selector?: Hex; readonly value: bigint }
  | { readonly kind: 'deploy' }
  | { readonly kind: 'batch'; readonly calls: readonly Intent[] }
  | { readonly kind: 'typed_data'; readonly primaryType: string; readonly domainName?: string; readonly verifyingContract?: Address }
  | { readonly kind: 'message'; readonly text: string; readonly signIn?: { readonly domain: string } }
  | { readonly kind: 'hash'; readonly hash: Hex }

export type TokenStandard = 'erc20' | 'erc721' | 'erc1155' | 'unknown'

export type GuardedMethod = 'eth_sendTransaction' | 'wallet_sendCalls' | 'eth_signTypedData_v4' | 'personal_sign' | 'eth_sign'

export interface ReportDetail {
  readonly label: string
  readonly value: string
  /** Set when `value` names an address: UIs render it as one (copy, explorer link). */
  readonly address?: Address
}

export interface RiskReport {
  readonly method: GuardedMethod
  readonly chainId: number
  readonly account: Address
  /** The highest level among the findings; `info` when there are none. */
  readonly level: RiskLevel
  /** One line: "Approve unlimited USDC for 0x12…ab". */
  readonly summary: string
  readonly intent: Intent
  /** Most severe first. */
  readonly findings: readonly Finding[]
  /** Formatted facts for display (token, spender, amount, expiry). */
  readonly details: readonly ReportDetail[]
}

/** RPC reads the inspection needs. A viem `PublicClient` satisfies it. */
export type GuardReader = Pick<PublicClient, 'getCode' | 'readContract'>

export interface KnownContract {
  /** Shown instead of the address, e.g. "OmniMarket". */
  readonly name: string
}

export interface GuardContext {
  readonly chainId: number
  readonly account: Address
  /** Without a reader the analysis is static: spenders show as "could not be checked". */
  readonly client?: GuardReader
  /** Contracts the app vouches for (its own deployments). Permit2 is always known. */
  readonly known?: (chainId: number, address: Address) => KnownContract | undefined
  /** Host the app is served from; sign-in messages for other domains are dangerous. */
  readonly domain?: string
  readonly nativeSymbol?: string
  /** Milliseconds; for permit deadlines. */
  readonly now?: () => number
}
