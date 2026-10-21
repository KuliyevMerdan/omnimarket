import {
  parseAccountId,
  type CaipAccountId,
  type CaipChainId,
  type WalletManager,
  type WalletState,
  type WalletStatus,
} from '@omnimarket/wallet-core'
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'

const WalletContext = createContext<WalletManager | null>(null)

export function WalletProvider({ manager, children }: { manager: WalletManager; children: ReactNode }) {
  // `start` is ref-counted and returns its own cleanup, so StrictMode's double effect is safe.
  useEffect(() => manager.start(), [manager])
  return <WalletContext value={manager}>{children}</WalletContext>
}

export function useWalletManager(): WalletManager {
  const manager = useContext(WalletContext)
  if (!manager) throw new Error('useWalletManager must be used inside <WalletProvider>')
  return manager
}

/**
 * Subscribes to a slice of wallet state. Tearing-free under concurrent rendering thanks to
 * `useSyncExternalStore`. The selector must return a stable value (a state field, a primitive);
 * derive objects with `useMemo` on top instead.
 */
export function useWalletState(): WalletState
export function useWalletState<T>(selector: (state: WalletState) => T): T
export function useWalletState<T>(selector?: (state: WalletState) => T): T | WalletState {
  const manager = useWalletManager()
  const getSnapshot: () => T | WalletState = selector ? () => selector(manager.getState()) : manager.getState
  return useSyncExternalStore<T | WalletState>(manager.subscribe, getSnapshot, getSnapshot)
}

const selectWallets = (s: WalletState) => s.wallets
const selectConnection = (s: WalletState) => s.connection
const selectStatus = (s: WalletState) => s.status
const selectError = (s: WalletState) => s.error
const selectActiveWalletId = (s: WalletState) => s.activeWalletId

export const useWallets = () => useWalletState(selectWallets)
export const useWalletError = () => useWalletState(selectError)

export interface AccountState {
  readonly status: WalletStatus
  readonly walletId: string | null
  readonly account: CaipAccountId | undefined
  readonly address: string | undefined
  readonly chainId: CaipChainId | undefined
  readonly namespace: string | undefined
}

export function useAccount(): AccountState {
  const status = useWalletState(selectStatus)
  const connection = useWalletState(selectConnection)
  const walletId = useWalletState(selectActiveWalletId)
  return useMemo(() => {
    const account = connection?.accounts[0]
    const parsed = account ? parseAccountId(account) : undefined
    return {
      status,
      walletId,
      account,
      address: parsed?.address,
      chainId: connection?.chainId,
      namespace: parsed?.namespace,
    }
  }, [status, connection, walletId])
}
