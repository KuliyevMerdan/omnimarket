import type { ClientWithCoreApi, SuiClientTypes } from '@mysten/sui/client'
import { TransactionDataBuilder, type Transaction } from '@mysten/sui/transactions'
import { fromBase64 } from '@mysten/sui/utils'
import type { CaipAccountId, CaipChainId } from '@omnimarket/wallet-core'
import { parseAccountId, toWalletError } from '@omnimarket/wallet-core'
import type { SuiConnector } from '@omnimarket/wallet-core/sui'
import { PollScheduler, onWakeUp, type PollResult } from './scheduler'
import { stringifyArgs } from './serialize'
import type { AnyRecordPatch, TxStore } from './store'
import { TRACKED_STATUSES, type DecodedEvent, type SuiTxRecord, type TxErrorInfo } from './types'

export interface SuiTxEngineOptions {
  readonly store: TxStore
  readonly getClient: (chain: CaipChainId) => ClientWithCoreApi
  readonly pollingIntervalMs?: number
  /** Re-execute a signed transaction this often while it is unknown to the node (idempotent). */
  readonly resubmitIntervalMs?: number
  readonly stuckAfterMs?: number
  /** Unknown to the network this long after signing → dropped (its input objects likely moved on). */
  readonly dropAfterMs?: number
  readonly now?: () => number
}

export interface SuiSendRequest {
  readonly id?: string
  readonly label: string
  readonly connector: SuiConnector
  readonly account: CaipAccountId
  readonly transaction: Transaction
  /** `false`: done once effects are known (executed); `true` (default): wait for the checkpoint. */
  readonly waitForCheckpoint?: boolean
}

type Include = { effects: true; events: true }
const INCLUDE: Include = { effects: true, events: true }

/**
 * Sui transactions: build + simulate → sign → execute → checkpoint.
 * The digest is a hash of the signed bytes, known before submission, so a lost response never loses
 * the transaction: the tracker looks it up and re-executes the same signed bytes if needed.
 */
export class SuiTxEngine {
  readonly #options: SuiTxEngineOptions
  readonly #scheduler: PollScheduler<string>
  readonly #waitForCheckpoint = new Map<string, boolean>()
  #startCount = 0
  #detachWake: (() => void) | null = null

