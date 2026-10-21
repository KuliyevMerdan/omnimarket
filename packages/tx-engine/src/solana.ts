import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget'
import type { CaipAccountId, CaipChainId } from '@omnimarket/wallet-core'
import { parseAccountId, toWalletError } from '@omnimarket/wallet-core'
import type { SolanaConnector } from '@omnimarket/wallet-core/solana'
import {
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionEncoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Base64EncodedWireTransaction,
  type Instruction,
  type MicroLamports,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  type TransactionSigner,
} from '@solana/kit'
import { PollScheduler, onWakeUp, type PollResult } from './scheduler'
import type { AnyRecordPatch, TxStore } from './store'
import { TRACKED_STATUSES, type SolanaTxRecord, type TxErrorInfo } from './types'

export interface SolanaTxEngineOptions {
  readonly store: TxStore
  readonly getRpc: (chain: CaipChainId) => Rpc<SolanaRpcApi>
  /** Maps a program's custom error code to a name, e.g. Metaplex Core's error table. */
  readonly programErrors?: (programAddress: string, code: number) => string | undefined
  readonly pollingIntervalMs?: number
  /** How often to rebroadcast while the blockhash is valid (sendTransaction uses maxRetries: 0). */
  readonly rebroadcastIntervalMs?: number
  readonly stuckAfterMs?: number
  readonly now?: () => number
}

export interface SolanaSendRequest {
  readonly id?: string
  readonly label: string
  readonly connector: SolanaConnector
  readonly account: CaipAccountId
  readonly instructions: readonly Instruction[]
  /** Extra signers, e.g. the keypair of an account the transaction creates. */
  readonly signers?: readonly TransactionSigner[]
  /** `confirmed` (~1–2 s, optimistic) or `finalized` (~13 s, rooted). */
  readonly commitment?: 'confirmed' | 'finalized'
  /** micro-lamports per CU; `auto` = median of recent prioritization fees for the touched accounts. */
  readonly priorityFee?: 'auto' | bigint
}

const COMPUTE_UNIT_MARGIN = 1.1
const MAX_COMPUTE_UNITS = 1_400_000
const MIN_COMPUTE_UNITS = 1_000

/**
 * Solana transactions: simulate (for errors *and* compute units) → sign → send with app-side
 * rebroadcast → track commitment until the blockhash's last valid block height.
 */
export class SolanaTxEngine {
  readonly #options: SolanaTxEngineOptions
  readonly #scheduler: PollScheduler<string>
  #startCount = 0
  #detachWake: (() => void) | null = null

  constructor(options: SolanaTxEngineOptions) {
    this.#options = options
    this.#scheduler = new PollScheduler((chain) => this.#pollChain(chain as CaipChainId), () => options.pollingIntervalMs ?? 1500)
  }

  get store(): TxStore {
    return this.#options.store
  }

