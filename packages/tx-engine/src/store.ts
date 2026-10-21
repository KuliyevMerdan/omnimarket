import { createBrowserStorage, createStore, type KeyValueStorage, type ReadableStore } from '@omnimarket/wallet-core'
import { TERMINAL_STATUSES, type AnyTxRecord } from './types'

export interface TxStoreState {
  /** Newest first, all ecosystems. */
  readonly txs: readonly AnyTxRecord[]
}

export interface TxStoreOptions {
  readonly storage?: KeyValueStorage
  readonly storageKey?: string
  readonly maxRecords?: number
  readonly now?: () => number
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }
/** A patch for any record shape; engines only patch records of their own namespace. */
export type AnyRecordPatch = Partial<Mutable<Omit<AnyTxRecord, 'id' | 'createdAt' | 'namespace'>>> & Record<string, unknown>

/**
 * One persisted history for every chain engine (EVM, Solana, Sui), so the UI has a single
 * Activity list and a single subscription. Engines own their records' lifecycles; the store
 * owns persistence, size limits, and "wait until terminal" promises.
 */
export class TxStore implements ReadableStore<TxStoreState> {
  readonly #storage: KeyValueStorage
  readonly #storageKey: string
  readonly #maxRecords: number
  readonly #now: () => number
  readonly #store
  readonly #waiters = new Map<string, ((record: AnyTxRecord) => void)[]>()

  constructor(options: TxStoreOptions = {}) {
    this.#storage = options.storage ?? createBrowserStorage()
    this.#storageKey = options.storageKey ?? 'omni:txs'
    this.#maxRecords = options.maxRecords ?? 50
    this.#now = options.now ?? Date.now
    this.#store = createStore<TxStoreState>({ txs: this.#load() })
  }

  getState = (): TxStoreState => this.#store.getState()
  subscribe = (listener: () => void): (() => void) => this.#store.subscribe(listener)

  get(id: string): AnyTxRecord | undefined {
    return this.getState().txs.find((tx) => tx.id === id)
  }

  insert(record: AnyTxRecord): void {
    if (this.get(record.id)) throw new Error(`Transaction ${record.id} already exists`)
    this.#set([record, ...this.getState().txs].slice(0, this.#maxRecords))
  }

  update(id: string, patch: AnyRecordPatch): AnyTxRecord | undefined {
    let updated: AnyTxRecord | undefined
    const txs = this.getState().txs.map((tx) => {
      if (tx.id !== id) return tx
      updated = { ...tx, ...patch, updatedAt: this.#now() } as AnyTxRecord
      return updated
    })
    if (!updated) return undefined
    this.#set(txs)
    if (TERMINAL_STATUSES.has(updated.status)) {
      const waiters = this.#waiters.get(id) ?? []
      this.#waiters.delete(id)
      for (const resolve of waiters) resolve(updated)
    }
    return updated
  }

  remove(id: string): void {
    this.#set(this.getState().txs.filter((tx) => tx.id !== id))
  }

  clearFinished(): void {
    this.#set(this.getState().txs.filter((tx) => !TERMINAL_STATUSES.has(tx.status)))
  }

  waitFor(id: string): Promise<AnyTxRecord> {
    const record = this.get(id)
    if (!record) return Promise.reject(new Error(`Unknown transaction ${id}`))
    if (TERMINAL_STATUSES.has(record.status)) return Promise.resolve(record)
    return new Promise((resolve) => {
      this.#waiters.set(id, [...(this.#waiters.get(id) ?? []), resolve])
    })
  }

  #set(txs: readonly AnyTxRecord[]): void {
    this.#store.setState({ txs })
    try {
      this.#storage.setItem(this.#storageKey, JSON.stringify(txs))
    } catch {
      // Quota exceeded: history is a convenience, tracking continues in memory.
    }
  }

  #load(): AnyTxRecord[] {
    try {
      const parsed = JSON.parse(this.#storage.getItem(this.#storageKey) ?? '[]') as unknown
      if (!Array.isArray(parsed)) return []
      return (parsed as AnyTxRecord[])
        .filter((tx) => tx && typeof tx.id === 'string' && typeof tx.status === 'string')
        .map((tx) =>
          // A wallet prompt can't survive a reload; neither can a half-built transaction.
          tx.status === 'preparing' || tx.status === 'awaiting_signature'
            ? ({
                ...tx,
                status: 'failed',
                error: { kind: 'interrupted', message: 'The page was closed before the wallet confirmed.' },
              } as AnyTxRecord)
            : tx,
        )
    } catch {
      return []
    }
  }
}
