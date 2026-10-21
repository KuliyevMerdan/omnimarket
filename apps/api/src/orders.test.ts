import { orderTypedData, serializeOrder, type Order } from '@omnimarket/contracts'
import { getAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { createApp } from './app'

const MARKET = getAddress('0x5fbdb2315678afecb367f032d93f642f64180aa3')
const NFT = getAddress('0xe7f1725e7734ce288f8367e1bb143e90bb3f0512')
const NOW = Date.UTC(2026, 9, 21)
const seller = privateKeyToAccount(generatePrivateKey())

function app() {
  return createApp(
    {
      siweDomain: 'localhost:5173',
      siweOrigin: 'http://localhost:5173',
      chainIds: [31337],
      sessionTtlMs: 60_000,
      secureCookies: false,
      markets: new Map([[31337, { market: MARKET, collections: [NFT] }]]),
    },
    { now: () => new Date(NOW) },
  )
}

function order(patch: Partial<Order> = {}): Order {
  return {
    seller: seller.address,
    collection: NFT,
    tokenId: 1n,
    price: 10n ** 17n,
    nonce: 0n,
    deadline: BigInt(NOW / 1000 + 3600),
    ...patch,
  }
}

async function post(api: ReturnType<typeof app>, o: Order, signer = seller, chainId = 31337) {
  const signature = await signer.signTypedData(orderTypedData(31337, MARKET, o))
  return api.request('/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chainId, order: serializeOrder(o), signature }),
  })
}

const list = async (api: ReturnType<typeof app>) =>
  ((await (await api.request('/orders?chainId=31337')).json()) as { orders: { hash: string; order: { price: string } }[] }).orders

describe('order book API', () => {
  it('accepts a signed listing and lists it', async () => {
    const api = app()
    const response = await post(api, order())
    expect(response.status).toBe(201)
    const { hash } = (await response.json()) as { hash: string }
    expect((await list(api)).map((o) => o.hash)).toEqual([hash])
  })

  it('rejects a listing not signed by the seller', async () => {
    const api = app()
    const response = await post(api, order(), privateKeyToAccount(generatePrivateKey()))
    expect(response.status).toBe(401)
    expect(await list(api)).toEqual([])
  })

  it('rejects collections outside the allowlist', async () => {
    const response = await post(app(), order({ collection: getAddress('0x000000000000000000000000000000000000beef') }))
    expect(await response.json()).toMatchObject({ error: 'COLLECTION_NOT_ALLOWED' })
  })

  it('rejects expired and too-far deadlines', async () => {
    const api = app()
    expect((await post(api, order({ deadline: BigInt(NOW / 1000 - 1) }))).status).toBe(400)
    expect((await post(api, order({ deadline: BigInt(NOW / 1000 + 31 * 86400) }))).status).toBe(400)
  })

  it('rejects chains without a market', async () => {
    expect((await post(app(), order(), seller, 1)).status).toBe(400)
  })

  it('keeps one listing per token (the newest)', async () => {
    const api = app()
    await post(api, order({ price: 1n }))
    await post(api, order({ price: 2n }))
    expect((await list(api)).map((o) => o.order.price)).toEqual(['2'])
  })

  it('rejects malformed orders', async () => {
    const response = await app().request('/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chainId: 31337, order: { ...serializeOrder(order()), price: '-1' }, signature: `0x${'1'.repeat(130)}` }),
    })
    expect(response.status).toBe(400)
  })
})
