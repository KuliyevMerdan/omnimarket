import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { generateKeyPairSigner, getBase58Decoder, signBytes } from '@solana/kit'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { createMemoryNonceStore, verifySignIn, type NonceStore } from './server'
import { buildSignInMessage, parseSignInMessage } from './siwx'

const expected = {
  domain: 'app.test',
  origin: 'https://app.test',
  chains: ['eip155:1', 'solana:localnet', 'sui:localnet'] as const,
}

const base = (nonce: string) => ({ nonce, domain: 'app.test', uri: 'https://app.test', statement: 'Sign in to OmniMarket.' })

async function solana(nonceStore: NonceStore, overrides: Partial<Parameters<typeof buildSignInMessage>[0]> = {}) {
  const signer = await generateKeyPairSigner()
  const message = buildSignInMessage({ ...base(await nonceStore.issue()), chainId: 'solana:localnet', address: signer.address, ...overrides })
  const bytes = await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(message))
  return { signer, message, signature: getBase58Decoder().decode(bytes) }
}

async function sui(nonceStore: NonceStore, keypair = new Ed25519Keypair()) {
  const message = buildSignInMessage({ ...base(await nonceStore.issue()), chainId: 'sui:localnet', address: keypair.toSuiAddress() })
  const { signature } = await keypair.signPersonalMessage(new TextEncoder().encode(message))
  return { keypair, message, signature }
}

describe('buildSignInMessage / parseSignInMessage', () => {
  it('round-trips the CAIP-122 layout', () => {
    const now = new Date('2026-10-22T10:00:00.000Z')
    const message = buildSignInMessage({ ...base('abcdefgh1'), chainId: 'solana:localnet', address: 'So1ana', now })
    expect(message.split('\n').slice(0, 2)).toEqual(['app.test wants you to sign in with your Solana account:', 'So1ana'])
    expect(parseSignInMessage(message)).toMatchObject({
      namespace: 'solana',
      address: 'So1ana',
      chainId: 'solana:localnet',
      statement: 'Sign in to OmniMarket.',
      nonce: 'abcdefgh1',
      issuedAt: now,
    })
  })

  it('parses viem-built EIP-4361 messages too', () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const message = buildSignInMessage({ ...base('abcdefgh1'), chainId: 'eip155:1', address: account.address })
    expect(parseSignInMessage(message)).toMatchObject({ namespace: 'eip155', chainId: 'eip155:1', address: account.address })
  })

  it.each([
    ['duplicated field', (m: string) => m.replace('Version: 1', 'Version: 1\nVersion: 1')],
    ['unknown field', (m: string) => `${m}\nEvil: 1`],
    ['bad date', (m: string) => m.replace(/Issued At: .*/, 'Issued At: yesterday')],
    ['unknown chain label', (m: string) => m.replace('Solana account', 'Bitcoin account')],
  ])('rejects %s', (_, mutate) => {
    const message = buildSignInMessage({ ...base('abcdefgh1'), chainId: 'solana:localnet', address: 'So1ana' })
    expect(parseSignInMessage(mutate(message))).toBeNull()
  })

  it('rejects multi-line statements (they could fake fields)', () => {
    expect(() =>
      buildSignInMessage({ ...base('abcdefgh1'), chainId: 'sui:localnet', address: '0x1', statement: 'hi\nURI: https://evil' }),
    ).toThrow()
  })
})

describe('verifySignIn', () => {
  it('accepts a Solana (SIWS) sign-in and returns a did:pkh', async () => {
    const nonceStore = createMemoryNonceStore()
    const { signer, message, signature } = await solana(nonceStore)
    await expect(verifySignIn({ message, signature, expected, nonceStore })).resolves.toEqual({
      namespace: 'solana',
      address: signer.address,
      chainId: 'solana:localnet',
      did: `did:pkh:solana:localnet:${signer.address}`,
    })
  })

  it('rejects a Solana signature replay and a signature from another key', async () => {
    const nonceStore = createMemoryNonceStore()
    const first = await solana(nonceStore)
    await verifySignIn({ message: first.message, signature: first.signature, expected, nonceStore })
    await expect(verifySignIn({ message: first.message, signature: first.signature, expected, nonceStore })).rejects.toMatchObject({
      code: 'NONCE_INVALID',
    })

    const second = await solana(nonceStore)
    const other = await solana(nonceStore)
    await expect(verifySignIn({ message: second.message, signature: other.signature, expected, nonceStore })).rejects.toMatchObject({
      code: 'INVALID_SIGNATURE',
    })
  })

  it('applies domain and chain checks to Solana too', async () => {
    const nonceStore = createMemoryNonceStore()
    const phishing = await solana(nonceStore, { domain: 'app-test.evil', uri: 'https://app-test.evil' })
    await expect(verifySignIn({ ...phishing, expected, nonceStore })).rejects.toMatchObject({ code: 'DOMAIN_MISMATCH' })
    const mainnet = await solana(nonceStore, { chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' })
    await expect(verifySignIn({ ...mainnet, expected, nonceStore })).rejects.toMatchObject({ code: 'CHAIN_NOT_ALLOWED' })
  })

  it('accepts a Sui personal-message sign-in', async () => {
    const nonceStore = createMemoryNonceStore()
    const { keypair, message, signature } = await sui(nonceStore)
    await expect(verifySignIn({ message, signature, expected, nonceStore })).resolves.toMatchObject({
      namespace: 'sui',
      address: keypair.toSuiAddress(),
      did: `did:pkh:sui:localnet:${keypair.toSuiAddress()}`,
    })
  })

  it('rejects a Sui signature for another address', async () => {
    const nonceStore = createMemoryNonceStore()
    const { message } = await sui(nonceStore)
    const { signature } = await new Ed25519Keypair().signPersonalMessage(new TextEncoder().encode(message))
    await expect(verifySignIn({ message, signature, expected, nonceStore })).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' })
  })

  it('rejects a Sui transaction signature presented as a sign-in (intent separation)', async () => {
    const nonceStore = createMemoryNonceStore()
    const { keypair, message } = await sui(nonceStore)
    const { signature } = await keypair.signTransaction(new TextEncoder().encode(message))
    await expect(verifySignIn({ message, signature, expected, nonceStore })).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' })
  })

  it('delegates Ethereum messages to SIWE verification', async () => {
    const nonceStore = createMemoryNonceStore()
    const account = privateKeyToAccount(generatePrivateKey())
    const message = buildSignInMessage({ ...base(nonceStore.issue()), chainId: 'eip155:1', address: account.address })
    const signature = await account.signMessage({ message })
    await expect(verifySignIn({ message, signature, expected, nonceStore })).resolves.toMatchObject({
      namespace: 'eip155',
      chainId: 'eip155:1',
      did: `did:pkh:eip155:1:${account.address}`,
    })
  })
})
