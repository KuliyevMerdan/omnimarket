import { getAddress, isAddressEqual, parseAbi, type Address } from 'viem'
import type { GuardContext, KnownContract, TokenStandard } from './types'

/** Canonical Permit2, same address on every chain (CREATE2). */
export const PERMIT2_ADDRESS: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

/** At or above this an allowance is "unlimited" in practice (`type(uint256).max`, `type(uint160).max`, …). */
export const UNLIMITED_THRESHOLD = 2n ** 128n

export const TOKEN_READ_ABI = parseAbi([
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
])

const ERC721_INTERFACE_ID = '0x80ac58cd'
const ERC1155_INTERFACE_ID = '0xd9b67a26'
/** EIP-7702 delegation designator: `0xef0100 ‖ address`. */
const DELEGATION_PREFIX = '0xef0100'

export function knownContract(ctx: GuardContext, address: Address): KnownContract | undefined {
  if (isAddressEqual(address, PERMIT2_ADDRESS)) return { name: 'Permit2' }
  return ctx.known?.(ctx.chainId, address)
}

export type AccountKind = 'eoa' | 'delegated' | 'contract' | 'unknown'

/**
 * An approval only makes sense for a contract. A personal address (or one delegated with EIP-7702, whose
 * code its key holder can swap at any time) as spender is the typical drainer setup.
 */
export async function accountKind(ctx: GuardContext, address: Address): Promise<AccountKind> {
  if (!ctx.client) return 'unknown'
  try {
    const code = await ctx.client.getCode({ address })
    if (!code || code === '0x') return 'eoa'
    if (code.toLowerCase().startsWith(DELEGATION_PREFIX) && code.length === 2 + 46) return 'delegated'
    return 'contract'
  } catch {
    return 'unknown'
  }
}

export interface TokenInfo {
  readonly standard: TokenStandard
  /** Untrusted: any contract can call itself "USDC". Sanitized and always shown next to the address. */
  readonly symbol?: string
  readonly decimals?: number
}

/**
 * ERC-20 and ERC-721 share `approve(address,uint256)` and `transferFrom(address,address,uint256)`: the
 * selector alone can't tell "approve 1 token id" from "approve an amount". ERC-165 can.
 */
export async function tokenInfo(ctx: GuardContext, token: Address): Promise<TokenInfo> {
  const client = ctx.client
  if (!client) return { standard: 'unknown' }
  const read = <T>(functionName: 'supportsInterface' | 'symbol' | 'decimals', args?: readonly [`0x${string}`]) =>
    client
      .readContract({ address: token, abi: TOKEN_READ_ABI, functionName, args } as Parameters<typeof client.readContract>[0])
      .then((value) => value as T)
      .catch(() => undefined)

  const [is721, is1155, symbol, decimals] = await Promise.all([
    read<boolean>('supportsInterface', [ERC721_INTERFACE_ID]),
    read<boolean>('supportsInterface', [ERC1155_INTERFACE_ID]),
    read<string>('symbol'),
    read<number>('decimals'),
  ])
  const standard: TokenStandard = is721 ? 'erc721' : is1155 ? 'erc1155' : decimals !== undefined ? 'erc20' : 'unknown'
  return {
    standard,
    symbol: typeof symbol === 'string' ? sanitizeLabel(symbol) || undefined : undefined,
    decimals: typeof decimals === 'number' && decimals <= 36 ? decimals : undefined,
  }
}

/** Control, bidi-override and zero-width characters: used to make one text look like another. */
export const HIDDEN_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/

export function sanitizeLabel(value: string, max = 16): string {
  return value.replace(new RegExp(HIDDEN_CHARACTERS.source, 'g'), '').trim().slice(0, max)
}

export function toAddress(value: unknown): Address | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return getAddress(value)
  } catch {
    return undefined
  }
}

/** JSON-RPC payloads carry numbers as decimal or hex strings, sometimes as JSON numbers. */
export function toBigInt(value: unknown): bigint | undefined {
  try {
    if (typeof value === 'bigint') return value
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
    if (typeof value === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(value)) return BigInt(value)
  } catch {
    // fall through
  }
  return undefined
}
