import type { ClientWithCoreApi } from '@mysten/sui/client'
import { verifyPersonalMessageSignature } from '@mysten/sui/verify'
import type { CaipChainId } from '@omnimarket/wallet-core'
import {
  assertIsAddress,
  getBase58Encoder,
  getPublicKeyFromAddress,
  verifySignature,
  type SignatureBytes,
} from '@solana/kit'
import { getAddress, isAddressEqual, recoverMessageAddress, type Address, type Hex, type PublicClient } from 'viem'
import { generateSiweNonce, parseSiweMessage } from 'viem/siwe'
import { DEFAULT_SIWE_TTL_MS, toDidPkh } from './siwe'
import { parseSignInMessage, type ParsedSignInMessage, type SignInNamespace } from './siwx'

export interface NonceStore {
  issue(): string | Promise<string>
  /** Atomically checks and invalidates a nonce. `true` only on the first call for a live nonce. */
  consume(nonce: string): boolean | Promise<boolean>
}

export interface MemoryNonceStoreOptions {
  readonly ttlMs?: number
  /** Caps memory under a nonce-flood; oldest nonces are evicted first. */
  readonly maxSize?: number
  readonly now?: () => number
}

export interface MemoryNonceStore extends NonceStore {
  issue(): string
  consume(nonce: string): boolean
}

/** Single-process store. Swap for Redis (`SET NX EX` + `GETDEL`) when running more than one instance. */
export function createMemoryNonceStore({
  ttlMs = 5 * 60 * 1000,
  maxSize = 10_000,
  now = Date.now,
}: MemoryNonceStoreOptions = {}): MemoryNonceStore {
  const nonces = new Map<string, number>()
  return {
    issue() {
      const time = now()
      for (const [nonce, expiresAt] of nonces) {
        if (expiresAt > time && nonces.size < maxSize) break
        nonces.delete(nonce) // Map keeps insertion order, so this walks oldest-first
      }
      const nonce = generateSiweNonce()
      nonces.set(nonce, time + ttlMs)
      return nonce
    },
    consume(nonce) {
      const expiresAt = nonces.get(nonce)
      nonces.delete(nonce)
      return expiresAt !== undefined && expiresAt > now()
    },
  }
}

export type SiweVerifyErrorCode =
  | 'MALFORMED_MESSAGE'
  | 'DOMAIN_MISMATCH'
  | 'URI_MISMATCH'
  | 'CHAIN_NOT_ALLOWED'
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'INVALID_SIGNATURE'
  | 'NONCE_INVALID'

