import { buildSiweMessage } from '@omnimarket/auth'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { createApp } from './app'

const config = {
  siweDomain: 'localhost:5173',
  siweOrigin: 'http://localhost:5173',
  chainIds: [1],
  sessionTtlMs: 60_000,
  secureCookies: false,
}

async function signIn(app: ReturnType<typeof createApp>, cookie?: string) {
  const account = privateKeyToAccount(generatePrivateKey())
  const { nonce } = (await (await app.request('/auth/nonce')).json()) as { nonce: string }
  const message = buildSiweMessage({
    address: account.address,
    chainId: 1,
    nonce,
    domain: config.siweDomain,
    uri: config.siweOrigin,
  })
  const signature = await account.signMessage({ message })
  const response = await app.request('/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ message, signature }),
  })
  return { account, response, message, signature }
}

const sessionCookie = (response: Response) => response.headers.get('set-cookie')!.split(';')[0]!

describe('auth API', () => {
  it('signs in, exposes the session and signs out', async () => {
    const app = createApp(config)
    const { account, response } = await signIn(app)
    expect(response.status).toBe(200)

    const setCookie = response.headers.get('set-cookie')!
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/SameSite=Lax/i)
    const cookie = sessionCookie(response)

    const me = await (await app.request('/auth/me', { headers: { cookie } })).json()
    expect(me).toMatchObject({ session: { address: account.address, did: `did:pkh:eip155:1:${account.address}` } })

    await app.request('/auth/logout', { method: 'POST', headers: { cookie } })
    expect(await (await app.request('/auth/me', { headers: { cookie } })).json()).toEqual({ session: null })
  })

  it('rejects a replayed signature', async () => {
    const app = createApp(config)
    const { message, signature } = await signIn(app)
    const replay = await app.request('/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, signature }),
    })
    expect(replay.status).toBe(401)
    expect(await replay.json()).toMatchObject({ error: 'NONCE_INVALID' })
  })

  it('rejects form-encoded posts (CSRF guard)', async () => {
    const app = createApp(config)
    const response = await app.request('/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'message=x&signature=0x00',
    })
    expect(response.status).toBe(415)
  })

  it('rejects malformed bodies', async () => {
    const app = createApp(config)
    const response = await app.request('/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'x', signature: 'not-hex' }),
    })
    expect(response.status).toBe(400)
  })

  it('rotates the session id on re-authentication', async () => {
    const app = createApp(config)
    const first = sessionCookie((await signIn(app)).response)
    const second = sessionCookie((await signIn(app, first)).response)
    expect(second).not.toBe(first)
    expect(await (await app.request('/auth/me', { headers: { cookie: first } })).json()).toEqual({ session: null })
  })

  it('never caches auth responses', async () => {
    const app = createApp(config)
    expect((await app.request('/auth/nonce')).headers.get('cache-control')).toBe('no-store')
  })
})

describe('auth API across chains', () => {
  it('signs in with a Sui wallet', async () => {
    const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519')
    const { buildSignInMessage } = await import('@omnimarket/auth')
    const app = createApp({ ...config, signInChains: ['sui:localnet'] })
    const keypair = new Ed25519Keypair()
    const { nonce } = (await (await app.request('/auth/nonce')).json()) as { nonce: string }
    const message = buildSignInMessage({
      chainId: 'sui:localnet',
      address: keypair.toSuiAddress(),
      nonce,
      domain: config.siweDomain,
      uri: config.siweOrigin,
    })
    const { signature } = await keypair.signPersonalMessage(new TextEncoder().encode(message))
    const response = await app.request('/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, signature }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ namespace: 'sui', chainId: 'sui:localnet', address: keypair.toSuiAddress() })
  })
})
