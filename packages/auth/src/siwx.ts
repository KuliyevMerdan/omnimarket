import { parseChainId, type CaipChainId } from '@omnimarket/wallet-core'
import type { Address } from 'viem'
import { DEFAULT_SIWE_TTL_MS, buildSiweMessage } from './siwe'

/**
 * CAIP-122 "Sign-In with X": the EIP-4361 text format generalized to any chain. Ethereum keeps the
 * exact EIP-4361 (wallets render it specially); Solana and Sui use the same layout with their
 * account label and CAIP-2 reference, so one parser and one set of checks cover all three.
 */
export type SignInNamespace = 'eip155' | 'solana' | 'sui'

const LABELS: Record<SignInNamespace, string> = { eip155: 'Ethereum', solana: 'Solana', sui: 'Sui' }

export interface BuildSignInMessageParams {
  readonly chainId: CaipChainId
  readonly address: string
  readonly nonce: string
  readonly domain: string
  readonly uri: string
  readonly statement?: string
  readonly ttlMs?: number
  readonly now?: Date
}

export function buildSignInMessage({ ttlMs = DEFAULT_SIWE_TTL_MS, now = new Date(), ...p }: BuildSignInMessageParams): string {
  const { namespace, reference } = parseChainId(p.chainId)
  if (namespace === 'eip155') {
    return buildSiweMessage({ ...p, address: p.address as Address, chainId: Number(reference), ttlMs, now })
  }
  const label = LABELS[namespace as SignInNamespace]
  if (!label) throw new TypeError(`Sign-in is not supported for ${namespace}`)
  if (/[\n\r]/.test(p.statement ?? '')) throw new TypeError('Statement must be a single line')

  return [
    `${p.domain} wants you to sign in with your ${label} account:`,
    p.address,
    '',
    // EIP-4361 ABNF: `address LF LF [statement LF] LF "URI: "` — an empty statement leaves two blank lines.
    ...(p.statement ? [p.statement, ''] : ['']),
    `URI: ${p.uri}`,
    'Version: 1',
    `Chain ID: ${reference}`,
    `Nonce: ${p.nonce}`,
    `Issued At: ${now.toISOString()}`,
    `Expiration Time: ${new Date(now.getTime() + ttlMs).toISOString()}`,
  ].join('\n')
}

export interface ParsedSignInMessage {
  readonly namespace: SignInNamespace
  readonly domain: string
  readonly address: string
  readonly statement?: string
  readonly uri: string
  readonly version: string
  readonly chainId: CaipChainId
  readonly nonce: string
  readonly issuedAt: Date
  readonly expirationTime?: Date
  readonly notBefore?: Date
}

const HEADER = /^(?<domain>[^\s]+) wants you to sign in with your (?<label>Ethereum|Solana|Sui) account:\n(?<address>[^\s]+)\n\n/
const FIELDS: Record<string, keyof ParsedSignInMessage> = {
  URI: 'uri',
  Version: 'version',
  'Chain ID': 'chainId',
  Nonce: 'nonce',
  'Issued At': 'issuedAt',
  'Expiration Time': 'expirationTime',
  'Not Before': 'notBefore',
}

/** Strict parser: unknown or duplicated fields, bad dates and malformed headers are rejected. */
export function parseSignInMessage(message: string): ParsedSignInMessage | null {
  if (message.length > 4096) return null
  const header = HEADER.exec(message)
  if (!header?.groups) return null
  const namespace = (Object.keys(LABELS) as SignInNamespace[]).find((ns) => LABELS[ns] === header.groups!.label)!
  let rest = message.slice(header[0].length).split('\n')

  let statement: string | undefined
  if (rest[0] === '') {
    rest = rest.slice(1)
  } else {
    statement = rest[0]
    if (!statement || rest[1] !== '') return null
    rest = rest.slice(2)
  }

  const values: Record<string, string> = {}
  for (const line of rest) {
    const match = /^([A-Za-z ]+): (.+)$/.exec(line)
    if (!match) {
      // Resources and Request ID are valid EIP-4361 fields we don't use: stop at them.
      if (line === 'Resources:' || line.startsWith('Request ID: ') || line.startsWith('- ')) continue
      return null
    }
    const key = FIELDS[match[1]!]
    if (!key || key in values) return null
    values[key] = match[2]!
  }

  const date = (value: string | undefined) => {
    if (value === undefined) return undefined
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  const issuedAt = date(values.issuedAt)
  const expirationTime = date(values.expirationTime)
  const notBefore = date(values.notBefore)
  if (!values.uri || !values.version || !values.chainId || !values.nonce || !issuedAt) return null
  if (expirationTime === null || notBefore === null) return null

  return {
    namespace,
    domain: header.groups.domain!,
    address: header.groups.address!,
    ...(statement ? { statement } : {}),
    uri: values.uri,
    version: values.version,
    chainId: `${namespace}:${values.chainId}`,
    nonce: values.nonce,
    issuedAt,
    ...(expirationTime ? { expirationTime } : {}),
    ...(notBefore ? { notBefore } : {}),
  }
}
