import { LitElement, css, html } from 'lit'
import { base } from './shared'

/** `0x52908400…69ee7` → `0x5290…9ee7`; keeps the `0x` prefix out of the visible character count. */
export function shortenAddress(value: string, chars = 4): string {
  const prefix = value.startsWith('0x') ? '0x' : ''
  const body = value.slice(prefix.length)
  if (body.length <= chars * 2 + 1) return value
  return `${prefix}${body.slice(0, chars)}…${body.slice(-chars)}`
}

/**
 * `<omni-address value="0x…" chars="4">`: a shortened address with the full value in the tooltip and a
 * copy button. Fires `omni-copy` (detail: `{ value }`) after a successful copy.
 */
export class OmniAddress extends LitElement {
  static override properties = {
    value: {},
    chars: { type: Number },
    copied: { state: true },
  }

  declare value: string
  declare chars: number
  declare copied: boolean
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor() {
    super()
    this.value = ''
    this.chars = 4
    this.copied = false
  }

  static override styles = [
    base,
    css`
      :host {
        display: inline-flex;
        gap: 6px;
        align-items: center;
        font-family: var(--omni-font-mono, ui-monospace, monospace);
        font-size: 0.9em;
      }
      button {
        font: inherit;
        font-size: 0.85em;
        padding: 2px 6px;
        border-radius: 6px;
        border: 1px solid var(--omni-color-border, #262c38);
        background: transparent;
        color: var(--omni-color-muted, #8a93a6);
        cursor: pointer;
      }
    `,
  ]

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    clearTimeout(this.#timer)
  }

  async #copy() {
    try {
      await navigator.clipboard.writeText(this.value)
    } catch {
      return
    }
    this.copied = true
    this.dispatchEvent(new CustomEvent('omni-copy', { detail: { value: this.value }, bubbles: true, composed: true }))
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => (this.copied = false), 1500)
  }

  override render() {
    if (!this.value) return null
    return html`<span title=${this.value}>${shortenAddress(this.value, this.chars)}</span>
      <button type="button" aria-label="Copy address" @click=${this.#copy}>${this.copied ? 'Copied' : 'Copy'}</button>`
  }
}
