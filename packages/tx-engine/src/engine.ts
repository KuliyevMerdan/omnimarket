import type { KeyValueStorage, ReadableStore, WalletInfo } from '@omnimarket/wallet-core'
import {
  encodeFunctionData,
  type Abi,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
  type PublicClient,
} from 'viem'
import { decodeTxError } from './errors'
import { PollScheduler, onWakeUp, type PollResult } from './scheduler'
import { TxStore, type TxStoreState } from './store'
import { pollRecord, type RecordPatch } from './tracker'
import { TRACKED_STATUSES, isEvmRecord, type EvmSigner, type TxAttempt, type TxRecord } from './types'

export interface TxEngineOptions {
  readonly getPublicClient: (chainId: number) => PublicClient
  /** ABIs used to decode events and custom errors — also for transactions resumed after a reload. */
  readonly abis?: readonly Abi[]
  /** Shared history with the Solana/Sui engines. Created from `storage` options when omitted. */
  readonly store?: TxStore
  readonly storage?: KeyValueStorage
  readonly storageKey?: string
  readonly maxRecords?: number
  readonly pollingIntervalMs?: number
  readonly stuckAfterMs?: number | ((chainId: number) => number)
  readonly dropAfterMs?: number
  /**
   * Whether a wallet honours a dApp-supplied `nonce`. Wallets that ignore it (MetaMask does) would turn
   * "speed up" into a second, independent transaction — so replacement is opt-in per wallet, and users of
   * other wallets use the wallet's own speed-up, which the tracker detects as `repriced`.
   */
  readonly canReplace?: (wallet: WalletInfo) => boolean
  readonly now?: () => number
  readonly createId?: () => string
}

export type TxEngineState = TxStoreState

interface CommonRequest {
  /** Pre-generated record id, so the caller can bind UI to the tx before it resolves. */
  readonly id?: string
  readonly signer: EvmSigner
  readonly account: Address
  readonly chainId: number
  readonly label: string
  readonly confirmations?: number
}

type WriteMutability = 'nonpayable' | 'payable'

export type WriteContractRequest<
  abi extends Abi,
  functionName extends ContractFunctionName<abi, WriteMutability>,
> = CommonRequest & {
  readonly address: Address
  readonly abi: abi
  readonly functionName: functionName
  readonly args?: ContractFunctionArgs<abi, WriteMutability, functionName>
  readonly value?: bigint
}

export type SendTransactionRequest = CommonRequest & {
  readonly to: Address
  readonly data?: Hex
  readonly value?: bigint
}

const GAS_BUFFER_PERCENT = 120n
/** Geth/Erigon reject replacements that don't raise both fee fields by ≥10%. */
const REPLACEMENT_BUMP_PERMILLE = 1125n

/** EVM transactions: simulate → sign → track (same-nonce replacements, reorgs, drops). */
export class TxEngine implements ReadableStore<TxEngineState> {
  readonly #options: TxEngineOptions
  readonly store: TxStore
  readonly #scheduler: PollScheduler<number>
  #startCount = 0
  #detachWake: (() => void) | null = null

