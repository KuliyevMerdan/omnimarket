import {
  BaseError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  isAddressEqual,
  parseEventLogs,
  type Abi,
  type Hex,
  type PublicClient,
  type Transaction,
  type TransactionReceipt,
} from 'viem'
import { decodeWithAbis } from './errors'
import { stringifyArgs, toSerializable } from './serialize'
import type { DecodedEvent, TxAttempt, TxRecord } from './types'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }
export type RecordPatch = Partial<Mutable<Omit<TxRecord, 'id' | 'createdAt'>>>

export interface PollContext {
  readonly client: PublicClient
  readonly head: bigint
  readonly now: number
  readonly abis: readonly Abi[]
  readonly stuckAfterMs: number
  readonly dropAfterMs: number
}

/**
 * One polling step for one broadcast transaction. Pure apart from RPC reads: returns a patch,
 * the engine applies it. Handles what `waitForTransactionReceipt` alone does not:
 * - several hashes for one nonce (our own speed-ups / cancels);
 * - a replacement mined while we weren't watching (after a reload), found by nonce;
 * - reorgs (receipt disappears → back to pending);
 * - stuck and dropped transactions.
 */
export async function pollRecord(ctx: PollContext, record: TxRecord): Promise<RecordPatch> {
  const { client } = ctx
  let attempts = record.attempts
  let nonce = record.nonce
  const patch: RecordPatch = {}

  // RPC nodes can lag a few seconds behind the wallet's broadcast: learn nonce and fees lazily.
  if (attempts.some((a) => !hasFees(a)) || nonce === undefined) {
    attempts = await Promise.all(
      attempts.map(async (attempt) => {
        if (hasFees(attempt) && nonce !== undefined) return attempt
        const tx = await getTransaction(client, attempt.hash)
        if (!tx) return attempt
        nonce ??= tx.nonce
        return { ...attempt, ...feesOf(tx) }
      }),
    )
    patch.attempts = attempts
    if (nonce !== undefined) patch.nonce = nonce
  }
  const current = { ...record, attempts, nonce }

  const mined = await findReceipt(client, attempts)
  if (mined) return { ...patch, ...(await fromReceipt(ctx, current, mined.attempt, mined.receipt)) }

  if (record.status === 'confirming') {
    // The block holding our receipt was reorged out; the tx is back in the mempool (or gone).
    patch.status = 'pending'
    patch.confirmations = 0
    patch.blockNumber = undefined
    patch.minedHash = undefined
  }

  if (nonce !== undefined) {
    const minedCount = await client.getTransactionCount({ address: record.from, blockTag: 'latest' })
    if (minedCount > nonce) {
      // Mined between the two reads?
      const late = await findReceipt(client, attempts)
      if (late) return { ...patch, ...(await fromReceipt(ctx, current, late.attempt, late.receipt)) }
      return { ...patch, ...(await resolveForeignNonce(ctx, current, nonce)) }
    }
  }

  const pendingFor = ctx.now - (record.submittedAt ?? record.createdAt)
  const stuck = pendingFor > ctx.stuckAfterMs
  if (stuck && pendingFor > ctx.dropAfterMs) {
    const known = await Promise.all(attempts.map((a) => getTransaction(client, a.hash)))
    if (known.every((tx) => !tx)) {
      return {
        ...patch,
        status: 'failed',
        stuck: false,
        error: { kind: 'dropped', message: 'The network dropped this transaction. Nothing was executed.' },
      }
    }
  }
  return { ...patch, stuck, syncError: undefined }
}

/** Another transaction consumed our nonce. Find it (binary search by nonce) and classify it. */
async function resolveForeignNonce(ctx: PollContext, record: TxRecord, nonce: number): Promise<RecordPatch> {
  const found = await findTransactionByNonce(ctx, record, nonce).catch(() => undefined)
  if (!found) {
    return { status: 'replaced', stuck: false, replacement: undefined }
  }

  const reason = classifyReplacement(found, record)
  if (reason === 'replaced') {
    return { status: 'replaced', stuck: false, minedHash: found.hash, replacement: { hash: found.hash, reason } }
  }
  // Repriced/cancelled from the wallet's own UI (MetaMask "Speed up"): adopt it as an attempt,
  // so confirmations are tracked exactly like our own replacements.
  const attempt: TxAttempt = {
    hash: found.hash,
    kind: reason === 'cancelled' ? 'cancel' : 'speedup',
    sentAt: ctx.now,
    ...feesOf(found),
  }
  const attempts = [...record.attempts, attempt]
  const receipt = await getReceipt(ctx.client, found.hash)
  if (!receipt) return { attempts }
  return { attempts, ...(await fromReceipt(ctx, { ...record, attempts }, attempt, receipt)) }
}

async function findTransactionByNonce(ctx: PollContext, record: TxRecord, nonce: number): Promise<Transaction | undefined> {
  const { client, head } = ctx
  // The first block where the account's nonce exceeds ours contains the transaction.
  let low = record.submittedBlock ? BigInt(record.submittedBlock) : head > 256n ? head - 256n : 0n
  let high = head
  while (low < high) {
    const mid = (low + high) / 2n
    const count = await client.getTransactionCount({ address: record.from, blockNumber: mid })
    if (count > nonce) high = mid
    else low = mid + 1n
  }
  const block = await client.getBlock({ blockNumber: low, includeTransactions: true })
  return block.transactions.find((tx) => isAddressEqual(tx.from, record.from) && tx.nonce === nonce)
}

