import type { AnyTxRecord, LazyEngine, SolanaTxEngine, SuiTxEngine, TxEngine } from '@omnimarket/tx-engine'
import { createContext, use, useCallback, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react'

interface Engines {
  readonly evm: TxEngine
  readonly solana?: LazyEngine<SolanaTxEngine>
  readonly sui?: LazyEngine<SuiTxEngine>
}

const TxEngineContext = createContext<Engines | null>(null)

/**
 * One history, several lifecycles: the EVM, Solana and Sui engines share `engine.store`, so
 * `useTransactions()` is a single Activity list across chains.
 */
export function TxEngineProvider({
  engine,
  solana,
  sui,
  children,
}: {
  engine: TxEngine
  /** Loaded on demand (chain SDKs); the hooks below suspend until it is. */
  solana?: LazyEngine<SolanaTxEngine>
  sui?: LazyEngine<SuiTxEngine>
  children: ReactNode
}) {
  // Each start() resumes persisted pending transactions and is ref-counted (StrictMode-safe).
  useEffect(() => engine.start(), [engine])
  useEffect(() => solana?.start(), [solana])
  useEffect(() => sui?.start(), [sui])
  return <TxEngineContext value={{ evm: engine, solana, sui }}>{children}</TxEngineContext>
}

function useEngines(): Engines {
  const engines = useContext(TxEngineContext)
  if (!engines) throw new Error('Transaction hooks must be used inside <TxEngineProvider>')
  return engines
}

export function useTxEngine(): TxEngine {
  return useEngines().evm
}

/** Suspends while the Solana SDK loads: call it under a `<Suspense>` boundary. */
export function useSolanaTxEngine(): SolanaTxEngine {
  const lazy = useEngines().solana
  if (!lazy) throw new Error('<TxEngineProvider solana={…}> is not configured')
  return lazy.current ?? use(lazy.load())
}

/** Suspends while the Sui SDK loads: call it under a `<Suspense>` boundary. */
export function useSuiTxEngine(): SuiTxEngine {
  const lazy = useEngines().sui
  if (!lazy) throw new Error('<TxEngineProvider sui={…}> is not configured')
  return lazy.current ?? use(lazy.load())
}

export function useTransactions(): readonly AnyTxRecord[] {
  const { store } = useTxEngine()
  const getSnapshot = useCallback(() => store.getState().txs, [store])
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}

export function useTransaction(id: string | undefined): AnyTxRecord | undefined {
  const { store } = useTxEngine()
  // Records are replaced on every change and kept otherwise, so this snapshot is stable.
  const getSnapshot = useCallback(() => (id ? store.get(id) : undefined), [store, id])
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}
