import { parseAccountId, type CaipAccountId, type CaipChainId, type WalletManager, type WalletState, type WalletStatus } from '@omnimarket/wallet-core'
import type { WalletConnectState } from '@omnimarket/wallet-core/walletconnect'
import { computed, shallowRef, type ComputedRef, type ShallowRef } from 'vue'
import { useOmni } from './plugin'
import { useStore } from './store'

export function useWalletManager(): WalletManager {
  return useOmni().manager
}

export function useWalletState(): Readonly<ShallowRef<WalletState>> {
  return useStore(useWalletManager())
}

export interface AccountState {
  readonly status: WalletStatus
  readonly walletId: string | null
  readonly account: CaipAccountId | undefined
  readonly address: string | undefined
  readonly chainId: CaipChainId | undefined
  readonly namespace: string | undefined
}

/** Same shape as `useAccount()` in @omnimarket/react. */
export function useAccount(): ComputedRef<AccountState> {
  return accountOf(useWalletState())
}

export function accountOf(state: Readonly<ShallowRef<WalletState>>): ComputedRef<AccountState> {
  return computed(() => {
    const { status, connection, activeWalletId } = state.value
    const account = connection?.accounts[0]
    const parsed = account ? parseAccountId(account) : undefined
    return { status, walletId: activeWalletId, account, address: parsed?.address, chainId: connection?.chainId, namespace: parsed?.namespace }
  })
}

export function useWallets() {
  const state = useWalletState()
  return computed(() => state.value.wallets)
}

export function useWalletError() {
  const state = useWalletState()
  return computed(() => state.value.error)
}

const IDLE: WalletConnectState = { status: 'idle', uri: null, peer: null, namespaces: {}, expiresAt: null, error: null }

/** Pairing URI, peer and approved namespaces; `idle` when WalletConnect is not configured. */
export function useWalletConnect(): Readonly<ShallowRef<WalletConnectState>> {
  const session = useOmni().walletConnect
  return session ? useStore(session) : shallowRef(IDLE)
}
