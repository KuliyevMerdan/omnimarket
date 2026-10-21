import { LitElement, css, html } from 'lit'
import { base } from './shared'

/** `<omni-network-badge name="Sepolia" state="ok|warn|error">`. */
export class OmniNetworkBadge extends LitElement {
  static override properties = { name: {}, state: { reflect: true } }
  declare name: string
  declare state: 'ok' | 'warn' | 'error'

  constructor() {
    super()
    this.name = ''
    this.state = 'ok'
  }

  static override styles = [
    base,
    css`
      :host {
        display: inline-flex;
        gap: 6px;
        align-items: center;
        padding: 4px 10px;
        border-radius: 999px;
        border: 1px solid var(--omni-color-border, #262c38);
        font-size: 13px;
      }
      i {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--omni-color-ok, #4fd18b);
      }
      :host([state='warn']) i {
        background: var(--omni-color-warn, #f2c14e);
      }
      :host([state='error']) i {
        background: var(--omni-color-error, #ff6b6b);
      }
      .sr {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
      }
    `,
  ]

  override render() {
    const description = this.state === 'ok' ? '' : this.state === 'warn' ? ' (unsupported)' : ' (unavailable)'
    return html`<i aria-hidden="true"></i><span>${this.name}<span class="sr">${description}</span></span>`
  }
}
