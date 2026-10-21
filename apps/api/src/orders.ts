import { checkOrders, hashOrder, orderTypedData, parseOrder, serializeOrder, type Order, type SerializedOrder } from '@omnimarket/contracts'
import { Hono } from 'hono'
import { isAddressEqual, recoverTypedDataAddress, type Address, type Hex, type PublicClient } from 'viem'

export interface MarketConfig {
  readonly market: Address
  /** Only these collections can be listed: no spam or look-alike "fake collection" listings. */
  readonly collections: readonly Address[]
}

export interface OrdersConfig {
  readonly markets: ReadonlyMap<number, MarketConfig>
  readonly maxOrdersPerSeller?: number
  readonly maxDeadlineMs?: number
}

export interface StoredOrder {
  readonly hash: Hex
  readonly chainId: number
  readonly order: SerializedOrder
  readonly signature: Hex
  readonly createdAt: number
}

interface Deps {
  readonly getPublicClient?: (chainId: number) => PublicClient | undefined
  readonly now?: () => number
}

const SIGNATURE = /^0x[0-9a-fA-F]{130,4096}$/
/** Final states on chain; such orders can never become fillable again. */
const PERMANENT = new Set(['expired', 'used', 'nonce_invalidated'])

export function createOrderRoutes(config: OrdersConfig, deps: Deps = {}) {
  const now = deps.now ?? Date.now
  const maxPerSeller = config.maxOrdersPerSeller ?? 50
  const maxDeadlineMs = config.maxDeadlineMs ?? 30 * 24 * 3600 * 1000
  const book = new Map<Hex, StoredOrder>()

  const app = new Hono()

  app.post('/', async (c) => {
    if (!c.req.header('content-type')?.startsWith('application/json')) {
      return c.json({ error: 'UNSUPPORTED_MEDIA_TYPE', message: 'Expected application/json' }, 415)
    }
    const body = (await c.req.json().catch(() => null)) as { chainId?: unknown; order?: unknown; signature?: unknown } | null
    const chainId = Number(body?.chainId)
    const market = config.markets.get(chainId)
    if (!market) return c.json({ error: 'CHAIN_NOT_SUPPORTED', message: `No market on chain ${String(body?.chainId)}` }, 400)
    if (typeof body?.signature !== 'string' || !SIGNATURE.test(body.signature)) {
      return c.json({ error: 'BAD_REQUEST', message: 'Invalid signature' }, 400)
    }
    const signature = body.signature as Hex

    let order: Order
    try {
      order = parseOrder(body.order)
    } catch (error) {
      return c.json({ error: 'BAD_REQUEST', message: (error as Error).message }, 400)
    }
    if (!market.collections.some((collection) => isAddressEqual(collection, order.collection))) {
      return c.json({ error: 'COLLECTION_NOT_ALLOWED', message: 'This collection is not listed on OmniMarket' }, 400)
    }
    const deadlineMs = Number(order.deadline) * 1000
    if (deadlineMs <= now() || deadlineMs > now() + maxDeadlineMs) {
      return c.json({ error: 'BAD_DEADLINE', message: 'Deadline must be in the future and within 30 days' }, 400)
    }

    if (!(await isValidOrderSignature(chainId, market.market, order, signature, deps.getPublicClient?.(chainId)))) {
      return c.json({ error: 'INVALID_SIGNATURE', message: 'Signature is not from the seller' }, 401)
    }

    const hash = hashOrder(chainId, market.market, order)
    const fromSeller = [...book.values()].filter((o) => o.chainId === chainId && isAddressEqual(o.order.seller, order.seller))
    if (!book.has(hash) && fromSeller.length >= maxPerSeller) {
      return c.json({ error: 'TOO_MANY_ORDERS', message: `At most ${maxPerSeller} open listings per seller` }, 429)
    }
    // One visible listing per token. The replaced signature stays valid on chain until cancelled;
    // the UI warns about that when relisting at a higher price.
    for (const existing of fromSeller) {
      if (isAddressEqual(existing.order.collection, order.collection) && existing.order.tokenId === order.tokenId.toString()) {
        book.delete(existing.hash)
      }
    }
    book.set(hash, { hash, chainId, order: serializeOrder(order), signature, createdAt: now() })
    return c.json({ hash }, 201)
  })

  app.get('/', async (c) => {
    const chainId = Number(c.req.query('chainId'))
    const market = config.markets.get(chainId)
    if (!market) return c.json({ orders: [] })
    const seller = c.req.query('seller')

    let orders = [...book.values()].filter(
      (o) => o.chainId === chainId && (!seller || o.order.seller.toLowerCase() === seller.toLowerCase()),
    )
    const nowSec = BigInt(Math.floor(now() / 1000))
    const client = deps.getPublicClient?.(chainId)
    if (client && orders.length > 0) {
      const statuses = await checkOrders(client, chainId, market.market, orders.map((o) => parseOrder(o.order)), nowSec).catch(
        () => null, // RPC down: serve the cache, the client re-validates anyway
      )
      if (statuses) {
        orders.forEach((o, i) => PERMANENT.has(statuses[i]!) && book.delete(o.hash))
        orders = orders.filter((_, i) => statuses[i] === 'active')
      }
    } else {
      orders = orders.filter((o) => BigInt(o.order.deadline) > nowSec)
    }
    return c.json({ orders: orders.sort((a, b) => b.createdAt - a.createdAt) })
  })

  return app
}

async function isValidOrderSignature(
  chainId: number,
  market: Address,
  order: Order,
  signature: Hex,
  client: PublicClient | undefined,
): Promise<boolean> {
  const typedData = orderTypedData(chainId, market, order)
  const recovered = await recoverTypedDataAddress({ ...typedData, signature }).catch(() => null)
  if (recovered && isAddressEqual(recovered, order.seller)) return true
  if (!client) return false
  // EIP-1271 / EIP-6492 smart-account sellers.
  return client
    .verifyTypedData({ ...typedData, address: order.seller, signature } as unknown as Parameters<PublicClient['verifyTypedData']>[0])
    .catch(() => false)
}
