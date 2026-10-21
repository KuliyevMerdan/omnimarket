import { getAddress, hashTypedData, isAddress, type Address, type TypedDataDomain } from 'viem'

export interface Order {
  readonly seller: Address
  readonly collection: Address
  readonly tokenId: bigint
  readonly price: bigint
  readonly nonce: bigint
  readonly deadline: bigint
}

/** JSON form: bigints as decimal strings. */
export type SerializedOrder = { readonly [K in keyof Order]: Order[K] extends bigint ? string : Order[K] }

/** Must mirror `ORDER_TYPEHASH` in OmniMarket.sol (tested against the contract's `hashOrder`). */
export const ORDER_TYPES = {
  Order: [
    { name: 'seller', type: 'address' },
    { name: 'collection', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'price', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export function orderDomain(chainId: number, market: Address): TypedDataDomain {
  return { name: 'OmniMarket', version: '1', chainId, verifyingContract: market }
}

export function orderTypedData(chainId: number, market: Address, order: Order) {
  return {
    domain: orderDomain(chainId, market),
    types: ORDER_TYPES,
    primaryType: 'Order',
    message: order,
  } as const
}

export function hashOrder(chainId: number, market: Address, order: Order) {
  return hashTypedData(orderTypedData(chainId, market, order))
}

export function serializeOrder(order: Order): SerializedOrder {
  return {
    seller: order.seller,
    collection: order.collection,
    tokenId: order.tokenId.toString(),
    price: order.price.toString(),
    nonce: order.nonce.toString(),
    deadline: order.deadline.toString(),
  }
}

const UINT = /^(0|[1-9][0-9]{0,77})$/

/** Strict parse of untrusted JSON (API bodies, storage). Throws on anything unexpected. */
export function parseOrder(value: unknown): Order {
  const v = value as Record<string, unknown> | null
  if (!v || typeof v !== 'object') throw new TypeError('Order must be an object')
  const address = (key: string): Address => {
    const raw = v[key]
    if (typeof raw !== 'string' || !isAddress(raw, { strict: false })) throw new TypeError(`Invalid ${key}`)
    return getAddress(raw)
  }
  const uint = (key: string): bigint => {
    const raw = v[key]
    if (typeof raw !== 'string' || !UINT.test(raw)) throw new TypeError(`Invalid ${key}`)
    const n = BigInt(raw)
    if (n >= 2n ** 256n) throw new TypeError(`Invalid ${key}`)
    return n
  }
  return {
    seller: address('seller'),
    collection: address('collection'),
    tokenId: uint('tokenId'),
    price: uint('price'),
    nonce: uint('nonce'),
    deadline: uint('deadline'),
  }
}
