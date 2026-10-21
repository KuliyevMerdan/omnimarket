import { WalletError, parseAccountId, type WalletManager } from '@omnimarket/wallet-core'
import type { SiweSession } from './siwe'
import { buildSignInMessage } from './siwx'

export interface SiweClientOptions {
  /** Same-origin path (e.g. `/api`) so the session cookie stays first-party. */
  readonly baseUrl: string
  readonly statement?: string
  readonly fetch?: typeof fetch
  /** Defaults to `location.host` / `location.origin`. */
  readonly domain?: string
  readonly uri?: string
}

export class SiweClientError extends Error {
  override readonly name = 'SiweClientError'
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export interface SiweClient {
  signIn(manager: WalletManager): Promise<SiweSession>
  getSession(): Promise<SiweSession | null>
  signOut(): Promise<void>
}

export function createSiweClient(options: SiweClientOptions): SiweClient {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await doFetch(`${options.baseUrl}${path}`, {
      credentials: 'same-origin',
      ...init,
      headers: init.body ? { 'content-type': 'application/json' } : undefined,
    })
    const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string }
    if (!response.ok) {
      throw new SiweClientError(body.error ?? `HTTP_${response.status}`, body.message ?? response.statusText, response.status)
    }
    return body as T
  }

  return {
    async signIn(manager) {
      const account = manager.getState().connection?.accounts[0]
      if (!account) throw new WalletError('NOT_CONNECTED', 'Connect a wallet first')
      const { namespace, chainId, address } = parseAccountId(account)
      if (!['eip155', 'solana', 'sui'].includes(namespace)) {
        throw new WalletError('UNSUPPORTED_METHOD', `Sign-in for ${namespace} is not supported`)
      }

      const { nonce } = await call<{ nonce: string }>('/auth/nonce')
      // SIWE on Ethereum, the same CAIP-122 layout on Solana (SIWS) and Sui.
      const message = buildSignInMessage({
        address,
        chainId,
        nonce,
        domain: options.domain ?? location.host,
        uri: options.uri ?? location.origin,
        statement: options.statement,
      })
      const signature = await manager.signMessage(message, account)
      return call<SiweSession>('/auth/verify', { method: 'POST', body: JSON.stringify({ message, signature }) })
    },

    async getSession() {
      return (await call<{ session: SiweSession | null }>('/auth/me')).session
    },

    async signOut() {
      await call('/auth/logout', { method: 'POST', body: '{}' })
    },
  }
}
