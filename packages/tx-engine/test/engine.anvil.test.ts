import { omniMarketAbi, omniNftAbi, orderTypedData, type Order } from '@omnimarket/contracts'
import { omniMarketBytecode, omniNftBytecode } from '@omnimarket/contracts/bytecode'
import { createMemoryStorage, type KeyValueStorage } from '@omnimarket/wallet-core'
import { Eip1193Connector } from '@omnimarket/wallet-core/evm'
import { createMockProvider } from '@omnimarket/wallet-core/testing'
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseEther,
  publicActions,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { TxEngine, type TxEngineOptions } from '../src'
import { ANVIL_KEYS, hasAnvil, startAnvil, type Anvil } from './anvil'

describe.skipIf(!hasAnvil)('TxEngine on anvil', () => {
  let anvil: Anvil
  let client: PublicClient
  let test: ReturnType<typeof makeTestClient>
  let market: Address
  let nft: Address
  let now: number

  const makeTestClient = (url: string) =>
    createTestClient({ mode: 'anvil', chain: foundry, transport: http(url) }).extend(publicActions)

  beforeAll(async () => {
    anvil = await startAnvil()
    const chain = { ...foundry, rpcUrls: { default: { http: [anvil.url] } } }
    client = createPublicClient({ chain, transport: http(anvil.url) }) as PublicClient
    test = makeTestClient(anvil.url)
    const deployer = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS[0]), chain, transport: http(anvil.url) })
    const deploy = async (abi: typeof omniMarketAbi | typeof omniNftAbi, bytecode: Hex) => {
      const hash = await deployer.deployContract({ abi, bytecode })
      return (await client.waitForTransactionReceipt({ hash })).contractAddress!
    }
    market = await deploy(omniMarketAbi, omniMarketBytecode)
    nft = await deploy(omniNftAbi, omniNftBytecode)
  })

  afterAll(() => anvil?.stop())

  beforeEach(async () => {
    now = 1_000_000
    await test.setAutomine(true)
  })

  function wallet(key: Hex) {
    const mock = createMockProvider({ privateKey: key, chainId: 31337, rpcUrl: anvil.url, authorized: true })
    const connector = new Eip1193Connector({
      provider: mock.provider,
      chains: [{ ...foundry, rpcUrls: { default: { http: [anvil.url] } } }],
      info: { id: 'eip155:mock', name: 'Mock', icon: '', rdns: 'dev.omnimarket.mock', namespace: 'eip155', source: 'eip6963' },
    })
    return { mock, connector, address: mock.account.address }
  }

  function engine(overrides: Partial<TxEngineOptions> = {}, storage: KeyValueStorage = createMemoryStorage()) {
    return new TxEngine({
      getPublicClient: () => client,
      abis: [omniMarketAbi, omniNftAbi],
      storage,
      // Anvil mines asynchronously after eth_sendRawTransaction, so the first poll can race it.
      // Assertions on intermediate states always follow an explicit pollNow().
      pollingIntervalMs: 200,
      stuckAfterMs: 60_000,
      dropAfterMs: 120_000,
      canReplace: (info) => info.rdns?.startsWith('dev.omnimarket') ?? false,
      now: () => now,
      ...overrides,
    })
  }

  async function connected(key: Hex) {
    const w = wallet(key)
    await w.connector.connect({ silent: true })
    return w
  }

  const mint = (txs: TxEngine, w: Awaited<ReturnType<typeof connected>>, amount = 1n) =>
    txs.writeContract({
      signer: w.connector,
      account: w.address,
      chainId: 31337,
      label: 'Mint',
      address: nft,
      abi: omniNftAbi,
      functionName: 'mint',
      args: [amount],
    })

  /** Starts a tx with automine off and waits until the engine knows its nonce. */
  async function pendingMint(txs: TxEngine, w: Awaited<ReturnType<typeof connected>>) {
    await test.setAutomine(false)
    const done = mint(txs, w)
    await expect.poll(() => txs.getState().txs[0]?.status).toBe('pending')
    await txs.pollNow()
    const record = txs.get(txs.getState().txs[0]!.id)!
    expect(record.nonce).toBeTypeOf('number')
    return { done, id: record.id }
  }

  it('runs the happy path and decodes events', async () => {
    const txs = engine()
    const w = await connected(ANVIL_KEYS[1])
    const result = await mint(txs, w, 2n)

    expect(result.status).toBe('confirmed')
    expect(result.events?.map((e) => e.eventName)).toEqual(['Transfer', 'Transfer'])
    expect(result.events?.[0]?.args.to).toBe(w.address)
  })

  it('stops at simulation and never prompts for a reverting call', async () => {
    const txs = engine()
    const w = await connected(ANVIL_KEYS[1])
    const result = await mint(txs, w, 6n)

    expect(result).toMatchObject({
      status: 'failed',
      error: { kind: 'simulation_reverted', errorName: 'MintAmountInvalid', errorArgs: ['6'] },
    })
    expect(w.mock.calls.map((c) => c.method)).not.toContain('eth_sendTransaction')
  })

  it('records a user rejection', async () => {
    const txs = engine()
    const w = await connected(ANVIL_KEYS[1])
    w.mock.rejectNextRequest()
    expect((await mint(txs, w)).error?.kind).toBe('user_rejected')
  })

  it('decodes a custom error raised by another contract inside the call', async () => {
    const txs = engine()
    const seller = await connected(ANVIL_KEYS[2])
    const buyer = await connected(ANVIL_KEYS[3])
    await mint(txs, seller)
    const tokenId = await client.readContract({ address: nft, abi: omniNftAbi, functionName: 'totalSupply' })
    const { order, signature } = await signOrder(seller, tokenId)

    // Seller never approved the market: OmniNFT's ERC721InsufficientApproval bubbles up through OmniMarket.
    const result = await fill(txs, buyer, order, signature)
    expect(result.error).toMatchObject({ kind: 'simulation_reverted', errorName: 'ERC721InsufficientApproval' })
  })

  it('explains an on-chain revert: another buyer filled the order in the same block', async () => {
    const txs = engine()
    const seller = await connected(ANVIL_KEYS[2])
    const first = await connected(ANVIL_KEYS[1])
    const second = await connected(ANVIL_KEYS[3])
    await mint(txs, seller)
    await txs.writeContract({
      signer: seller.connector,
      account: seller.address,
      chainId: 31337,
      label: 'Approve',
      address: nft,
      abi: omniNftAbi,
      functionName: 'setApprovalForAll',
      args: [market, true],
    })
    const tokenId = await client.readContract({ address: nft, abi: omniNftAbi, functionName: 'totalSupply' })
    const { order, signature } = await signOrder(seller, tokenId)

    await test.setAutomine(false)
    const a = fill(txs, first, order, signature)
    const b = fill(txs, second, order, signature)
    await expect.poll(() => txs.getState().txs.filter((t) => t.status === 'pending').length).toBe(2)
    await test.mine({ blocks: 1 })
    await txs.pollNow()

    const results = await Promise.all([a, b])
    expect(results.map((r) => r.status).sort()).toEqual(['confirmed', 'failed'])
    expect(results.find((r) => r.status === 'failed')?.error).toMatchObject({ kind: 'reverted', errorName: 'OrderUnavailable' })
  })

  it('speeds up with the same nonce and follows the replacement', async () => {
    const txs = engine()
    const w = await connected(ANVIL_KEYS[1])
    const { done, id } = await pendingMint(txs, w)
    now += 61_000
    await txs.pollNow()
    expect(txs.get(id)?.stuck).toBe(true)
    expect(txs.canReplace(txs.get(id), w.connector)).toBe(true)

    await txs.speedUp(id, w.connector)
    await test.mine({ blocks: 1 })
    await txs.pollNow()

    const result = await done
    expect(result.status).toBe('confirmed')
    expect(result.attempts.map((a) => a.kind)).toEqual(['original', 'speedup'])
    expect(result.minedHash).toBe(result.attempts[1]!.hash)
    expect(result.replacement).toMatchObject({ reason: 'repriced' })
    expect(BigInt(result.attempts[1]!.maxFeePerGas!)).toBeGreaterThan(BigInt(result.attempts[0]!.maxFeePerGas!))
  })

  it('cancels with a 0-value self-transfer', async () => {
    const txs = engine()
    const w = await connected(ANVIL_KEYS[1])
    const supply = await client.readContract({ address: nft, abi: omniNftAbi, functionName: 'totalSupply' })
    const { done, id } = await pendingMint(txs, w)

    await txs.cancel(id, w.connector)
    await test.mine({ blocks: 1 })
    await txs.pollNow()

    expect((await done).status).toBe('cancelled')
    expect(await client.readContract({ address: nft, abi: omniNftAbi, functionName: 'totalSupply' })).toBe(supply)
  })

  it('detects a speed-up made in the wallet UI (unknown hash, same nonce)', async () => {
    const txs = engine()
    const w = await connected(ANVIL_KEYS[1])
    const { done, id } = await pendingMint(txs, w)
    const record = txs.get(id)!
    const original = await client.getTransaction({ hash: record.attempts[0]!.hash })

    // What MetaMask's "Speed up" does: same nonce/to/data/value, higher fees, new hash.
    const raw = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS[1]), transport: http(anvil.url) })
    const externalHash = await raw.sendTransaction({
      chain: null,
      to: original.to!,
      data: original.input,
      value: original.value,
      nonce: original.nonce,
      gas: original.gas,
      maxFeePerGas: original.maxFeePerGas! * 2n,
      maxPriorityFeePerGas: original.maxPriorityFeePerGas! * 2n,
    })
    await test.mine({ blocks: 1 })
    await txs.pollNow()

    const result = await done
    expect(result).toMatchObject({ status: 'confirmed', minedHash: externalHash, replacement: { reason: 'repriced' } })
  })

  it('marks a nonce taken by an unrelated transaction as replaced', async () => {
    const txs = engine()
    const w = await connected(ANVIL_KEYS[1])
    const { done, id } = await pendingMint(txs, w)
    const original = await client.getTransaction({ hash: txs.get(id)!.attempts[0]!.hash })

    const raw = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS[1]), transport: http(anvil.url) })
    await raw.sendTransaction({
      chain: null,
      to: privateKeyToAccount(ANVIL_KEYS[0]).address,
      value: 1n,
      nonce: original.nonce,
      maxFeePerGas: original.maxFeePerGas! * 2n,
      maxPriorityFeePerGas: original.maxPriorityFeePerGas! * 2n,
    })
    await test.mine({ blocks: 1 })
    await txs.pollNow()

    expect(await done).toMatchObject({ status: 'replaced', replacement: { reason: 'replaced' } })
  })

  it('fails as dropped when the transaction disappears from the mempool', async () => {
    const txs = engine()
    const w = await connected(ANVIL_KEYS[1])
    const { done, id } = await pendingMint(txs, w)
    await test.dropTransaction({ hash: txs.get(id)!.attempts[0]!.hash })
    now += 121_000
    await txs.pollNow()

    expect((await done).error?.kind).toBe('dropped')
  })

  const mintWithConfirmations = (txs: TxEngine, w: Awaited<ReturnType<typeof connected>>, confirmations: number) =>
    txs.writeContract({
      signer: w.connector,
      account: w.address,
      chainId: 31337,
      label: 'Mint',
      address: nft,
      abi: omniNftAbi,
      functionName: 'mint',
      args: [1n],
      confirmations,
    })

  it('waits for the required number of confirmations', async () => {
    const txs = engine()
    const w = await connected(ANVIL_KEYS[1])
    await test.setAutomine(false)
    const done = mintWithConfirmations(txs, w, 3)
    await expect.poll(() => txs.getState().txs[0]?.status).toBe('pending')
    const id = txs.getState().txs[0]!.id

    await test.mine({ blocks: 1 })
    await txs.pollNow()
    expect(txs.get(id)).toMatchObject({ status: 'confirming', confirmations: 1 })

    await test.mine({ blocks: 2 })
    await txs.pollNow()
    expect(await done).toMatchObject({ status: 'confirmed', confirmations: 3 })
  })

  it('goes back to pending when the block with the receipt is reorged out', async () => {
    const txs = engine()
    const w = await connected(ANVIL_KEYS[1])
    await test.setAutomine(false)
    void mintWithConfirmations(txs, w, 3)
    await expect.poll(() => txs.getState().txs[0]?.status).toBe('pending')
    const id = txs.getState().txs[0]!.id
    const snapshot = await test.snapshot()

    await test.mine({ blocks: 1 })
    await txs.pollNow()
    expect(txs.get(id)).toMatchObject({ status: 'confirming', confirmations: 1 })

    await test.revert({ id: snapshot })
    await txs.pollNow()
    expect(txs.get(id)).toMatchObject({ status: 'pending', confirmations: 0, blockNumber: undefined })
  })

  it('resumes tracking after a reload from storage', async () => {
    const storage = createMemoryStorage()
    const first = engine({}, storage)
    const w = await connected(ANVIL_KEYS[1])
    const { id } = await pendingMint(first, w)

    await test.mine({ blocks: 1 })
    const reloaded = engine({}, storage)
    expect(reloaded.get(id)?.status).toBe('pending')
    await reloaded.pollNow()
    expect(reloaded.get(id)).toMatchObject({ status: 'confirmed', events: [expect.objectContaining({ eventName: 'Transfer' })] })
  })

  it('marks transactions that were waiting for a signature during a reload as interrupted', () => {
    const storage = createMemoryStorage()
    storage.setItem(
      'omni:txs',
      JSON.stringify([
        { id: 'x', label: 'Buy', chainId: 31337, from: '0x0', status: 'awaiting_signature', createdAt: 0, updatedAt: 0, attempts: [], confirmations: 0, requiredConfirmations: 1, stuck: false },
      ]),
    )
    expect(engine({}, storage).get('x')).toMatchObject({ status: 'failed', error: { kind: 'interrupted' } })
  })

  it('refuses app-side replacement for wallets that may ignore the nonce', async () => {
    const txs = engine({ canReplace: () => false })
    const w = await connected(ANVIL_KEYS[1])
    const { id } = await pendingMint(txs, w)
    expect(txs.canReplace(txs.get(id), w.connector)).toBe(false)
    await expect(txs.speedUp(id, w.connector)).rejects.toThrow(/Use your wallet/)
    await test.mine({ blocks: 1 })
  })

  async function signOrder(seller: Awaited<ReturnType<typeof connected>>, tokenId: bigint) {
    const latest = await client.getBlock()
    const order: Order = {
      seller: seller.address,
      collection: nft,
      tokenId,
      price: parseEther('0.1'),
      nonce: await client.readContract({ address: market, abi: omniMarketAbi, functionName: 'nonces', args: [seller.address] }),
      deadline: latest.timestamp + 3600n,
    }
    const signature = await seller.connector.signTypedData(`eip155:31337:${seller.address}`, orderTypedData(31337, market, order))
    return { order, signature }
  }

  function fill(txs: TxEngine, buyer: Awaited<ReturnType<typeof connected>>, order: Order, signature: Hex) {
    return txs.writeContract({
      signer: buyer.connector,
      account: buyer.address,
      chainId: 31337,
      label: `Buy #${order.tokenId}`,
      address: market,
      abi: omniMarketAbi,
      functionName: 'fillOrder',
      args: [order, signature],
      value: order.price,
    })
  }
})