export class SiweVerifyError extends Error {
  override readonly name = 'SiweVerifyError'
  constructor(
    readonly code: SiweVerifyErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface VerifySiweOptions {
  readonly message: string
  readonly signature: Hex
  readonly expected: {
    /** Must come from config — never from the request's Host header. */
    readonly domain: string
    readonly origin: string
    readonly chainIds: readonly number[]
  }
  readonly nonceStore: NonceStore
  /** Enables EIP-1271 / EIP-6492 (smart-contract and not-yet-deployed account) signatures. */
  readonly getPublicClient?: (chainId: number) => PublicClient | undefined
  readonly now?: Date
  /** Upper bound on message age regardless of its own expirationTime. */
  readonly maxAgeMs?: number
  readonly clockSkewMs?: number
}

export interface VerifiedSiwe {
  readonly address: Address
  readonly chainId: number
  readonly did: `did:pkh:${string}`
  readonly expirationTime: Date | undefined
}

/**
 * Server-side EIP-4361 verification. Order matters:
 * 1. cheap structural checks (domain/origin binding stops phishing-site relay),
 * 2. signature (local ecrecover first, RPC only for contract wallets),
 * 3. nonce consumption last and atomically, so a valid message works exactly once
 *    and garbage requests can't burn someone else's nonce.
 */
export async function verifySiwe({
  message,
  signature,
  expected,
  nonceStore,
  getPublicClient,
  now = new Date(),
  maxAgeMs = DEFAULT_SIWE_TTL_MS,
  clockSkewMs = 60_000,
}: VerifySiweOptions): Promise<VerifiedSiwe> {
  const fields = parseSiweMessage(message)
  const { address, chainId, domain, nonce, uri, version, issuedAt, expirationTime, notBefore } = fields
  if (!address || !chainId || !domain || !nonce || !uri || version !== '1') {
    throw new SiweVerifyError('MALFORMED_MESSAGE', 'Not a valid EIP-4361 message')
  }

  if (domain !== expected.domain) {
    throw new SiweVerifyError('DOMAIN_MISMATCH', `Message is for ${domain}`)
  }
  if (originOf(uri) !== expected.origin) {
    throw new SiweVerifyError('URI_MISMATCH', `Message URI ${uri} is not ${expected.origin}`)
  }
  if (!expected.chainIds.includes(chainId)) {
    throw new SiweVerifyError('CHAIN_NOT_ALLOWED', `Chain ${chainId} is not allowed`)
  }

  const time = now.getTime()
  if (expirationTime && expirationTime.getTime() <= time) {
    throw new SiweVerifyError('EXPIRED', 'Message has expired')
  }
  if (!issuedAt || time - issuedAt.getTime() > maxAgeMs) {
    throw new SiweVerifyError('EXPIRED', 'Message is too old')
  }
  if (issuedAt.getTime() - time > clockSkewMs || (notBefore && notBefore.getTime() - time > clockSkewMs)) {
    throw new SiweVerifyError('NOT_YET_VALID', 'Message is not valid yet')
  }

  if (!(await isValidSignature(address, message, signature, getPublicClient?.(chainId)))) {
    throw new SiweVerifyError('INVALID_SIGNATURE', 'Signature does not match the address')
  }
  if (!(await nonceStore.consume(nonce))) {
    throw new SiweVerifyError('NONCE_INVALID', 'Nonce is unknown, expired or already used')
  }

  const checksummed = getAddress(address)
  return {
    address: checksummed,
    chainId,
    did: toDidPkh(`eip155:${chainId}:${checksummed}`),
    expirationTime,
  }
}

async function isValidSignature(
  address: Address,
  message: string,
  signature: Hex,
  client: PublicClient | undefined,
): Promise<boolean> {
  // EOA fast path: no network round-trip for the 99% case.
  const recovered = await recoverMessageAddress({ message, signature }).catch(() => null)
  if (recovered && isAddressEqual(recovered, address)) return true
  if (!client) return false
  // viem's verifyMessage covers EIP-1271 (deployed) and EIP-6492 (counterfactual) accounts.
  return client.verifyMessage({ address, message, signature }).catch(() => false)
}

function originOf(uri: string): string | null {
  try {
    return new URL(uri).origin
  } catch {
    return null
  }
}

export interface VerifySignInOptions {
  readonly message: string
  readonly signature: string
  readonly expected: {
    readonly domain: string
    readonly origin: string
    /** CAIP-2 allowlist across namespaces, e.g. `eip155:1`, `solana:localnet`, `sui:testnet`. */
    readonly chains: readonly CaipChainId[]
  }
  readonly nonceStore: NonceStore
  readonly getPublicClient?: (chainId: number) => PublicClient | undefined
  /** Needed only for zkLogin signatures on Sui (verified by the network). */
  readonly suiClient?: ClientWithCoreApi
  readonly now?: Date
  readonly maxAgeMs?: number
  readonly clockSkewMs?: number
}

export interface VerifiedSignIn {
  readonly namespace: SignInNamespace
  readonly address: string
  readonly chainId: CaipChainId
  readonly did: `did:pkh:${string}`
}

/**
 * Chain-agnostic sign-in verification (CAIP-122). Ethereum is delegated to `verifySiwe` (EIP-1271/6492
 * aware); Solana and Sui go through the same structural checks, then their own signature scheme.
 */
export async function verifySignIn(options: VerifySignInOptions): Promise<VerifiedSignIn> {
  const { message, signature, expected, nonceStore, now = new Date() } = options
  const parsed = parseSignInMessage(message)
  if (!parsed) throw new SiweVerifyError('MALFORMED_MESSAGE', 'Not a valid sign-in message')

  if (parsed.namespace === 'eip155') {
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) throw new SiweVerifyError('INVALID_SIGNATURE', 'Expected a hex signature')
    const evmChains = expected.chains.filter((c) => c.startsWith('eip155:')).map((c) => Number(c.slice('eip155:'.length)))
    const result = await verifySiwe({
      message,
      signature: signature as Hex,
      expected: { domain: expected.domain, origin: expected.origin, chainIds: evmChains },
      nonceStore,
      getPublicClient: options.getPublicClient,
      now,
      maxAgeMs: options.maxAgeMs,
      clockSkewMs: options.clockSkewMs,
    })
    return { namespace: 'eip155', address: result.address, chainId: `eip155:${result.chainId}`, did: result.did }
  }

  if (parsed.version !== '1') throw new SiweVerifyError('MALFORMED_MESSAGE', 'Unsupported version')
  if (parsed.domain !== expected.domain) throw new SiweVerifyError('DOMAIN_MISMATCH', `Message is for ${parsed.domain}`)
  if (originOf(parsed.uri) !== expected.origin) throw new SiweVerifyError('URI_MISMATCH', `Message URI is not ${expected.origin}`)
  if (!expected.chains.includes(parsed.chainId)) throw new SiweVerifyError('CHAIN_NOT_ALLOWED', `${parsed.chainId} is not allowed`)
  checkTimes(parsed, now, options.maxAgeMs ?? DEFAULT_SIWE_TTL_MS, options.clockSkewMs ?? 60_000)

  const bytes = new TextEncoder().encode(message)
  const valid =
    parsed.namespace === 'solana'
      ? await verifySolanaSignature(parsed.address, bytes, signature)
      : await verifySuiSignature(parsed.address, bytes, signature, options.suiClient)
  if (!valid) throw new SiweVerifyError('INVALID_SIGNATURE', 'Signature does not match the address')
  if (!(await nonceStore.consume(parsed.nonce))) {
    throw new SiweVerifyError('NONCE_INVALID', 'Nonce is unknown, expired or already used')
  }
  return {
    namespace: parsed.namespace,
    address: parsed.address,
    chainId: parsed.chainId,
    did: toDidPkh(`${parsed.chainId}:${parsed.address}`),
  }
}

function checkTimes(parsed: ParsedSignInMessage, now: Date, maxAgeMs: number, skewMs: number): void {
  const time = now.getTime()
  if (parsed.expirationTime && parsed.expirationTime.getTime() <= time) throw new SiweVerifyError('EXPIRED', 'Message has expired')
  if (time - parsed.issuedAt.getTime() > maxAgeMs) throw new SiweVerifyError('EXPIRED', 'Message is too old')
  if (parsed.issuedAt.getTime() - time > skewMs || (parsed.notBefore && parsed.notBefore.getTime() - time > skewMs)) {
    throw new SiweVerifyError('NOT_YET_VALID', 'Message is not valid yet')
  }
}

/** ed25519 over the exact message bytes; the address *is* the public key (base58). */
async function verifySolanaSignature(address: string, message: Uint8Array, signature: string): Promise<boolean> {
  try {
    assertIsAddress(address)
    const signatureBytes = new Uint8Array(getBase58Encoder().encode(signature))
    if (signatureBytes.length !== 64) return false
    return await verifySignature(await getPublicKeyFromAddress(address), signatureBytes as SignatureBytes, message)
  } catch {
    return false
  }
}

/**
 * Sui personal-message signatures are over `intent(PersonalMessage) ‖ bcs(message)`, so they can't be
 * replayed as transaction signatures. Supports ed25519/secp256k1/secp256r1/multisig offline and
 * zkLogin through the network.
 */
async function verifySuiSignature(address: string, message: Uint8Array, signature: string, client?: ClientWithCoreApi) {
  try {
    await verifyPersonalMessageSignature(message, signature, { address, ...(client ? { client } : {}) })
    return true
  } catch {
    return false
  }
}
