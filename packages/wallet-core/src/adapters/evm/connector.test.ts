import { recoverMessageAddress, recoverTypedDataAddress, type TypedDataDefinition } from 'viem'
import { mainnet, polygonAmoy, sepolia } from 'viem/chains'
import { describe, expect, it, vi } from 'vitest'
import { createMockProvider, type MockProviderOptions } from '../../testing'
import type { CaipAccountId } from '../../types'
import { Eip1193Connector } from './connector'

function setup(options?: MockProviderOptions) {
  const mock = createMockProvider(options)
  const connector = new Eip1193Connector({
    provider: mock.provider,
    chains: [mainnet, sepolia, polygonAmoy],
    info: { id: 'eip155:mock', name: 'Mock', icon: '', namespace: 'eip155', source: 'eip6963' },
  })
  return { mock, connector }
}

const order = (chainId: number) =>
  ({
    domain: { name: 'OmniMarket', version: '1', chainId },
    types: { Order: [{ name: 'tokenId', type: 'uint256' }, { name: 'price', type: 'uint256' }] },
    primaryType: 'Order',
    message: { tokenId: 1n, price: 10n ** 18n },
  }) as const satisfies TypedDataDefinition

describe('Eip1193Connector', () => {
  it('connects and reports CAIP-10 accounts', async () => {
    const { mock, connector } = setup({ chainId: 11155111 })
    const connection = await connector.connect()
    expect(connection).toEqual({
      chainId: 'eip155:11155111',
      accounts: [`eip155:11155111:${mock.account.address}`],
    })
  })

  it('silent connect fails without prompting when not authorized', async () => {
    const { mock, connector } = setup()
    await expect(connector.connect({ silent: true })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(mock.calls.map((c) => c.method)).not.toContain('eth_requestAccounts')
  })

  it('normalizes user rejection', async () => {
    const { mock, connector } = setup()
    mock.rejectNextRequest()
    await expect(connector.connect()).rejects.toMatchObject({ code: 'USER_REJECTED' })
  })

  it('produces a personal_sign signature that recovers to the account', async () => {
    const { mock, connector } = setup()
    const { accounts } = await connector.connect()
    const signature = await connector.signMessage({ account: accounts[0]!, message: 'hello' })
    expect(await recoverMessageAddress({ message: 'hello', signature })).toBe(mock.account.address)
  })

  it('refuses to sign for an account that is not connected', async () => {
    const { connector } = setup()
    await connector.connect()
    const stranger: CaipAccountId = 'eip155:1:0x000000000000000000000000000000000000dEaD'
    await expect(connector.signMessage({ account: stranger, message: 'x' })).rejects.toMatchObject({
      code: 'ACCOUNT_MISMATCH',
    })
  })

  it('signs EIP-712 data for the current chain', async () => {
    const { mock, connector } = setup({ chainId: 1 })
    const { accounts } = await connector.connect()
    const signature = await connector.signTypedData(accounts[0]!, order(1))
    expect(await recoverTypedDataAddress({ ...order(1), signature })).toBe(mock.account.address)
  })

  it('refuses EIP-712 data bound to another chain', async () => {
    const { mock, connector } = setup({ chainId: 1 })
    const { accounts } = await connector.connect()
    await expect(connector.signTypedData(accounts[0]!, order(137))).rejects.toMatchObject({ code: 'CHAIN_MISMATCH' })
    expect(mock.calls.map((c) => c.method)).not.toContain('eth_signTypedData_v4')
  })

  it('adds an unknown chain on 4902 and then switches', async () => {
    const { mock, connector } = setup({ chainId: 1 })
    await connector.connect()
    const onEvent = vi.fn()
    connector.subscribe(onEvent)
    await connector.switchChain('eip155:80002')

    expect(mock.calls.map((c) => c.method)).toEqual(
      expect.arrayContaining(['wallet_addEthereumChain', 'wallet_switchEthereumChain']),
    )
    expect(connector.chainId).toBe(80002)
    expect(onEvent).toHaveBeenCalledWith({ type: 'change', connection: expect.objectContaining({ chainId: 'eip155:80002' }) })
  })

  it('rejects chains the dApp has not configured', async () => {
    const { connector } = setup()
    await connector.connect()
    await expect(connector.switchChain('eip155:56')).rejects.toMatchObject({ code: 'UNRECOGNIZED_CHAIN' })
  })

  it('emits change on account switch and disconnect on lock', async () => {
    const { mock, connector } = setup()
    await connector.connect()
    const onEvent = vi.fn()
    connector.subscribe(onEvent)

    const next = mock.switchAccount()
    expect(onEvent).toHaveBeenLastCalledWith({
      type: 'change',
      connection: { chainId: 'eip155:1', accounts: [`eip155:1:${next.address}`] },
    })
    mock.lock()
    expect(onEvent).toHaveBeenLastCalledWith({ type: 'disconnect' })
  })

  it('disconnect removes provider listeners and revokes permissions', async () => {
    const { mock, connector } = setup()
    await connector.connect()
    expect(mock.listenerCount('accountsChanged')).toBe(1)
    await connector.disconnect()
    expect(mock.listenerCount('accountsChanged')).toBe(0)
    await expect(connector.connect({ silent: true })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })
})
