import type { Address } from 'viem'
import { createSiweMessage } from 'viem/siwe'

export interface BuildSiweMessageParams {
  readonly address: Address
  readonly chainId: number
  readonly nonce: string
  /** RFC 3986 authority the user sees in the wallet, e.g. `app.example.com`. */
  readonly domain: string
  readonly uri: string
  readonly statement?: string
  readonly ttlMs?: number
  readonly now?: Date
}

export const DEFAULT_SIWE_TTL_MS = 10 * 60 * 1000

/** EIP-4361 message. Short expiry: it only has to survive the time the wallet prompt is open. */
export function buildSiweMessage({
  ttlMs = DEFAULT_SIWE_TTL_MS,
  now = new Date(),
  ...params
}: BuildSiweMessageParams): string {
  return createSiweMessage({
    ...params,
    version: '1',
    issuedAt: now,
    expirationTime: new Date(now.getTime() + ttlMs),
  })
}

/** W3C did:pkh is literally `did:pkh:` + a CAIP-10 account id. */
export function toDidPkh(caip10: string): `did:pkh:${string}` {
  return `did:pkh:${caip10}`
}

export interface SiweSession {
  readonly did: `did:pkh:${string}`
  readonly namespace: 'eip155' | 'solana' | 'sui'
  readonly address: string
  /** CAIP-2, e.g. `eip155:1`, `solana:localnet`. */
  readonly chainId: string
  readonly expiresAt: string
}
