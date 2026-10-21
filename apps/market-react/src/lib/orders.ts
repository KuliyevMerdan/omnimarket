import { parseOrder, serializeOrder, type Order } from '@omnimarket/contracts'
import type { Hex } from 'viem'

export interface ListedOrder {
  readonly hash: Hex
  readonly chainId: number
  readonly order: Order
  readonly signature: Hex
  readonly createdAt: number
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** The API is a cache: every order is re-parsed strictly here and re-validated on chain by the caller. */
export async function fetchOrders(chainId: number, signal?: AbortSignal): Promise<ListedOrder[]> {
  const response = await fetch(`/api/orders?chainId=${chainId}`, { signal })
  if (!response.ok) throw new ApiError(`HTTP_${response.status}`, 'Could not load listings')
  const { orders } = (await response.json()) as { orders: unknown[] }
  return orders.flatMap((raw) => {
    try {
      const o = raw as { hash: Hex; chainId: number; order: unknown; signature: Hex; createdAt: number }
      return [{ hash: o.hash, chainId: o.chainId, order: parseOrder(o.order), signature: o.signature, createdAt: o.createdAt }]
    } catch {
      return []
    }
  })
}

export async function postOrder(chainId: number, order: Order, signature: Hex): Promise<Hex> {
  const response = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chainId, order: serializeOrder(order), signature }),
  })
  const body = (await response.json().catch(() => ({}))) as { hash?: Hex; error?: string; message?: string }
  if (!response.ok || !body.hash) throw new ApiError(body.error ?? `HTTP_${response.status}`, body.message ?? 'Listing failed')
  return body.hash
}
