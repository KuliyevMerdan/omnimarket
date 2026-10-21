import type { AnyTxRecord, SolanaTxEngine, SuiTxEngine, TxEngine } from '@omnimarket/tx-engine'
import { createContext, useCallback, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react'

interface Engines {
  readonly evm: TxEngine
  readonly solana?: SolanaTxEngine
  readonly sui?: SuiTxEngine
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
  solana?: SolanaTxEngine
  sui?: SuiTxEngine
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

export function useSolanaTxEngine(): SolanaTxEngine {
  const engine = useEngines().solana
  if (!engine) throw new Error('<TxEngineProvider solana={…}> is not configured')
  return engine
}

export function useSuiTxEngine(): SuiTxEngine {
  const engine = useEngines().sui
  if (!engine) throw new Error('<TxEngineProvider sui={…}> is not configured')
  return engine
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
