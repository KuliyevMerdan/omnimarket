import type { WalletConnectSession, WalletConnectState } from '@omnimarket/wallet-core/walletconnect'
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'

const WalletConnectContext = createContext<WalletConnectSession | null>(null)

/** Optional: apps without a WalletConnect project id simply don't render it. */
export function WalletConnectProvider({ session, children }: { session: WalletConnectSession | null; children: ReactNode }) {
  return <WalletConnectContext value={session}>{children}</WalletConnectContext>
}

export function useWalletConnectSession(): WalletConnectSession | null {
  return useContext(WalletConnectContext)
}

const IDLE: WalletConnectState = { status: 'idle', uri: null, peer: null, namespaces: {}, expiresAt: null, error: null }
const noop = () => () => {}

/** Pairing URI, peer and approved namespaces; `idle` when WalletConnect is not configured. */
export function useWalletConnect(): WalletConnectState {
  const session = useWalletConnectSession()
  return useSyncExternalStore(session?.subscribe ?? noop, session?.getState ?? (() => IDLE), session?.getState ?? (() => IDLE))
}
