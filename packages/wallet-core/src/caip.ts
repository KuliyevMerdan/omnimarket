import type { CaipAccountId, CaipChainId } from './types'

const CAIP2 = /^([-a-z0-9]{3,8}):([-_a-zA-Z0-9]{1,32})$/
const CAIP10 = /^([-a-z0-9]{3,8}):([-_a-zA-Z0-9]{1,32}):([-.%a-zA-Z0-9]{1,128})$/

export interface ParsedChainId {
  readonly namespace: string
  readonly reference: string
}

export interface ParsedAccountId extends ParsedChainId {
  readonly chainId: CaipChainId
  readonly address: string
}

export function parseChainId(chainId: string): ParsedChainId {
  const match = CAIP2.exec(chainId)
  if (!match) throw new TypeError(`Invalid CAIP-2 chain id: ${chainId}`)
  return { namespace: match[1]!, reference: match[2]! }
}

export function parseAccountId(accountId: string): ParsedAccountId {
  const match = CAIP10.exec(accountId)
  if (!match) throw new TypeError(`Invalid CAIP-10 account id: ${accountId}`)
  const [, namespace, reference, address] = match as unknown as [string, string, string, string]
  return { namespace, reference, address, chainId: `${namespace}:${reference}` }
}

export function toAccountId(chainId: CaipChainId, address: string): CaipAccountId {
  return `${chainId}:${address}`
}

export function evmChainId(id: number): CaipChainId {
  return `eip155:${id}`
}

export function evmChainIdToNumber(chainId: CaipChainId): number {
  const { namespace, reference } = parseChainId(chainId)
  const id = Number(reference)
  if (namespace !== 'eip155' || !Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError(`Not an EVM chain id: ${chainId}`)
  }
  return id
}
