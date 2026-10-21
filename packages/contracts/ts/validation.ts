import { isAddressEqual, type Address, type PublicClient } from 'viem'
import { omniMarketAbi, omniNftAbi } from './generated/abis'
import { hashOrder, type Order } from './orders'

export type OrderStatus = 'active' | 'expired' | 'used' | 'nonce_invalidated' | 'not_owner' | 'not_approved'

/**
 * Checks off-chain orders against chain state in a single multicall (4 reads per order). An order
 * book is only a cache: the seller may have sold the token elsewhere, revoked approval, or bumped
 * their nonce. Deployless multicall works on chains without Multicall3 (e.g. a fresh anvil).
 */
export async function checkOrders(
  client: PublicClient,
  chainId: number,
  market: Address,
  orders: readonly Order[],
  now = BigInt(Math.floor(Date.now() / 1000)),
): Promise<OrderStatus[]> {
  if (orders.length === 0) return []
  const contracts = orders.flatMap((order) => [
    { address: market, abi: omniMarketAbi, functionName: 'orderUsed', args: [hashOrder(chainId, market, order)] },
    { address: market, abi: omniMarketAbi, functionName: 'nonces', args: [order.seller] },
    { address: order.collection, abi: omniNftAbi, functionName: 'ownerOf', args: [order.tokenId] },
    { address: order.collection, abi: omniNftAbi, functionName: 'isApprovedForAll', args: [order.seller, market] },
  ] as const)

  const results = await client.multicall({
    contracts,
    allowFailure: true,
    deployless: !client.chain?.contracts?.multicall3,
  })

  return orders.map((order, i) => {
    const [used, nonce, owner, approved] = results.slice(i * 4, i * 4 + 4).map((r) => r?.result)
    if (order.deadline < now) return 'expired'
    if (used === true) return 'used'
    if (typeof nonce === 'bigint' && nonce !== order.nonce) return 'nonce_invalidated'
    if (typeof owner !== 'string' || !isAddressEqual(owner as Address, order.seller)) return 'not_owner'
    if (approved !== true) return 'not_approved'
    return 'active'
  })
}
