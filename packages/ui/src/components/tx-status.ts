import { LitElement, css, html } from 'lit'
import { base } from './shared'

type Tone = 'neutral' | 'active' | 'ok' | 'warn' | 'error'

/** Mirrors `TxStatus` from @omnimarket/tx-engine, without depending on it. */
export const TX_STATUS: Readonly<Record<string, { label: string; tone: Tone }>> = {
  preparing: { label: 'Preparing', tone: 'neutral' },
  awaiting_signature: { label: 'Check your wallet', tone: 'active' },
  pending: { label: 'Pending', tone: 'active' },
  confirming: { label: 'Confirming', tone: 'active' },
  confirmed: { label: 'Confirmed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'error' },
  cancelled: { label: 'Cancelled', tone: 'warn' },
  replaced: { label: 'Replaced', tone: 'warn' },
}

/** `<omni-tx-status status="pending">`: a colored chip; the color is never the only signal (text). */
export class OmniTxStatus extends LitElement {
  static override properties = { status: { reflect: true } }
  declare status: string

  constructor() {
    super()
    this.status = 'pending'
  }

  static override styles = [
    base,
    css`
      :host {
        display: inline-block;
      }
      span {
        display: inline-flex;
        gap: 6px;
        align-items: center;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 12px;
        border: 1px solid currentColor;
      }
      span::before {
        content: '';
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: currentColor;
      }
      .neutral {
        color: var(--omni-color-muted, #8a93a6);
      }
      .active {
        color: var(--omni-color-accent, #6d8bff);
      }
      .active::before {
        animation: pulse 1.2s ease-in-out infinite;
      }
      .ok {
        color: var(--omni-color-ok, #4fd18b);
      }
      .warn {
        color: var(--omni-color-warn, #f2c14e);
      }
      .error {
        color: var(--omni-color-error, #ff6b6b);
      }
      @keyframes pulse {
        50% {
          opacity: 0.3;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .active::before {
          animation: none;
        }
      }
    `,
  ]

  override render() {
    const known = TX_STATUS[this.status]
    const { label, tone } = known ?? { label: String(this.status ?? ''), tone: 'neutral' as const }
    return html`<span class=${tone} part="chip">${label}</span>`
  }
}
