import { WalletManager, createMemoryStorage } from '@omnimarket/wallet-core'
import { createEvmAdapter } from '@omnimarket/wallet-core/evm'
import { announceProvider, createMockProvider } from '@omnimarket/wallet-core/testing'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { mainnet } from 'viem/chains'
import { afterEach, describe, expect, it } from 'vitest'
import { WalletProvider, useAccount, useWallets } from './wallet'

afterEach(cleanup)

function Probe() {
  const wallets = useWallets()
  const { status, address, chainId } = useAccount()
  return (
    <ul>
      <li data-testid="wallets">{wallets.map((w) => w.name).join(',')}</li>
      <li data-testid="status">{status}</li>
      <li data-testid="address">{address ?? '-'}</li>
      <li data-testid="chain">{chainId ?? '-'}</li>
    </ul>
  )
}

function setup(authorized = false) {
  const target = new EventTarget()
  const mock = createMockProvider({ authorized })
  const storage = createMemoryStorage()
  const manager = new WalletManager({ adapters: [createEvmAdapter({ chains: [mainnet], target })], storage })
  return { target, mock, storage, manager }
}

describe('react bindings', () => {
  it('renders discovered wallets and connection updates', async () => {
    const { target, mock, manager } = setup()
    render(
      <StrictMode>
        <WalletProvider manager={manager}>
          <Probe />
        </WalletProvider>
      </StrictMode>,
    )
    act(() => void announceProvider(target, mock.provider, { name: 'MetaMask', rdns: 'io.metamask' }))
    expect(screen.getByTestId('wallets').textContent).toBe('MetaMask')

    await act(() => manager.connect('eip155:io.metamask'))
    expect(screen.getByTestId('status').textContent).toBe('connected')
    expect(screen.getByTestId('address').textContent).toBe(mock.account.address)

    let nextAddress = ''
    act(() => {
      nextAddress = mock.switchAccount().address
    })
    expect(screen.getByTestId('address').textContent).toBe(nextAddress)
  })

  it('restores the session under StrictMode', async () => {
    const { target, mock, storage, manager } = setup(true)
    storage.setItem('omni:last-wallet', 'eip155:io.metamask')
    render(
      <StrictMode>
        <WalletProvider manager={manager}>
          <Probe />
        </WalletProvider>
      </StrictMode>,
    )
    expect(screen.getByTestId('status').textContent).toBe('reconnecting')
    act(() => void announceProvider(target, mock.provider, { rdns: 'io.metamask' }))
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('connected'))
    expect(screen.getByTestId('chain').textContent).toBe('eip155:1')
  })
})
