import type { CaipChainId, WalletInfo } from '@omnimarket/wallet-core'
import type { Address, Hex, WalletClient } from 'viem'

/**
 * ```
 * preparing ─▶ awaiting_signature ─▶ pending ─▶ confirming ─▶ confirmed
 *     │               │                 │  ▲         │
 *     ▼               ▼                 │  └─reorg───┘
 *   failed          failed              ├─▶ failed (reverted | dropped)
 * (simulation)  (user_rejected)         ├─▶ cancelled (our cancel mined)
 *                                       └─▶ replaced  (another tx took the nonce)
 * ```
 */
export type TxStatus =
  | 'preparing'
  | 'awaiting_signature'
  | 'pending'
  | 'confirming'
  | 'confirmed'
  | 'failed'
  | 'cancelled'
  | 'replaced'

export const TERMINAL_STATUSES: ReadonlySet<TxStatus> = new Set(['confirmed', 'failed', 'cancelled', 'replaced'])
export const TRACKED_STATUSES: ReadonlySet<TxStatus> = new Set(['pending', 'confirming'])

export type TxErrorKind =
  | 'user_rejected'
  | 'simulation_reverted'
  | 'reverted'
  | 'insufficient_funds'
  | 'chain_mismatch'
  | 'nonce'
  | 'network'
  | 'dropped'
  /** Solana: the blockhash expired before inclusion. Nothing executed; safe to rebuild and resend. */
  | 'expired'
  | 'interrupted'
  /** Refused by the local security check (e.g. `eth_sign`, a cross-chain signature); the wallet was never asked. */
  | 'blocked'
  | 'unknown'

export interface TxErrorInfo {
  readonly kind: TxErrorKind
  readonly message: string
  /** Decoded custom error, e.g. `OrderExpired`, `ERC721InsufficientApproval`. */
  readonly errorName?: string
  readonly errorArgs?: readonly string[]
}

export type AttemptKind = 'original' | 'speedup' | 'cancel'

/** One broadcast for this record's nonce. Speed-up and cancel add attempts, never new records. */
export interface TxAttempt {
  readonly hash: Hex
  readonly kind: AttemptKind
  readonly sentAt: number
  readonly maxFeePerGas?: string
  readonly maxPriorityFeePerGas?: string
  readonly gasPrice?: string
}

export interface DecodedEvent {
  /** Emitting contract / package / program. */
  readonly address: string
  readonly eventName: string
  readonly args: Readonly<Record<string, string>>
}

export type TxNamespace = 'eip155' | 'solana' | 'sui'

/** What every ecosystem's record has: enough for one Activity list across chains. */
export interface BaseTxRecord {
  readonly id: string
  readonly label: string
  readonly from: string
  readonly status: TxStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly submittedAt?: number
  readonly confirmations: number
  readonly requiredConfirmations: number
  readonly stuck: boolean
  readonly syncError?: string
  readonly error?: TxErrorInfo
  readonly events?: readonly DecodedEvent[]
}

/** Fully JSON-serializable (bigints as decimal strings) so it survives reloads in storage. */
export interface TxRecord extends BaseTxRecord {
  /** Absent on records persisted before multi-chain support. */
  readonly namespace?: 'eip155'
  readonly chainId: number
  readonly from: Address
  /** The request as broadcast; needed to re-send it with higher fees. */
  readonly request?: { readonly to?: Address; readonly data?: Hex; readonly value: string; readonly gas?: string }
  readonly attempts: readonly TxAttempt[]
  readonly nonce?: number
  /** Head block when first broadcast; replacement scans start here. */
  readonly submittedBlock?: string
  /** Hash of the transaction that finally consumed the nonce. */
  readonly minedHash?: Hex
  readonly blockNumber?: string
  readonly replacement?: { readonly hash: Hex; readonly reason: 'repriced' | 'cancelled' | 'replaced' }
  readonly gasUsed?: string
  readonly effectiveGasPrice?: string
}

export type EvmTxRecord = TxRecord

export interface SolanaTxRecord extends BaseTxRecord {
  readonly namespace: 'solana'
  readonly chain: CaipChainId
  /** First signature = transaction id. */
  readonly signature?: string
  /** Signed wire transaction (base64), kept to rebroadcast until the blockhash expires. */
  readonly wireTransaction?: string
  readonly lastValidBlockHeight?: string
  readonly lastBroadcastAt?: number
  /** Program per instruction index of the *signed* message (wallets may insert instructions). */
  readonly programs?: readonly string[]
  readonly commitment?: 'processed' | 'confirmed' | 'finalized'
  readonly targetCommitment: 'confirmed' | 'finalized'
  readonly slot?: string
  readonly fee?: string
}

export interface SuiTxRecord extends BaseTxRecord {
  readonly namespace: 'sui'
  readonly chain: CaipChainId
  readonly digest?: string
  /** Signed transaction (base64 bytes + signature), kept to resubmit: execution is idempotent. */
  readonly signedBytes?: string
  readonly signature?: string
  readonly lastSubmitAt?: number
  readonly checkpoint?: string
  readonly gasUsed?: string
}

export type AnyTxRecord = TxRecord | SolanaTxRecord | SuiTxRecord

export function namespaceOf(record: AnyTxRecord): TxNamespace {
  return record.namespace ?? 'eip155'
}

export function isEvmRecord(record: AnyTxRecord): record is TxRecord {
  return namespaceOf(record) === 'eip155'
}

/** What the engine needs from a wallet. `Eip1193Connector` satisfies it as is. */
export interface EvmSigner {
  readonly info: WalletInfo
  readonly chainId: number | null
  getWalletClient(): WalletClient
  switchChain(chainId: `eip155:${number}`): Promise<void>
}