export function classifyReplacement(tx: Transaction, record: TxRecord): 'repriced' | 'cancelled' | 'replaced' {
  const request = record.request
  if (
    request &&
    (tx.to && request.to ? isAddressEqual(tx.to, request.to) : tx.to === (request.to ?? null)) &&
    tx.value === BigInt(request.value) &&
    tx.input === (request.data ?? '0x')
  ) {
    return 'repriced'
  }
  if (tx.to && isAddressEqual(tx.to, record.from) && tx.value === 0n) return 'cancelled'
  return 'replaced'
}

async function fromReceipt(
  ctx: PollContext,
  record: TxRecord,
  attempt: TxAttempt,
  receipt: TransactionReceipt,
): Promise<RecordPatch> {
  // Load-balanced RPCs can return a head older than the receipt's block.
  const confirmations = Math.max(1, Number(ctx.head - receipt.blockNumber + 1n))
  const base: RecordPatch = {
    minedHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    confirmations,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    stuck: false,
    syncError: undefined,
  }
  if (confirmations < record.requiredConfirmations) return { ...base, status: 'confirming' }

  if (attempt.kind === 'cancel') {
    return { ...base, status: 'cancelled', replacement: { hash: attempt.hash, reason: 'cancelled' } }
  }
  const replacement = attempt.kind === 'speedup' ? ({ hash: attempt.hash, reason: 'repriced' } as const) : undefined

  if (receipt.status === 'reverted') {
    return {
      ...base,
      status: 'failed',
      ...(replacement ? { replacement } : {}),
      error: await explainRevert(ctx, record, receipt),
    }
  }
  return {
    ...base,
    status: 'confirmed',
    ...(replacement ? { replacement } : {}),
    events: decodeEvents(receipt, ctx.abis),
  }
}

/**
 * Receipts carry no revert reason, so replay the call. On the block's *post*-state, not the parent's:
 * a reverted tx changed nothing, and the typical cause is something else in the same block (another
 * buyer filled the order first; the block timestamp passed the deadline), which only post-state shows.
 */
async function explainRevert(ctx: PollContext, record: TxRecord, receipt: TransactionReceipt) {
  const fallback = { kind: 'reverted' as const, message: 'The transaction reverted on-chain.' }
  if (!record.request?.to) return fallback
  try {
    await ctx.client.call({
      account: record.from,
      to: record.request.to,
      data: record.request.data,
      value: BigInt(record.request.value),
      blockNumber: receipt.blockNumber,
    })
    // Succeeds on replay: most likely out of gas (used exactly the limit).
    return receipt.gasUsed.toString() === record.request.gas
      ? { ...fallback, message: 'The transaction ran out of gas.' }
      : fallback
  } catch (error) {
    const data = revertData(error)
    const decoded = data ? decodeWithAbis(data, ctx.abis) : undefined
    if (!decoded) return fallback
    return {
      ...fallback,
      errorName: decoded.errorName,
      errorArgs: decoded.args ? (toSerializable([...decoded.args]) as unknown[]).map(String) : [],
      message: `Reverted with ${decoded.errorName}`,
    }
  }
}

function revertData(error: unknown): Hex | undefined {
  if (!(error instanceof BaseError)) return undefined
  const withData = error.walk((e) => typeof (e as { data?: unknown }).data === 'string')
  const data = (withData as { data?: string } | null)?.data
  return data?.startsWith('0x') ? (data as Hex) : undefined
}

export function decodeEvents(receipt: TransactionReceipt, abis: readonly Abi[]): DecodedEvent[] {
  if (abis.length === 0) return []
  const logs = parseEventLogs({ abi: abis.flat() as Abi, logs: receipt.logs, strict: true })
  return logs.map((log) => ({
    address: log.address,
    eventName: (log as { eventName: string }).eventName,
    args: stringifyArgs((log as { args?: unknown }).args),
  }))
}

async function findReceipt(client: PublicClient, attempts: readonly TxAttempt[]) {
  // Newest attempt first: it is the most likely one to be mined.
  for (const attempt of [...attempts].reverse()) {
    const receipt = await getReceipt(client, attempt.hash)
    if (receipt) return { attempt, receipt }
  }
  return undefined
}

async function getReceipt(client: PublicClient, hash: Hex): Promise<TransactionReceipt | undefined> {
  try {
    return await client.getTransactionReceipt({ hash })
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return undefined
    throw error
  }
}

async function getTransaction(client: PublicClient, hash: Hex): Promise<Transaction | undefined> {
  try {
    return await client.getTransaction({ hash })
  } catch (error) {
    if (error instanceof TransactionNotFoundError) return undefined
    throw error
  }
}

function hasFees(attempt: TxAttempt): boolean {
  return attempt.maxFeePerGas !== undefined || attempt.gasPrice !== undefined
}

function feesOf(tx: Transaction): Pick<TxAttempt, 'maxFeePerGas' | 'maxPriorityFeePerGas' | 'gasPrice'> {
  if (tx.maxFeePerGas !== undefined && tx.maxFeePerGas !== null) {
    return {
      maxFeePerGas: tx.maxFeePerGas.toString(),
      maxPriorityFeePerGas: (tx.maxPriorityFeePerGas ?? 0n).toString(),
    }
  }
  return tx.gasPrice !== undefined && tx.gasPrice !== null ? { gasPrice: tx.gasPrice.toString() } : {}
}
