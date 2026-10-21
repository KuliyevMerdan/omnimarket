import type { SiweClient } from '@omnimarket/auth/client'
import { WalletManager, createMemoryStorage } from '@omnimarket/wallet-core'
import { createEvmAdapter } from '@omnimarket/wallet-core/evm'
import { announceProvider, createMockProvider } from '@omnimarket/wallet-core/testing'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { mainnet } from 'viem/chains'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { createOmniVue, useAccount, useSiwe, useWallets } from '.'
import { defineWalletStore } from './pinia'

function setup(authorized = false) {
  const target = new EventTarget()
  const mock = createMockProvider({ authorized })
  const manager = new WalletManager({ adapters: [createEvmAdapter({ chains: [mainnet], target })], storage: createMemoryStorage() })
  return { target, mock, manager, announce: () => announceProvider(target, mock.provider, { rdns: 'io.metamask', name: 'MetaMask' }) }
}

const Probe = defineComponent({
  setup() {
    const wallets = useWallets()
    const account = useAccount()
    return () =>
      h('ul', [
        h('li', { id: 'wallets' }, wallets.value.map((w) => w.name).join(',')),
        h('li', { id: 'status' }, account.value.status),
        h('li', { id: 'address' }, account.value.address ?? '-'),
      ])
  },
})

describe('vue bindings', () => {
  it('render discovered wallets and connection updates', async () => {
    const { manager, mock, announce } = setup()
    const wrapper = mount(Probe, { global: { plugins: [createOmniVue({ manager })] } })
    announce()
    await nextTick()
    expect(wrapper.get('#wallets').text()).toBe('MetaMask')

    await manager.connect('eip155:io.metamask')
    await nextTick()
    expect(wrapper.get('#status').text()).toBe('connected')
    expect(wrapper.get('#address').text()).toBe(mock.account.address)

    const next = mock.switchAccount()
    await nextTick()
    expect(wrapper.get('#address').text()).toBe(next.address)
  })

  it('unsubscribes with the component and stops what the plugin started', () => {
    const { manager } = setup()
    const subscribe = manager.subscribe
    const unsubscribed = vi.fn()
    vi.spyOn(manager, 'subscribe').mockImplementation((listener) => {
      const unsubscribe = subscribe(listener)
      return () => {
        unsubscribed()
        unsubscribe()
      }
    })
    const stopEngine = vi.fn()
    const wrapper = mount(Probe, { global: { plugins: [createOmniVue({ manager, engines: [{ start: () => stopEngine }] })] } })
    const subscriptions = vi.mocked(manager.subscribe).mock.calls.length
    expect(subscriptions).toBeGreaterThan(0)

    wrapper.unmount()
    expect(unsubscribed).toHaveBeenCalledTimes(subscriptions)
    expect(stopEngine).toHaveBeenCalledTimes(1)
  })

  it('signs out of SIWE when the wallet switches to another account', async () => {
    const { manager, mock, announce } = setup()
    announce()
    const signOut = vi.fn().mockResolvedValue(undefined)
    const siwe = {
      getSession: vi.fn().mockResolvedValue({ namespace: 'eip155', address: mock.account.address.toLowerCase() }),
      signOut,
      signIn: vi.fn(),
    } as unknown as SiweClient
    let status = ''
    const Auth = defineComponent({
      setup() {
        const auth = useSiwe()
        return () => h('span', (status = auth.status.value))
      },
    })
    mount(Auth, { global: { plugins: [createOmniVue({ manager, siwe })] } })
    await manager.connect('eip155:io.metamask')
    await vi.waitFor(() => expect(status).toBe('signed-in'))
    expect(signOut).not.toHaveBeenCalled()

    mock.switchAccount()
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(status).toBe('signed-out'))
  })
})

describe('pinia wallet store', () => {
  it('mirrors the manager without keeping state of its own', async () => {
    const { manager, mock, announce } = setup()
    manager.start()
    announce()
    setActivePinia(createPinia())
    const store = defineWalletStore(manager)()

    expect(Object.keys(store.$state)).toEqual([])
    expect(store.wallets.map((w) => w.id)).toEqual(['eip155:io.metamask'])
    await store.connect('eip155:io.metamask')
    expect(store.isConnected).toBe(true)
    expect(store.account.address).toBe(mock.account.address)

    await manager.disconnect()
    expect(store.status).toBe('disconnected')
  })
})
