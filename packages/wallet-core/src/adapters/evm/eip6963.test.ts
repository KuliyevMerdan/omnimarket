import { mainnet } from 'viem/chains'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { announceProvider, createMockProvider } from '../../testing'
import type { WalletConnector } from '../../types'
import { LEGACY_INJECTED_ID, createEvmAdapter } from './index'
import { watchEip6963Providers } from './eip6963'

afterEach(() => vi.useRealTimers())

describe('watchEip6963Providers', () => {
  it('collects wallets announced before and after the request', () => {
    const target = new EventTarget()
    announceProvider(target, createMockProvider().provider, { rdns: 'io.metamask', name: 'MetaMask' })
    const onChange = vi.fn()
    watchEip6963Providers(target, onChange)
    announceProvider(target, createMockProvider().provider, { rdns: 'io.rabby', name: 'Rabby' })

    const names = onChange.mock.lastCall![0].map((d: { info: { name: string } }) => d.info.name)
    expect(names).toEqual(['MetaMask', 'Rabby'])
  })

  it('keeps the first provider per rdns and ignores malformed announcements', () => {
    const target = new EventTarget()
    const onChange = vi.fn()
    watchEip6963Providers(target, onChange)
    const first = createMockProvider().provider
    announceProvider(target, first, { rdns: 'io.metamask' })
    announceProvider(target, createMockProvider().provider, { rdns: 'io.metamask', name: 'Impostor' })
    target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: {}, provider: {} } }))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.lastCall![0][0].provider).toBe(first)
  })

  it('drops icons that are not image data URIs', () => {
    const target = new EventTarget()
    const onChange = vi.fn()
    watchEip6963Providers(target, onChange)
    announceProvider(target, createMockProvider().provider, { icon: 'javascript:alert(1)' })
    expect(onChange.mock.lastCall![0][0].info.icon).toBe('')
  })
})

describe('createEvmAdapter', () => {
  it('falls back to window.ethereum when nothing announces', () => {
    vi.useFakeTimers()
    const target = Object.assign(new EventTarget(), { ethereum: createMockProvider().provider })
    let wallets: readonly WalletConnector[] = []
    createEvmAdapter({ chains: [mainnet], target }).discover((list) => (wallets = list))

    expect(wallets).toEqual([])
    vi.advanceTimersByTime(300)
    expect(wallets.map((w) => w.info.id)).toEqual([LEGACY_INJECTED_ID])
  })

  it('does not duplicate window.ethereum when it is also announced', () => {
    vi.useFakeTimers()
    const { provider } = createMockProvider()
    const target = Object.assign(new EventTarget(), { ethereum: provider })
    let wallets: readonly WalletConnector[] = []
    createEvmAdapter({ chains: [mainnet], target }).discover((list) => (wallets = list))
    announceProvider(target, provider, { rdns: 'io.metamask' })
    vi.advanceTimersByTime(300)

    expect(wallets.map((w) => w.info.id)).toEqual(['eip155:io.metamask'])
  })

  it('keeps connector identity stable across announcements', () => {
    const target = new EventTarget()
    const snapshots: (readonly WalletConnector[])[] = []
    createEvmAdapter({ chains: [mainnet], target }).discover((list) => snapshots.push(list))
    announceProvider(target, createMockProvider().provider, { rdns: 'a' })
    announceProvider(target, createMockProvider().provider, { rdns: 'b' })

    expect(snapshots[1]![0]).toBe(snapshots[0]![0])
  })
})