  constructor(options: TxEngineOptions) {
    this.#options = options
    this.store =
      options.store ??
      new TxStore({ storage: options.storage, storageKey: options.storageKey, maxRecords: options.maxRecords, now: options.now })
    this.#scheduler = new PollScheduler(
      (chainId) => this.#pollChain(chainId),
      () => options.pollingIntervalMs ?? 4000,
    )
  }

  getState = (): TxEngineState => this.store.getState()
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  get(id: string): TxRecord | undefined {
    const record = this.store.get(id)
    return record && isEvmRecord(record) ? record : undefined
  }

  /** Resumes tracking of persisted transactions; re-polls when the tab regains network or focus. */
  start(): () => void {
    if (this.#startCount++ === 0) {
      for (const chainId of this.#trackedChains()) this.#scheduler.ensure(chainId)
      this.#detachWake = onWakeUp(() => this.#scheduler.wake(this.#trackedChains()))
    }
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      if (--this.#startCount > 0) return
      this.#detachWake?.()
      this.#detachWake = null
      this.#scheduler.stop()
    }
  }

  /**
   * Simulate → estimate gas → (switch chain) → sign → track. Resolves with the terminal record and
   * never rejects: failures are part of the lifecycle, the record carries a decoded error.
   */
  writeContract<const abi extends Abi, functionName extends ContractFunctionName<abi, WriteMutability>>(
    request: WriteContractRequest<abi, functionName>,
  ): Promise<TxRecord> {
    const { abi, functionName, args, address, value = 0n, account } = request
    const data = encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0])
    return this.#submit({ ...request, to: address, data, value }, [abi], (client) =>
      client.simulateContract({ account, address, abi, functionName, args, value } as unknown as Parameters<
        PublicClient['simulateContract']
      >[0]),
    )
  }

  sendTransaction(request: SendTransactionRequest): Promise<TxRecord> {
    const { account, to, data, value = 0n } = request
    return this.#submit({ ...request, value }, [], (client) => client.call({ account, to, data, value }))
  }

  canReplace(record: TxRecord | undefined, signer: EvmSigner | null | undefined): boolean {
    return (
      !!record &&
      !!signer &&
      record.status === 'pending' &&
      record.nonce !== undefined &&
      !!record.request &&
      signer.chainId === record.chainId &&
      (this.#options.canReplace?.(signer.info) ?? false)
    )
  }

  speedUp(id: string, signer: EvmSigner): Promise<void> {
    return this.#replace(id, signer, 'speedup')
  }

  /** Sends a 0-value self-transfer with the same nonce. Racy by nature: the original may still win. */
  cancel(id: string, signer: EvmSigner): Promise<void> {
    return this.#replace(id, signer, 'cancel')
  }

  remove(id: string): void {
    this.store.remove(id)
  }

  clearFinished(): void {
    this.store.clearFinished()
  }

  /** Runs one polling round immediately (tests, "refresh" buttons, tab focus). */
  async pollNow(chainId?: number): Promise<void> {
    const chains = chainId === undefined ? this.#trackedChains() : [chainId]
    await Promise.all(chains.map((id) => this.#scheduler.now(id)))
  }

  waitFor(id: string): Promise<TxRecord> {
    return this.store.waitFor(id) as Promise<TxRecord>
  }

  async #submit(
    request: CommonRequest & { to: Address; data?: Hex; value: bigint },
    extraAbis: readonly Abi[],
    simulate: (client: PublicClient) => Promise<unknown>,
  ): Promise<TxRecord> {
    const { signer, account, chainId, label, to, data, value } = request
    const abis = [...extraAbis, ...(this.#options.abis ?? [])]
    const now = this.#now()
    const id = request.id ?? this.#options.createId?.() ?? crypto.randomUUID()
    this.#insert({
      id,
      label,
      chainId,
      from: account,
      status: 'preparing',
      createdAt: now,
      updatedAt: now,
      attempts: [],
      confirmations: 0,
      requiredConfirmations: Math.max(1, request.confirmations ?? 1),
      stuck: false,
    })

    try {
      const client = this.#options.getPublicClient(chainId)
      // Pre-flight: never ask for a signature on a transaction that is going to revert.
      await simulate(client)
      const estimated = await client.estimateGas({ account, to, data, value })
      const gas = (estimated * GAS_BUFFER_PERCENT) / 100n

      // Switch only after simulation passed, so a doomed tx doesn't cost the user a network prompt.
      if (signer.chainId !== chainId) await signer.switchChain(`eip155:${chainId}`)

      this.#update(id, {
        status: 'awaiting_signature',
        request: { to, data, value: value.toString(), gas: gas.toString() },
      })
      const submittedBlock = await client.getBlockNumber().catch(() => undefined)
      const wallet = signer.getWalletClient()
      // Fees are left to the wallet: it knows the user's preferences and shows its own estimate.
      const hash = await wallet.sendTransaction({ account, chain: wallet.chain, to, data, value, gas })

      this.#update(id, {
        status: 'pending',
        attempts: [{ hash, kind: 'original', sentAt: this.#now() }],
        submittedAt: this.#now(),
        submittedBlock: submittedBlock?.toString(),
      })
      this.#scheduler.ensure(chainId)
    } catch (error) {
      this.#update(id, { status: 'failed', error: decodeTxError(error, abis) })
    }
    return this.waitFor(id)
  }

  async #replace(id: string, signer: EvmSigner, kind: 'speedup' | 'cancel'): Promise<void> {
    const record = this.get(id)
    if (!record || !this.canReplace(record, signer)) {
      throw new Error('This transaction cannot be replaced from the app. Use your wallet instead.')
    }
    const client = this.#options.getPublicClient(record.chainId)
    const fees = await nextFees(client, record.attempts.at(-1)!)
    const request = record.request!
    const body =
      kind === 'cancel'
        ? { to: record.from, value: 0n, gas: 21_000n }
        : { to: request.to!, data: request.data, value: BigInt(request.value), gas: request.gas ? BigInt(request.gas) : undefined }

    const wallet = signer.getWalletClient()
    const hash = await wallet.sendTransaction({
      account: record.from,
      chain: wallet.chain,
      nonce: record.nonce,
      ...body,
      ...fees.params,
    } as Parameters<typeof wallet.sendTransaction>[0])

    const attempt: TxAttempt = { hash, kind, sentAt: this.#now(), ...fees.attempt }
    this.#update(id, { attempts: [...record.attempts, attempt], stuck: false })

    // Trust, but verify: a wallet that ignored our nonce just sent a second, independent transaction.
    const sent = await client.getTransaction({ hash }).catch(() => undefined)
    if (sent && sent.nonce !== record.nonce) {
      this.#update(id, { attempts: record.attempts })
      const now = this.#now()
      this.#insert({
        ...record,
        id: this.#options.createId?.() ?? crypto.randomUUID(),
        label: `${record.label} (${kind === 'cancel' ? 'cancel' : 'speed-up'} sent as a new transaction)`,
        createdAt: now,
        updatedAt: now,
        submittedAt: now,
        attempts: [{ ...attempt, kind: 'original' }],
        nonce: sent.nonce,
      })
      throw new Error('Your wallet ignored the nonce and sent a separate transaction.')
    }
  }

  /** Ticks per chain are serialized: a manual `pollNow` waits for an in-flight background tick. */
  async #pollChain(chainId: number): Promise<PollResult> {
    const tracked = this.#tracked(chainId)
    if (tracked.length === 0) return { active: false, failed: false }
    let failed = false
    try {
      const client = this.#options.getPublicClient(chainId)
      const head = await client.getBlockNumber({ cacheTime: 0 })
      const ctx = {
        client,
        head,
        now: this.#now(),
        abis: this.#options.abis ?? [],
        stuckAfterMs: this.#stuckAfter(chainId),
        dropAfterMs: this.#options.dropAfterMs ?? 15 * 60_000,
      }
      const results = await Promise.allSettled(tracked.map((record) => pollRecord(ctx, record)))
      results.forEach((result, i) => {
        const id = tracked[i]!.id
        if (result.status === 'fulfilled') this.#update(id, result.value)
        else this.#update(id, { syncError: messageOf(result.reason) })
      })
      failed = results.some((r) => r.status === 'rejected')
    } catch (error) {
      // Weak network: keep records as they are, flag them, back off exponentially.
      failed = true
      for (const tx of tracked) this.#update(tx.id, { syncError: messageOf(error) })
    }
    return { active: this.#tracked(chainId).length > 0, failed }
  }

  #tracked(chainId: number): TxRecord[] {
    return this.getState().txs.filter(
      (tx): tx is TxRecord => isEvmRecord(tx) && tx.chainId === chainId && TRACKED_STATUSES.has(tx.status),
    )
  }

  #trackedChains(): number[] {
    return [
      ...new Set(
        this.getState()
          .txs.filter((tx): tx is TxRecord => isEvmRecord(tx) && TRACKED_STATUSES.has(tx.status))
          .map((tx) => tx.chainId),
      ),
    ]
  }

  #stuckAfter(chainId: number): number {
    const option = this.#options.stuckAfterMs
    return typeof option === 'function' ? option(chainId) : (option ?? 2 * 60_000)
  }

  #insert(record: TxRecord): void {
    this.store.insert(record)
  }

  #update(id: string, patch: RecordPatch): void {
    this.store.update(id, patch)
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now()
  }
}

async function nextFees(client: PublicClient, last: TxAttempt) {
  const bump = (value: string) => (BigInt(value) * REPLACEMENT_BUMP_PERMILLE) / 1000n + 1n
  const max = (...values: bigint[]) => values.reduce((a, b) => (b > a ? b : a))

  if (last.gasPrice !== undefined) {
    const gasPrice = max(bump(last.gasPrice), await client.getGasPrice())
    return { params: { gasPrice }, attempt: { gasPrice: gasPrice.toString() } }
  }
  const network = await client.estimateFeesPerGas()
  const maxPriorityFeePerGas = max(bump(last.maxPriorityFeePerGas ?? '0'), network.maxPriorityFeePerGas)
  const maxFeePerGas = max(bump(last.maxFeePerGas ?? '0'), network.maxFeePerGas, maxPriorityFeePerGas)
  return {
    params: { maxFeePerGas, maxPriorityFeePerGas },
    attempt: { maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: maxPriorityFeePerGas.toString() },
  }
}

function messageOf(error: unknown): string {
  return (error as { shortMessage?: string })?.shortMessage ?? (error instanceof Error ? error.message : String(error))
}
