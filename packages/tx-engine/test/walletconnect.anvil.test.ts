import { createMemoryStorage, WalletManager } from '@omnimarket/wallet-core'
import { isEvmConnector } from '@omnimarket/wallet-core/evm'
import { createMockWalletConnect } from '@omnimarket/wallet-core/testing'
import { createWalletConnect } from '@omnimarket/wallet-core/walletconnect'
import { createPublicClient, http, type PublicClient } from 'viem'
import { foundry } from 'viem/chains'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { TxEngine } from '../src'
import { ANVIL_KEYS, hasAnvil, startAnvil, type Anvil } from './anvil'

/**
 * The whole path a phone wallet takes: WalletManager → WalletConnect EIP-1193 provider → relay
 * (mock) → wallet signs and broadcasts → the engine tracks the hash through the public RPC.
 */
describe.skipIf(!hasAnvil)('TxEngine over WalletConnect on anvil', () => {
  let anvil: Anvil
  let client: PublicClient

  beforeAll(async () => {
    anvil = await startAnvil()
    client = createPublicClient({ chain: foundry, transport: http(anvil.url) }) as PublicClient
  })
  afterAll(() => anvil?.stop())

  it('sends through the wallet, simulates and tracks through the RPC', async () => {
    const wallet = await createMockWalletConnect({ evm: { privateKey: ANVIL_KEYS[2], chainIds: [31337], rpcUrl: anvil.url } })
    const chain = { ...foundry, rpcUrls: { default: { http: [anvil.url] } } }
    const wc = createWalletConnect({
      projectId: 'test',
      metadata: { name: 'OmniMarket', description: 'test', url: 'https://omni.example', icons: [] },
      createClient: wallet.createClient,
      openWallet: 'never',
      eip155: { chains: [chain] },
    })
    const manager = new WalletManager({ adapters: wc.adapters, storage: createMemoryStorage() })
    manager.start()
    const connecting = manager.connect('eip155:walletconnect')
    await vi.waitFor(() => expect(wallet.pendingUri).toBeTruthy())
    wallet.approve()
    await connecting

    const signer = manager.getActiveConnector()
    if (!isEvmConnector(signer)) throw new Error('expected EVM connector')
    const engine = new TxEngine({ getPublicClient: () => client, abis: [], storage: createMemoryStorage(), pollingIntervalMs: 100 })
    const to = '0x000000000000000000000000000000000000dEaD'
    const before = await client.getBalance({ address: to })

    const record = await engine.sendTransaction({ signer, account: wallet.evm!.account.address, chainId: 31337, label: 'Tip', to, value: 1234n })

    expect(record.status).toBe('confirmed')
    expect(await client.getBalance({ address: to })).toBe(before + 1234n)
    // Only the signature went over the relay; chain id, simulation, gas and receipts did not.
    expect(wallet.requests.map((r) => r.method)).toEqual(['eth_sendTransaction'])
    expect(wallet.requests[0]).toMatchObject({ chainId: 'eip155:31337' })
  })
})
