import type { IdentifierString, Wallet, WalletAccount } from '@wallet-standard/base'
import type { StandardEventsChangeProperties } from '@wallet-standard/features'

const ICON = `data:image/svg+xml;base64,${btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#14f195"/></svg>',
)}` as const

export interface MockStandardWalletControls {
  /** The next prompting request throws a user rejection. */
  rejectNextRequest(): void
  /** Simulates the user locking/disconnecting from inside the wallet. */
  lock(): void
  readonly calls: readonly string[]
}

/**
 * Minimal Wallet Standard shell: connect/disconnect/events with authorization state. Chain-specific
 * mocks plug their signing features in via `features(guard)`, where `guard` enforces rejections.
 */
export function createStandardWalletShell(options: {
  name: string
  chains: readonly IdentifierString[]
  account: WalletAccount
  authorized?: boolean
  features: (guard: (method: string) => void) => Record<string, unknown>
}): { wallet: Wallet; controls: MockStandardWalletControls } {
  let authorized = options.authorized ?? false
  let rejectNext = false
  const calls: string[] = []
  const listeners = new Set<(properties: StandardEventsChangeProperties) => void>()
  const emit = (properties: StandardEventsChangeProperties) => listeners.forEach((l) => l(properties))

  const guard = (method: string) => {
    calls.push(method)
    if (rejectNext) {
      rejectNext = false
      throw new Error('User rejected the request.')
    }
    if (method !== 'standard:connect' && !authorized) throw new Error('Wallet is not connected')
  }

  const wallet: Wallet = {
    version: '1.0.0',
    name: options.name,
    icon: ICON,
    chains: options.chains,
    get accounts() {
      return authorized ? [options.account] : []
    },
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async ({ silent = false }: { silent?: boolean } = {}) => {
          if (silent) return { accounts: authorized ? [options.account] : [] }
          guard('standard:connect')
          authorized = true
          return { accounts: [options.account] }
        },
      },
      'standard:disconnect': {
        version: '1.0.0',
        disconnect: async () => {
          authorized = false
        },
      },
      'standard:events': {
        version: '1.0.0',
        on: (_event: 'change', listener: (properties: StandardEventsChangeProperties) => void) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      },
      ...options.features(guard),
    },
  }

  return {
    wallet,
    controls: {
      rejectNextRequest: () => void (rejectNext = true),
      lock() {
        authorized = false
        emit({ accounts: [] })
      },
      calls,
    },
  }
}

/** Registers a wallet on the browser's Wallet Standard window protocol (for in-browser E2E). */
export async function registerInBrowser(wallet: Wallet): Promise<void> {
  const { registerWallet } = await import('@wallet-standard/wallet')
  registerWallet(wallet)
}
