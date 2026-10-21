import { afterEach, describe, expect, it, vi } from 'vitest'
import { OmniAddress, OmniTxStatus, OmniWalletOption, defineOnce, shortenAddress } from '.'

afterEach(() => {
  document.body.replaceChildren()
})

type OmniTag = Extract<keyof HTMLElementTagNameMap, `omni-${string}`>

async function mount<K extends OmniTag>(tag: K, props: Partial<HTMLElementTagNameMap[K]>) {
  const element = Object.assign(document.createElement(tag), props)
  document.body.append(element)
  await element.updateComplete
  return element
}

describe('registration', () => {
  it('defines each element once, even when a second bundle registers again', () => {
    expect(customElements.get('omni-address')).toBe(OmniAddress)
    class Duplicate extends OmniAddress {}
    expect(() => defineOnce('omni-address', Duplicate)).not.toThrow()
    expect(customElements.get('omni-address')).toBe(OmniAddress)
  })
})

describe('omni-address', () => {
  it('shortens addresses and keeps the full value available', async () => {
    expect(shortenAddress('0x52908400098527886E0F7030069857D2E4169EE7')).toBe('0x5290…9EE7')
    expect(shortenAddress('7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV', 6)).toBe('7EcDhS…wCFLtV')
    expect(shortenAddress('0x1234')).toBe('0x1234')

    const element = await mount('omni-address', { value: '0x52908400098527886E0F7030069857D2E4169EE7' })
    const label = element.shadowRoot!.querySelector('span')!
    expect(label.textContent).toBe('0x5290…9EE7')
    expect(label.title).toBe('0x52908400098527886E0F7030069857D2E4169EE7')
  })

  it('copies the full address and announces it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const element = await mount('omni-address', { value: '0xabc0000000000000000000000000000000000def' })
    const copied = vi.fn()
    element.addEventListener('omni-copy', (e) => copied((e as CustomEvent).detail))

    element.shadowRoot!.querySelector('button')!.click()
    await vi.waitFor(() => expect(copied).toHaveBeenCalledWith({ value: '0xabc0000000000000000000000000000000000def' }))
    expect(writeText).toHaveBeenCalledWith('0xabc0000000000000000000000000000000000def')
    await element.updateComplete
    expect(element.shadowRoot!.querySelector('button')!.textContent).toBe('Copied')
    vi.unstubAllGlobals()
  })
})

describe('omni-tx-status', () => {
  it('labels every engine status and degrades to plain text for unknown ones', async () => {
    const element = await mount('omni-tx-status', { status: 'awaiting_signature' })
    expect(element.shadowRoot!.querySelector('span')!.textContent).toBe('Check your wallet')
    expect(element.shadowRoot!.querySelector('span')!.className).toBe('active')

    element.status = '<img src=x onerror=alert(1)>'
    await element.updateComplete
    expect(element.shadowRoot!.querySelector('img')).toBeNull()
    expect(element.shadowRoot!.querySelector('span')!.className).toBe('neutral')
    expect(OmniTxStatus).toBeDefined()
  })
})

describe('omni-wallet-option', () => {
  it('renders only data-URI icons', async () => {
    const safe = await mount('omni-wallet-option', { name: 'Rabby', icon: 'data:image/svg+xml;base64,PHN2Zy8+' })
    expect(safe.shadowRoot!.querySelector('img')!.getAttribute('src')).toBe('data:image/svg+xml;base64,PHN2Zy8+')
    for (const icon of ['https://evil.example/track.png', 'javascript:alert(1)', 'data:text/html,<script>']) {
      const element = await mount('omni-wallet-option', { name: 'Evil', icon })
      expect(element.shadowRoot!.querySelector('img')).toBeNull()
      expect(element.shadowRoot!.querySelector('.fallback')!.textContent).toBe('E')
    }
  })

  it('fires omni-select unless disabled or busy', async () => {
    const element = await mount('omni-wallet-option', { name: 'Rabby' })
    const selected = vi.fn()
    document.addEventListener('omni-select', selected)
    element.shadowRoot!.querySelector('button')!.click()
    expect(selected).toHaveBeenCalledTimes(1)

    element.busy = true
    await element.updateComplete
    element.shadowRoot!.querySelector('button')!.click()
    expect(selected).toHaveBeenCalledTimes(1)
    expect(element.shadowRoot!.querySelector('.detail')!.textContent).toBe('Check your wallet…')
    document.removeEventListener('omni-select', selected)
    expect(OmniWalletOption).toBeDefined()
  })
})

describe('omni-qr', () => {
  it('draws the matrix as a single path on white', async () => {
    const element = await mount('omni-qr', { value: 'wc:abc@2?relay-protocol=irn&symKey=00', label: 'Pairing code' })
    const svg = element.shadowRoot!.querySelector('svg')!
    expect(svg.getAttribute('aria-label')).toBe('Pairing code')
    expect(svg.querySelectorAll('path')).toHaveLength(1)
    expect(svg.querySelector('rect')!.getAttribute('fill')).toBe('#fff')
  })
})