  start(): () => void {
    if (this.#startCount++ === 0) {
      for (const chain of this.#trackedChains()) this.#scheduler.ensure(chain)
      this.#detachWake = onWakeUp(() => this.#scheduler.wake(this.#trackedChains()))
    }
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      if (--this.#startCount > 0) return
      this.#detachWake?.()
      this.#scheduler.stop()
    }
  }

  async pollNow(chain?: CaipChainId): Promise<void> {
    await Promise.all((chain ? [chain] : this.#trackedChains()).map((c) => this.#scheduler.now(c)))
  }

  async send(request: SolanaSendRequest): Promise<SolanaTxRecord> {
    const { connector, account, label } = request
    const chain = connector.activeChain.caip
    const feePayer = parseAccountId(account).address as Address
    const now = this.#now()
    const id = request.id ?? crypto.randomUUID()
    this.store.insert({
      id,
      namespace: 'solana',
      label,
      chain,
      from: feePayer,
      status: 'preparing',
      createdAt: now,
      updatedAt: now,
      confirmations: 0,
      requiredConfirmations: 1,
      targetCommitment: request.commitment ?? 'confirmed',
      stuck: false,
    })

    try {
      const rpc = this.#options.getRpc(chain)
      const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
      const programs = request.instructions.map((ix) => ix.programAddress)

      // Compute budget instructions go first by convention; the simulation uses the max limit.
      const build = (budget: readonly Instruction[]) =>
        pipe(
          createTransactionMessage({ version: 0 }),
          (m) => setTransactionMessageFeePayer(feePayer, m),
          (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
          (m) => appendTransactionMessageInstructions([...budget, ...request.instructions], m),
        )
      const probe = build([getSetComputeUnitLimitInstruction({ units: MAX_COMPUTE_UNITS })])
      const probePrograms = probe.instructions.map((ix) => ix.programAddress)

      // Pre-flight: catches program errors before the wallet prompt and measures compute units,
      // so we pay for (and reserve) what the transaction actually needs instead of the 200k default.
      const simulation = await rpc
        .simulateTransaction(getBase64EncodedWireTransaction(compileTransaction(probe)), {
          encoding: 'base64',
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: 'confirmed',
        })
        .send()
      if (simulation.value.err) {
        this.#fail(id, decodeSolanaError(simulation.value.err, probePrograms, this.#options.programErrors, 'simulation_reverted', simulation.value.logs))
        return (await this.store.waitFor(id)) as SolanaTxRecord
      }
      const units = Math.max(MIN_COMPUTE_UNITS, Math.ceil(Number(simulation.value.unitsConsumed ?? 200_000n) * COMPUTE_UNIT_MARGIN))
      const microLamports = await this.#priorityFee(rpc, request, programs)
      const message = build([
        getSetComputeUnitLimitInstruction({ units }),
        ...(microLamports > 0n ? [getSetComputeUnitPriceInstruction({ microLamports: microLamports as MicroLamports })] : []),
      ])

      this.store.update(id, { status: 'awaiting_signature', lastValidBlockHeight: blockhash.lastValidBlockHeight.toString() })
      const extra = [...(request.signers ?? [])]

      if (connector.canSignTransaction) {
        const walletSigner = connector.transactionSigner(account)
        const signable = addSignersToTransactionMessage(extra, setTransactionMessageFeePayerSigner(walletSigner, message))
        const signed = await signTransactionMessageWithSigners(signable)
        const wire = getBase64EncodedWireTransaction(signed)
        // We build v0 messages: static accounts + instructions with program indexes.
        const compiled = getCompiledTransactionMessageDecoder().decode(signed.messageBytes) as unknown as {
          staticAccounts: readonly string[]
          instructions: readonly { programAddressIndex: number }[]
        }
        this.store.update(id, {
          status: 'pending',
          signature: getSignatureFromTransaction(signed),
          wireTransaction: wire,
          programs: compiled.instructions.map((ix) => compiled.staticAccounts[ix.programAddressIndex] ?? ''),
          submittedAt: this.#now(),
        })
        await this.#broadcast(id, rpc, wire)
      } else {
        // Wallet broadcasts itself: we can track but not rebroadcast.
        const partiallySigned = await partiallySignTransactionMessageWithSigners(addSignersToTransactionMessage(extra, message))
        const bytes = new Uint8Array(getTransactionEncoder().encode(partiallySigned))
        const signature = await connector.signAndSendTransaction(account, bytes)
        this.store.update(id, { status: 'pending', signature, submittedAt: this.#now() })
      }
      this.#scheduler.ensure(chain)
    } catch (error) {
      this.#fail(id, solanaClientError(error))
    }
    return (await this.store.waitFor(id)) as SolanaTxRecord
  }

  async #priorityFee(rpc: Rpc<SolanaRpcApi>, request: SolanaSendRequest, programs: readonly Address[]): Promise<bigint> {
    if (request.priorityFee !== undefined && request.priorityFee !== 'auto') return request.priorityFee
    try {
      const writable = [
        ...new Set(request.instructions.flatMap((ix) => (ix.accounts ?? []).filter((a) => a.role % 2 === 1).map((a) => a.address))),
      ].slice(0, 128)
      const fees = await rpc.getRecentPrioritizationFees(writable.length > 0 ? writable : programs.slice(0, 128)).send()
      const values = fees.map((f) => f.prioritizationFee).filter((f) => f > 0n).sort((a, b) => (a < b ? -1 : 1))
      return values.length === 0 ? 0n : values[Math.floor(values.length / 2)]!
    } catch {
      return 0n // fee estimation is best-effort; the transaction still lands without it on quiet networks
    }
  }

  async #broadcast(id: string, rpc: Rpc<SolanaRpcApi>, wire: string): Promise<void> {
    try {
      await rpc
        .sendTransaction(wire as Base64EncodedWireTransaction, { encoding: 'base64', skipPreflight: true, maxRetries: 0n })
        .send()
      this.store.update(id, { lastBroadcastAt: this.#now(), syncError: undefined })
    } catch (error) {
      // A network error is not a failure: the next round rebroadcasts until the blockhash expires.
      this.store.update(id, { lastBroadcastAt: this.#now(), syncError: messageOf(error) })
    }
  }

  async #pollChain(chain: CaipChainId): Promise<PollResult> {
    const tracked = this.#tracked(chain).filter((r) => r.signature)
    if (tracked.length === 0) return { active: this.#tracked(chain).length > 0, failed: false }
    const rpc = this.#options.getRpc(chain)
    const now = this.#now()
    try {
      const { value: statuses } = await rpc
        .getSignatureStatuses(tracked.map((r) => r.signature as Signature))
        .send()
      const missing = statuses.some((s) => s === null)
      const blockHeight = missing ? await rpc.getBlockHeight({ commitment: 'confirmed' }).send() : undefined

      for (const [i, record] of tracked.entries()) {
        const status = statuses[i]
        if (status) {
          if (status.err) {
            this.#fail(record.id, decodeSolanaError(status.err, record.programs ?? [], this.#options.programErrors, 'reverted'), {
              slot: status.slot.toString(),
            })
            continue
          }
          const level = status.confirmationStatus ?? 'processed'
          const done = record.targetCommitment === 'finalized' ? level === 'finalized' : level !== 'processed'
          // Fetch the fee before the terminal update, so `await send()` sees a complete record.
          const fee = done ? await this.#fee(rpc, record) : undefined
          this.store.update(record.id, {
            status: done ? 'confirmed' : 'confirming',
            commitment: level,
            slot: status.slot.toString(),
            confirmations: done ? 1 : 0,
            stuck: false,
            syncError: undefined,
            ...(fee ? { fee } : {}),
          } satisfies AnyRecordPatch)
          continue
        }

        // syncError here reflects the last *broadcast*: only a successful rebroadcast clears it.
        const patch: AnyRecordPatch = {}
        // `processed` can be on a minority fork that gets dropped: back to pending, keep rebroadcasting.
        if (record.status === 'confirming') Object.assign(patch, { status: 'pending', commitment: undefined })

        if (blockHeight !== undefined && record.lastValidBlockHeight && blockHeight > BigInt(record.lastValidBlockHeight)) {
          // Before declaring expiry, look in long-term history once: the status cache only covers ~150 slots.
          const { value: [late] } = await rpc
            .getSignatureStatuses([record.signature as Signature], { searchTransactionHistory: true })
            .send()
          if (!late) {
            this.#fail(record.id, {
              kind: 'expired',
              message: 'The transaction expired before it was included. Nothing was executed, it is safe to retry.',
            })
            continue
          }
        } else if (record.wireTransaction && now - (record.lastBroadcastAt ?? 0) >= (this.#options.rebroadcastIntervalMs ?? 2000)) {
          await this.#broadcast(record.id, rpc, record.wireTransaction)
        }
        patch.stuck = now - (record.submittedAt ?? record.createdAt) > (this.#options.stuckAfterMs ?? 30_000)
        this.store.update(record.id, patch)
      }
      return { active: this.#tracked(chain).length > 0, failed: false }
    } catch (error) {
      for (const record of tracked) this.store.update(record.id, { syncError: messageOf(error) })
      return { active: true, failed: true }
    }
  }

  async #fee(rpc: Rpc<SolanaRpcApi>, record: SolanaTxRecord): Promise<string | undefined> {
    try {
      const tx = await rpc
        .getTransaction(record.signature as Signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'json' })
        .send()
      return tx?.meta?.fee.toString()
    } catch {
      return undefined // cosmetic; never block confirmation on it
    }
  }

  #fail(recordId: string, error: TxErrorInfo, extra: AnyRecordPatch = {}): void {
    this.store.update(recordId, { status: 'failed', error, stuck: false, ...extra })
  }

  #tracked(chain: CaipChainId): SolanaTxRecord[] {
    return this.store
      .getState()
      .txs.filter((tx): tx is SolanaTxRecord => tx.namespace === 'solana' && tx.chain === chain && TRACKED_STATUSES.has(tx.status))
  }

  #trackedChains(): CaipChainId[] {
    return [
      ...new Set(
        this.store
          .getState()
          .txs.filter((tx): tx is SolanaTxRecord => tx.namespace === 'solana' && TRACKED_STATUSES.has(tx.status))
          .map((tx) => tx.chain),
      ),
    ]
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now()
  }
}

type RpcTransactionError = string | Readonly<Record<string, unknown>>

/**
 * `{ InstructionError: [index, { Custom: code }] }` → the failing program's error name, using the
 * program at `index` (from the simulated message, or from the signed one for on-chain failures).
 */
export function decodeSolanaError(
  err: RpcTransactionError,
  programs: readonly string[],
  programErrors: SolanaTxEngineOptions['programErrors'],
  kind: 'simulation_reverted' | 'reverted',
  logs?: readonly string[] | null,
): TxErrorInfo {
  if (typeof err === 'string') {
    if (err === 'InsufficientFundsForFee' || err === 'AccountNotFound') {
      return { kind: 'insufficient_funds', message: 'Not enough SOL to pay the transaction fee.' }
    }
    if (err === 'BlockhashNotFound') return { kind: 'expired', message: 'The blockhash expired. Try again.' }
    return { kind, message: err }
  }
  const instructionError = err.InstructionError as [number, unknown] | undefined
  if (instructionError) {
    const [index, detail] = instructionError
    const program = programs[index]
    if (detail && typeof detail === 'object' && 'Custom' in detail) {
      const code = Number((detail as { Custom: unknown }).Custom)
      // System program error 1 = insufficient lamports for the transfer/allocation.
      if (program === '11111111111111111111111111111111' && code === 1) {
        return { kind: 'insufficient_funds', message: 'Not enough SOL for this transaction.' }
      }
      const name = program ? programErrors?.(program, code) : undefined
      return { kind, message: name ?? `Program error ${code}`, errorName: name ?? `Custom(${code})`, errorArgs: [String(code)] }
    }
    const reason = typeof detail === 'string' ? detail : JSON.stringify(detail)
    const logLine = logs?.find((l) => /Error|failed/i.test(l))
    return { kind, message: logLine ?? `Instruction ${index} failed: ${reason}`, errorName: reason }
  }
  return { kind, message: JSON.stringify(err) }
}

function solanaClientError(error: unknown): TxErrorInfo {
  const walletError = toWalletError(error)
  if (walletError.code === 'USER_REJECTED') return { kind: 'user_rejected', message: walletError.message }
  const message = messageOf(error)
  if (/fetch|network|timeout|ECONNREFUSED/i.test(message)) return { kind: 'network', message }
  return { kind: 'unknown', message }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Base64 wire transaction → bytes, e.g. to hand to a wallet's signAndSendTransaction. */
export const wireToBytes = (wire: string) => new Uint8Array(getBase64Encoder().encode(wire))
