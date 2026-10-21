import { LitElement, css, html } from 'lit'
import { base } from './shared'

const SAFE_ICON = /^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i

/**
 * `<omni-wallet-option name icon detail busy disabled>`: one wallet in a picker. Fires `omni-select`.
 * Wallet icons come from untrusted extensions: only `data:image/*` is rendered, and only through
 * `<img>` (where SVG cannot run script), even if the caller forgot to sanitize.
 */
export class OmniWalletOption extends LitElement {
  static override properties = {
    name: {},
    icon: {},
    detail: {},
    busy: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
  }

  declare name: string
  declare icon: string
  declare detail: string
  declare busy: boolean
  declare disabled: boolean

  constructor() {
    super()
    this.name = ''
    this.icon = ''
    this.detail = ''
    this.busy = false
    this.disabled = false
  }

  static override styles = [
    base,
    css`
      :host {
        display: block;
      }
      button {
        display: grid;
        grid-template-columns: 28px 1fr auto;
        gap: 12px;
        align-items: center;
        width: 100%;
        padding: 10px 14px;
        font: inherit;
        text-align: left;
        color: inherit;
        background: var(--omni-color-bg, #0d0f14);
        border: 1px solid var(--omni-color-border, #262c38);
        border-radius: var(--omni-radius-sm, 8px);
        cursor: pointer;
      }
      button:hover:not(:disabled) {
        border-color: var(--omni-color-accent, #6d8bff);
      }
      button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      img,
      .fallback {
        width: 28px;
        height: 28px;
        border-radius: 6px;
      }
      .fallback {
        display: grid;
        place-items: center;
        background: var(--omni-color-border, #262c38);
      }
      .detail {
        color: var(--omni-color-muted, #8a93a6);
        font-size: 13px;
      }
    `,
  ]

  #select() {
    if (this.disabled || this.busy) return
    this.dispatchEvent(new CustomEvent('omni-select', { bubbles: true, composed: true }))
  }

  override render() {
    const icon = SAFE_ICON.test(this.icon)
      ? html`<img src=${this.icon} alt="" width="28" height="28" />`
      : html`<span class="fallback" aria-hidden="true">${this.name.slice(0, 1)}</span>`
    return html`<button part="button" ?disabled=${this.disabled} aria-busy=${this.busy ? 'true' : 'false'} @click=${this.#select}>
      ${icon}<span>${this.name}</span><span class="detail">${this.busy ? 'Check your wallet…' : this.detail}</span>
    </button>`
  }
}