  constructor(options: SuiTxEngineOptions) {
    this.#options = options
    this.#scheduler = new PollScheduler((chain) => this.#pollChain(chain as CaipChainId), () => options.pollingIntervalMs ?? 1000)
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

  async send(request: SuiSendRequest): Promise<SuiTxRecord> {
    const { connector, account, transaction, label } = request
    const chain = connector.activeChain.caip
    const sender = parseAccountId(account).address
    const now = this.#now()
    const id = request.id ?? crypto.randomUUID()
    this.#waitForCheckpoint.set(id, request.waitForCheckpoint ?? true)
    this.store.insert({
      id,
      namespace: 'sui',
      label,
      chain,
      from: sender,
      status: 'preparing',
      createdAt: now,
      updatedAt: now,
      confirmations: 0,
      requiredConfirmations: 1,
      stuck: false,
    })

    try {
      const client = this.#options.getClient(chain)
      transaction.setSenderIfNotSet(sender)
      // Building resolves object versions and gas — and dry-runs the transaction to size the gas
      // budget, so a Move abort surfaces here already, as a structured `executionError`.
      let built: Uint8Array
      try {
        built = await transaction.build({ client })
      } catch (error) {
        const executionError = (error as { executionError?: SuiClientTypes.ExecutionError }).executionError
        if (!executionError) throw error
        this.#fail(id, decodeSuiError(executionError, 'simulation_reverted'))
        return (await this.store.waitFor(id)) as SuiTxRecord
      }
      const simulation = await client.core.simulateTransaction({ transaction: built, include: { effects: true } })
      if (simulation.$kind === 'FailedTransaction') {
        this.#fail(id, decodeSuiError(simulation.FailedTransaction.status.error, 'simulation_reverted'))
        return (await this.store.waitFor(id)) as SuiTxRecord
      }

      this.store.update(id, { status: 'awaiting_signature' })
      if (connector.canSignTransaction) {
        const signed = await connector.signTransaction(account, transaction)
        const digest = TransactionDataBuilder.getDigestFromBytes(fromBase64(signed.bytes))
        const record = this.store.update(id, {
          status: 'pending',
          digest,
          signedBytes: signed.bytes,
          signature: signed.signature,
          submittedAt: this.#now(),
        }) as SuiTxRecord
        await this.#execute(client, record)
      } else {
        const { digest } = await connector.signAndExecuteTransaction(account, transaction)
        this.store.update(id, { status: 'pending', digest, submittedAt: this.#now() })
      }
      if (this.store.get(id)?.status === 'pending' || this.store.get(id)?.status === 'confirming') this.#scheduler.ensure(chain)
    } catch (error) {
      this.#fail(id, suiClientError(error))
    }
    return (await this.store.waitFor(id)) as SuiTxRecord
  }

  async #execute(client: ClientWithCoreApi, record: SuiTxRecord): Promise<void> {
    if (!record.signedBytes || !record.signature) return
    this.store.update(record.id, { lastSubmitAt: this.#now() })
    try {
      const result = await client.core.executeTransaction({
        transaction: fromBase64(record.signedBytes),
        signatures: [record.signature],
        include: INCLUDE,
      })
      this.#apply(record, result)
    } catch (error) {
      const info = suiClientError(error)
      // Input objects already consumed by another transaction (e.g. a second tab): this one can never run.
      if (/ObjectVersionUnavailable|ObjectLocked|equivocat|already locked/i.test(info.message)) {
        this.#fail(record.id, { kind: 'dropped', message: 'Another transaction already used these objects. Nothing was executed.' })
        return
      }
      // Anything else (timeouts, 5xx): stay pending, the digest is known, the tracker will find or resubmit it.
      this.store.update(record.id, { syncError: info.message })
    }
  }

  #apply(record: SuiTxRecord, result: SuiClientTypes.TransactionResult<Include>): void {
    const tx = result.Transaction ?? result.FailedTransaction
    const gas = tx.effects?.gasUsed
    const gasUsed = gas
      ? (BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate)).toString()
      : undefined
    const base: AnyRecordPatch = { gasUsed, syncError: undefined, stuck: false, checkpoint: tx.checkpoint ?? undefined }

    if (result.$kind === 'FailedTransaction') {
      this.#fail(record.id, decodeSuiError(tx.status.error, 'reverted'), base)
      return
    }
    const done = tx.checkpoint !== null || !(this.#waitForCheckpoint.get(record.id) ?? true)
    this.store.update(record.id, {
      ...base,
      status: done ? 'confirmed' : 'confirming',
      confirmations: done ? 1 : 0,
      events: decodeSuiEvents(tx.events),
    })
  }

  async #pollChain(chain: CaipChainId): Promise<PollResult> {
    const tracked = this.#tracked(chain).filter((r) => r.digest)
    if (tracked.length === 0) return { active: this.#tracked(chain).length > 0, failed: false }
    const client = this.#options.getClient(chain)
    let failed = false
    for (const record of tracked) {
      try {
        const result = await client.core.getTransaction({ digest: record.digest!, include: INCLUDE })
        this.#apply(record, result)
      } catch (error) {
        const message = suiClientError(error).message
        if (!/not.?found/i.test(message)) {
          failed = true
          this.store.update(record.id, { syncError: message })
          continue
        }
        const now = this.#now()
        const age = now - (record.submittedAt ?? record.createdAt)
        if (age > (this.#options.dropAfterMs ?? 60_000)) {
          this.#fail(record.id, { kind: 'dropped', message: 'The network never accepted this transaction. Nothing was executed.' })
        } else if (record.signedBytes && now - (record.lastSubmitAt ?? 0) >= (this.#options.resubmitIntervalMs ?? 3000)) {
          await this.#execute(client, record)
        } else {
          this.store.update(record.id, { stuck: age > (this.#options.stuckAfterMs ?? 20_000) })
        }
      }
    }
    return { active: this.#tracked(chain).length > 0, failed }
  }

  #fail(id: string, error: TxErrorInfo, extra: AnyRecordPatch = {}): void {
    this.store.update(id, { status: 'failed', error, stuck: false, ...extra })
    this.#waitForCheckpoint.delete(id)
  }

  #tracked(chain: CaipChainId): SuiTxRecord[] {
    return this.store
      .getState()
      .txs.filter((tx): tx is SuiTxRecord => tx.namespace === 'sui' && tx.chain === chain && TRACKED_STATUSES.has(tx.status))
  }

  #trackedChains(): CaipChainId[] {
    return [
      ...new Set(
        this.store
          .getState()
          .txs.filter((tx): tx is SuiTxRecord => tx.namespace === 'sui' && TRACKED_STATUSES.has(tx.status))
          .map((tx) => tx.chain),
      ),
    ]
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now()
  }
}

/**
 * Move aborts carry "clever errors": the constant's name and its message, e.g.
 * `EInvalidAmount: "Mint 1 to 5 at a time"`, so users see the contract's own words.
 */
export function decodeSuiError(error: SuiClientTypes.ExecutionError | null, kind: 'simulation_reverted' | 'reverted'): TxErrorInfo {
  if (!error) return { kind, message: 'Execution failed' }
  if (/InsufficientGas|InsufficientCoinBalance|insufficient/i.test(`${error.$kind} ${error.message}`)) {
    return { kind: 'insufficient_funds', message: 'Not enough SUI for this transaction and gas.' }
  }
  if (error.$kind === 'MoveAbort') {
    const abort = error.MoveAbort
    const clever = abort.cleverError
    const where = [abort.location?.module, abort.location?.functionName].filter(Boolean).join('::')
    return {
      kind,
      message: clever?.value ? stripQuotes(clever.value) : `Aborted with code ${abort.abortCode}${where ? ` in ${where}` : ''}`,
      errorName: clever?.constantName ?? `MoveAbort(${abort.abortCode})`,
      errorArgs: [abort.abortCode],
    }
  }
  return { kind, message: error.message, errorName: error.$kind }
}

function decodeSuiEvents(events: readonly SuiClientTypes.Event[] | undefined): DecodedEvent[] {
  return (events ?? []).map((event) => ({
    address: event.packageId,
    // `0x2::kiosk::ItemListed<0xabc::omni_nft::OmniNft>` → `ItemListed`
    eventName: event.eventType.replace(/<.*>$/, '').split('::').pop() ?? event.eventType,
    args: stringifyArgs(event.json ?? {}),
  }))
}

function suiClientError(error: unknown): TxErrorInfo {
  const walletError = toWalletError(error)
  if (walletError.code === 'USER_REJECTED') return { kind: 'user_rejected', message: walletError.message }
  const message = error instanceof Error ? error.message : String(error)
  if (/No valid gas coins|InsufficientGas|InsufficientCoinBalance|balance/i.test(message)) {
    return { kind: 'insufficient_funds', message: 'Not enough SUI for this transaction and gas.' }
  }
  if (/fetch|network|timeout|ECONNREFUSED|unavailable/i.test(message)) return { kind: 'network', message }
  return { kind: 'unknown', message }
}

function stripQuotes(value: string): string {
  return value.replace(/^"(.*)"$/, '$1')
}
