import { SiweVerifyError, createMemoryNonceStore, verifySignIn, type NonceStore } from '@omnimarket/auth/server'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { secureHeaders } from 'hono/secure-headers'
import type { PublicClient } from 'viem'
import { createOrderRoutes, type MarketConfig } from './orders'
import { createMemorySessionStore, toPublicSession, type SessionStore } from './sessions'

export interface ApiConfig {
  readonly siweDomain: string
  readonly siweOrigin: string
  /** EVM chains allowed for sign-in. */
  readonly chainIds: readonly number[]
  /** Non-EVM CAIP-2 chains allowed for sign-in, e.g. `solana:localnet`, `sui:testnet`. */
  readonly signInChains?: readonly string[]
  readonly sessionTtlMs: number
  /** `Secure` + `__Host-` cookie. Off only for plain-http localhost. */
  readonly secureCookies: boolean
  /** Deployed markets per chain id; chains without one have no order book. */
  readonly markets?: ReadonlyMap<number, MarketConfig>
}

export interface ApiDeps {
  readonly nonceStore?: NonceStore
  readonly sessions?: SessionStore
  readonly getPublicClient?: (chainId: number) => PublicClient | undefined
  readonly suiClient?: ClientWithCoreApi
  readonly now?: () => Date
}

const MAX_MESSAGE_LENGTH = 4096
// hex (EVM), base58 (Solana) or base64 (Sui).
const SIGNATURE = /^[0-9A-Za-z+/=]{2,8192}$/

export function createApp(config: ApiConfig, deps: ApiDeps = {}) {
  const nonceStore = deps.nonceStore ?? createMemoryNonceStore()
  const sessions = deps.sessions ?? createMemorySessionStore()
  const now = deps.now ?? (() => new Date())
  const cookieName = config.secureCookies ? '__Host-omni_sid' : 'omni_sid'

  const app = new Hono()
  app.use(secureHeaders())
  app.use('/auth/*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    await next()
  })

  app.get('/health', (c) => c.json({ ok: true }))

  app.get('/auth/nonce', async (c) => c.json({ nonce: await nonceStore.issue() }))

  app.post('/auth/verify', async (c) => {
    // A JSON content type can't be sent cross-site without a CORS preflight — cheap CSRF guard
    // on top of SameSite cookies.
    if (!c.req.header('content-type')?.startsWith('application/json')) {
      return c.json({ error: 'UNSUPPORTED_MEDIA_TYPE', message: 'Expected application/json' }, 415)
    }
    const body = (await c.req.json().catch(() => null)) as { message?: unknown; signature?: unknown } | null
    const { message, signature } = body ?? {}
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_LENGTH || typeof signature !== 'string' || !SIGNATURE.test(signature)) {
      return c.json({ error: 'BAD_REQUEST', message: 'Expected { message, signature }' }, 400)
    }

    try {
      const verified = await verifySignIn({
        message,
        signature,
        expected: {
          domain: config.siweDomain,
          origin: config.siweOrigin,
          chains: [...config.chainIds.map((id) => `eip155:${id}` as const), ...((config.signInChains ?? []) as `${string}:${string}`[])],
        },
        nonceStore,
        getPublicClient: deps.getPublicClient,
        suiClient: deps.suiClient,
        now: now(),
      })

      // Rotate: never reuse a session id that existed before authentication (session fixation).
      const previous = getCookie(c, cookieName)
      if (previous) sessions.delete(previous)

      const session = sessions.create({
        did: verified.did,
        namespace: verified.namespace,
        address: verified.address,
        chainId: verified.chainId,
        expiresAt: now().getTime() + config.sessionTtlMs,
      })
      setCookie(c, cookieName, session.id, {
        httpOnly: true,
        secure: config.secureCookies,
        sameSite: 'Lax',
        path: '/',
        maxAge: Math.floor(config.sessionTtlMs / 1000),
      })
      return c.json(toPublicSession(session))
    } catch (error) {
      if (error instanceof SiweVerifyError) return c.json({ error: error.code, message: error.message }, 401)
      throw error
    }
  })

  app.get('/auth/me', (c) => {
    const id = getCookie(c, cookieName)
    const session = id ? sessions.get(id) : undefined
    return c.json({ session: session ? toPublicSession(session) : null })
  })

  app.post('/auth/logout', (c) => {
    const id = getCookie(c, cookieName)
    if (id) sessions.delete(id)
    deleteCookie(c, cookieName, { path: '/', secure: config.secureCookies })
    return c.json({ ok: true })
  })

  app.route(
    '/orders',
    createOrderRoutes(
      { markets: config.markets ?? new Map() },
      { getPublicClient: deps.getPublicClient, now: () => now().getTime() },
    ),
  )

  app.onError((error, c) => {
    console.error(error)
    return c.json({ error: 'INTERNAL', message: 'Internal server error' }, 500)
  })

  return app
}
