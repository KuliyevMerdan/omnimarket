import type { Chain, EIP1193Provider } from 'viem'
import type { ChainAdapter, WalletConnector } from '../../types'
import { Eip1193Connector } from './connector'
import { isEip1193Provider, watchEip6963Providers, type Eip6963ProviderDetail } from './eip6963'

export { Eip1193Connector, type Eip1193ConnectorOptions } from './connector'
export { isEip1193Provider, watchEip6963Providers, type Eip6963ProviderDetail, type Eip6963ProviderInfo } from './eip6963'

export interface EvmAdapterOptions {
  readonly chains: readonly [Chain, ...Chain[]]
  /** Defaults to `window`. Injected for tests and iframes. */
  readonly target?: EventTarget
  /** Wait this long for EIP-6963 announcements before falling back to `window.ethereum`. */
  readonly legacyFallbackDelayMs?: number
}

export const LEGACY_INJECTED_ID = 'eip155:injected'

export function createEvmAdapter(options: EvmAdapterOptions): ChainAdapter {
  return {
    namespace: 'eip155',
    discover(onChange) {
      const target = options.target ?? (typeof window === 'undefined' ? undefined : window)
      if (!target) return () => {}

      // Cache by wallet id so connector identity is stable across announcements.
      const cache = new Map<string, Eip1193Connector>()
      let announced: readonly Eip6963ProviderDetail[] = []
      let legacy: Eip1193Connector | null = null

      const connectorFor = (detail: Eip6963ProviderDetail): Eip1193Connector => {
        const id = `eip155:${detail.info.rdns || detail.info.uuid}`
        let connector = cache.get(id)
        if (!connector) {
          connector = new Eip1193Connector({
            provider: detail.provider,
            chains: options.chains,
            info: {
              id,
              name: detail.info.name,
              icon: detail.info.icon,
              rdns: detail.info.rdns,
              namespace: 'eip155',
              source: 'eip6963',
            },
          })
          cache.set(id, connector)
        }
        return connector
      }

      const emit = () => {
        const list: WalletConnector[] = announced.map(connectorFor)
        if (legacy) list.push(legacy)
        onChange(list)
      }

      const stopWatching = watchEip6963Providers(target, (details) => {
        announced = details
        // The legacy provider turned out to be an EIP-6963 wallet: show it once, by its real name.
        if (legacy && details.some((d) => d.provider === legacy!.provider)) legacy = null
        emit()
      })

      const timer = setTimeout(() => {
        const injected = (target as { ethereum?: unknown }).ethereum
        if (!isEip1193Provider(injected) || announced.some((d) => d.provider === injected)) return
        legacy = new Eip1193Connector({
          provider: injected as EIP1193Provider,
          chains: options.chains,
          info: { id: LEGACY_INJECTED_ID, name: 'Browser Wallet', icon: '', namespace: 'eip155', source: 'legacy-injected' },
        })
        emit()
      }, options.legacyFallbackDelayMs ?? 300)

      return () => {
        clearTimeout(timer)
        stopWatching()
      }
    },
  }
}

export function isEvmConnector(connector: WalletConnector | null | undefined): connector is Eip1193Connector {
  return connector instanceof Eip1193Connector
}
