import type { SiweClient } from '@omnimarket/auth/client'
import type { TxStore } from '@omnimarket/tx-engine'
import type { WalletManager } from '@omnimarket/wallet-core'
import type { WalletConnectSession } from '@omnimarket/wallet-core/walletconnect'
import { inject, type App, type InjectionKey, type Plugin } from 'vue'

export interface OmniVueOptions {
  readonly manager: WalletManager
  readonly txStore?: TxStore
  readonly siwe?: SiweClient
  readonly walletConnect?: WalletConnectSession | null
  /** Started with the app, stopped on `app.unmount()`: the tx engines (`start()` is ref-counted). */
  readonly engines?: readonly { start(): () => void }[]
}

export const OMNI: InjectionKey<OmniVueOptions> = Symbol('omnimarket')

/**
 * Provides an existing core to the app. Like the React provider it never creates one: in the
 * micro-frontend setup the host owns the core and every framework binds to the same instances.
 */
export function createOmniVue(options: OmniVueOptions): Plugin {
  return {
    install(app: App) {
      app.provide(OMNI, options)
      // Both `start()`s are ref-counted, so a React remote starting them again is harmless.
      const stops = [options.manager.start(), ...(options.engines ?? []).map((engine) => engine.start())]
      app.onUnmount(() => {
        for (const stop of stops) stop()
      })
    },
  }
}

export function useOmni(): OmniVueOptions {
  const omni = inject(OMNI, null)
  if (!omni) throw new Error('Install createOmniVue(...) before using OmniMarket composables')
  return omni
}
