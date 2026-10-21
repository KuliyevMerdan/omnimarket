import { omniMarketAbi, omniNftAbi } from '@omnimarket/contracts'
import { omniMarketBytecode, omniNftBytecode } from '@omnimarket/contracts/bytecode'
import { TxEngine } from '@omnimarket/tx-engine'
import { createMemoryStorage, WalletError } from '@omnimarket/wallet-core'
import { Eip1193Connector } from '@omnimarket/wallet-core/evm'
import { createMockProvider } from '@omnimarket/wallet-core/testing'
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  getAddress,
  http,
  isAddressEqual,
  type Chain,
  type Address,
  type EIP1193Provider,
  type Hex,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { guardProvider, type RiskReport } from '../src'
import { ANVIL_KEYS, hasAnvil, startAnvil, type Anvil } from '../../tx-engine/test/anvil'

/** A spender with no code, then the same address delegated with EIP-7702. */
const STRANGER: Address = getAddress('0x00000000000000000000000000000000c0ffee00')

describe.skipIf(!hasAnvil)('guard on anvil', () => {
  let anvil: Anvil
  let client: PublicClient
  let market: Address
  let nft: Address
  let chain: Chain

  beforeAll(async () => {
    anvil = await startAnvil()
    chain = { ...foundry, rpcUrls: { default: { http: [anvil.url] } } }
    client = createPublicClient({ chain, transport: http(anvil.url) }) as PublicClient
    const deployer = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS[0]), chain, transport: http(anvil.url) })
    const deploy = async (abi: typeof omniMarketAbi | typeof omniNftAbi, bytecode: Hex) =>
      (await client.waitForTransactionReceipt({ hash: await deployer.deployContract({ abi, bytecode }) })).contractAddress!
    market = getAddress(await deploy(omniMarketAbi, omniMarketBytecode))
    nft = getAddress(await deploy(omniNftAbi, omniNftBytecode))
  })

  afterAll(() => anvil?.stop())

  function setup(review: (report: RiskReport) => Promise<boolean>, wrap = (p: EIP1193Provider) => p) {
    const mock = createMockProvider({ privateKey: ANVIL_KEYS[1], chainId: 31337, rpcUrl: anvil.url, authorized: true })
    const reports: RiskReport[] = []
    const provider = guardProvider(wrap(mock.provider), {
      review,
      getClient: () => client,
      known: (_chainId, address) => (isAddressEqual(address, market) ? { name: 'OmniMarket' } : undefined),
      onReport: (report) => reports.push(report),
    })
    const signer = new Eip1193Connector({
      provider,
      chains: [chain],
      info: { id: 'eip155:mock', name: 'Mock', icon: '', namespace: 'eip155', source: 'eip6963' },
    })
    const engine = new TxEngine({ getPublicClient: () => client, abis: [omniMarketAbi, omniNftAbi], storage: createMemoryStorage(), pollingIntervalMs: 100 })
    const write = (functionName: 'setApprovalForAll' | 'approve' | 'mint', args: readonly unknown[], label = functionName) =>
      engine.writeContract({ signer, account: mock.account.address, chainId: 31337, label, address: nft, abi: omniNftAbi, functionName, args } as never)
    return { mock, signer, engine, reports, write }
  }

  it('lets the known market through, stops an approval to a personal address before the wallet', async () => {
    const review = async () => false
    const { write, reports, mock, engine } = setup(review)
    const stop = engine.start()

    const trusted = await write('setApprovalForAll', [market, true])
    expect(reports.at(-1)!.level).toBe('info')
    expect(trusted.status).toBe('confirmed')

    const sent = mock.calls.filter((c) => c.method === 'eth_sendTransaction').length
    const scam = await write('setApprovalForAll', [STRANGER, true])
    expect(reports.at(-1)).toMatchObject({ level: 'danger', intent: { kind: 'approval_for_all', operator: STRANGER } })
    expect(reports.at(-1)!.findings.map((f) => f.code)).toContain('SPENDER_EOA')
    expect(scam.status).toBe('failed')
    expect(scam.error?.kind).toBe('user_rejected')
    expect(mock.calls.filter((c) => c.method === 'eth_sendTransaction').length).toBe(sent)
    stop()
  })

  it('reads ERC-165 to tell an NFT approve from an ERC-20 one, and sees EIP-7702 delegations', async () => {
    const { write, reports, engine } = setup(async () => true)
    const stop = engine.start()
    const tokenId = (await client.readContract({ address: nft, abi: omniNftAbi, functionName: 'totalSupply' })) + 1n
    expect((await write('mint', [1n])).status).toBe('confirmed')

    const test = createTestClient({ mode: 'anvil', chain, transport: http(anvil.url) })
    await test.setCode({ address: STRANGER, bytecode: `0xef0100${market.slice(2)}` })
    const approved = await write('approve', [STRANGER, tokenId])
    expect(reports.at(-1)!.intent).toMatchObject({ kind: 'nft_approve', collection: nft, spender: STRANGER })
    expect(reports.at(-1)!.findings.map((f) => f.code)).toEqual(['SPENDER_DELEGATED'])
    expect(approved.status).toBe('confirmed')
    stop()
  })

  it('maps a blocked request to a `blocked` record through viem’s error wrapping', async () => {
    const blocking = (p: EIP1193Provider) =>
      new Proxy(p, {
        get: (target, prop) =>
          prop === 'request'
            ? async (args: { method: string }) => {
                if (args.method === 'eth_sendTransaction') throw new WalletError('BLOCKED', 'Blocked by OmniMarket: test.')
                return target.request(args as never)
              }
            : Reflect.get(target, prop),
      })
    const { write } = setup(async () => true, blocking)
    const record = await write('setApprovalForAll', [market, false])
    expect(record.error).toMatchObject({ kind: 'blocked', message: 'Blocked by OmniMarket: test.' })
  })
})
