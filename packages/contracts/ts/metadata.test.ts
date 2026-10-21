import { describe, expect, it } from 'vitest'
import { parseTokenUri, sanitizeImageUrl } from './metadata'
import { parseOrder, serializeOrder } from './orders'

const encode = (value: object) => `data:application/json;base64,${btoa(JSON.stringify(value))}`

describe('parseTokenUri', () => {
  it('decodes on-chain base64 JSON metadata', () => {
    const image = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
    expect(parseTokenUri(encode({ name: 'Omni #1', description: 'd', image }))).toEqual({
      name: 'Omni #1',
      description: 'd',
      image,
    })
  })

  it('drops dangerous image URLs and ignores animation_url', () => {
    const meta = parseTokenUri(encode({ name: 'x', image: 'javascript:alert(1)', animation_url: 'data:text/html,<script>' }))
    expect(meta).toEqual({ name: 'x', description: '', image: '' })
    expect(sanitizeImageUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe('')
    expect(sanitizeImageUrl('http://insecure.example/a.png')).toBe('')
  })

  it('maps ipfs:// to a gateway and keeps https', () => {
    expect(sanitizeImageUrl('ipfs://ipfs/Qm123/1.png')).toBe('https://ipfs.io/ipfs/Qm123/1.png')
    expect(sanitizeImageUrl('https://cdn.example/a.png')).toBe('https://cdn.example/a.png')
  })

  it('rejects non-JSON, malformed and oversized input', () => {
    expect(parseTokenUri('https://example.com/1.json')).toBeNull()
    expect(parseTokenUri('data:application/json;base64,!!!')).toBeNull()
    expect(parseTokenUri(encode({}).padEnd(300_000, 'A'))).toBeNull()
  })

  it('caps string lengths and ignores wrong types', () => {
    const meta = parseTokenUri(encode({ name: 'n'.repeat(1000), description: 42 }))
    expect(meta?.name).toHaveLength(200)
    expect(meta?.description).toBe('')
  })
})

describe('parseOrder', () => {
  const order = {
    seller: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    collection: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
    tokenId: '1',
    price: '100000000000000000',
    nonce: '0',
    deadline: '1800000000',
  }

  it('round-trips and checksums addresses', () => {
    const parsed = parseOrder(order)
    expect(parsed.seller).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8')
    expect(serializeOrder(parsed)).toEqual({ ...order, seller: parsed.seller, collection: parsed.collection })
  })

  it.each([
    ['negative', { price: '-1' }],
    ['float', { price: '1.5' }],
    ['hex', { tokenId: '0x1' }],
    ['leading zeros', { nonce: '01' }],
    ['overflow', { deadline: (2n ** 256n).toString() }],
    ['number type', { price: 1 }],
    ['bad address', { seller: '0x123' }],
  ])('rejects %s', (_, patch) => {
    expect(() => parseOrder({ ...order, ...patch })).toThrow(TypeError)
  })
})
