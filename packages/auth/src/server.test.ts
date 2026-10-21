import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { createMemoryNonceStore, verifySiwe, type NonceStore } from './server'
import { buildSiweMessage } from './siwe'

const expected = { domain: 'app.test', origin: 'https://app.test', chainIds: [1, 11155111] }
const account = privateKeyToAccount(generatePrivateKey())

async function signed(nonceStore: NonceStore, overrides: Partial<Parameters<typeof buildSiweMessage>[0]> = {}) {
  const message = buildSiweMessage({
    address: account.address,
    chainId: 1,
    nonce: await nonceStore.issue(),
    domain: 'app.test',
    uri: 'https://app.test/login',
    statement: 'Sign in to OmniMarket',
    ...overrides,
  })
  return { message, signature: await account.signMessage({ message }) }
}

describe('verifySiwe', () => {
  it('accepts a fresh, correctly bound message and returns a did:pkh', async () => {
    const nonceStore = createMemoryNonceStore()
    const result = await verifySiwe({ ...(await signed(nonceStore)), expected, nonceStore })
    expect(result).toMatchObject({ address: account.address, chainId: 1, did: `did:pkh:eip155:1:${account.address}` })
  })

  it('rejects replay of the same message', async () => {
    const nonceStore = createMemoryNonceStore()
    const payload = await signed(nonceStore)
    await verifySiwe({ ...payload, expected, nonceStore })
    await expect(verifySiwe({ ...payload, expected, nonceStore })).rejects.toMatchObject({ code: 'NONCE_INVALID' })
  })

  it('rejects nonces the server never issued', async () => {
    const nonceStore = createMemoryNonceStore()
    const payload = await signed({ issue: () => 'attackerChosenNonce1', consume: () => false })
    await expect(verifySiwe({ ...payload, expected, nonceStore })).rejects.toMatchObject({ code: 'NONCE_INVALID' })
  })

  it('rejects a message signed for a phishing domain', async () => {
    const nonceStore = createMemoryNonceStore()
    const payload = await signed(nonceStore, { domain: 'app-test.evil', uri: 'https://app-test.evil' })
    await expect(verifySiwe({ ...payload, expected, nonceStore })).rejects.toMatchObject({ code: 'DOMAIN_MISMATCH' })
  })

  it('rejects a mismatched URI origin', async () => {
    const nonceStore = createMemoryNonceStore()
    const payload = await signed(nonceStore, { uri: 'http://app.test' })
    await expect(verifySiwe({ ...payload, expected, nonceStore })).rejects.toMatchObject({ code: 'URI_MISMATCH' })
  })

  it('rejects chains outside the allowlist', async () => {
    const nonceStore = createMemoryNonceStore()
    const payload = await signed(nonceStore, { chainId: 56 })
    await expect(verifySiwe({ ...payload, expected, nonceStore })).rejects.toMatchObject({ code: 'CHAIN_NOT_ALLOWED' })
  })

  it('rejects expired and future-dated messages', async () => {
    const nonceStore = createMemoryNonceStore()
    const old = await signed(nonceStore, { now: new Date(Date.now() - 11 * 60_000) })
    await expect(verifySiwe({ ...old, expected, nonceStore })).rejects.toMatchObject({ code: 'EXPIRED' })

    const future = await signed(nonceStore, { now: new Date(Date.now() + 5 * 60_000) })
    await expect(verifySiwe({ ...future, expected, nonceStore })).rejects.toMatchObject({ code: 'NOT_YET_VALID' })
  })

  it('rejects a tampered message and does not burn the nonce', async () => {
    const nonceStore = createMemoryNonceStore()
    const payload = await signed(nonceStore)
    const tampered = payload.message.replace('Sign in to OmniMarket', 'Sign in to OmniMarket!')
    await expect(verifySiwe({ ...payload, message: tampered, expected, nonceStore })).rejects.toMatchObject({
      code: 'INVALID_SIGNATURE',
    })
    await expect(verifySiwe({ ...payload, expected, nonceStore })).resolves.toBeTruthy()
  })

  it('rejects a signature from another key', async () => {
    const nonceStore = createMemoryNonceStore()
    const { message } = await signed(nonceStore)
    const signature = await privateKeyToAccount(generatePrivateKey()).signMessage({ message })
    await expect(verifySiwe({ message, signature, expected, nonceStore })).rejects.toMatchObject({
      code: 'INVALID_SIGNATURE',
    })
  })

  it('rejects non-SIWE text', async () => {
    const nonceStore = createMemoryNonceStore()
    const message = 'please sign this harmless text'
    const signature = await account.signMessage({ message })
    await expect(verifySiwe({ message, signature, expected, nonceStore })).rejects.toMatchObject({
      code: 'MALFORMED_MESSAGE',
    })
  })
})

describe('createMemoryNonceStore', () => {
  it('expires nonces after the ttl', () => {
    let time = 0
    const store = createMemoryNonceStore({ ttlMs: 1000, now: () => time })
    const nonce = store.issue()
    time = 1000
    expect(store.consume(nonce)).toBe(false)
  })

  it('evicts the oldest nonces beyond maxSize', () => {
    const store = createMemoryNonceStore({ maxSize: 2 })
    const first = store.issue()
    const second = store.issue()
    const third = store.issue()
    expect(store.consume(first)).toBe(false)
    expect(store.consume(second)).toBe(true)
    expect(store.consume(third)).toBe(true)
  })
})
