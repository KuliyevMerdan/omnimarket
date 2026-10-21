import { LitElement, css, html, nothing, type PropertyValues } from 'lit'
import { base } from './shared'

type Level = 'info' | 'warning' | 'danger' | 'blocked'

/** Mirrors `RiskReport` / `ReviewGate` from @omnimarket/guard, without depending on it. */
export interface RiskReviewReport {
  readonly level: Level
  readonly summary: string
  readonly findings: readonly { readonly level: Level; readonly title: string; readonly detail?: string }[]
  readonly details: readonly { readonly label: string; readonly value: string; readonly address?: string }[]
}

export interface RiskReviewSource {
  getState(): { readonly current: { readonly id: number; readonly report: RiskReviewReport } | null; readonly queued: number }
  subscribe(listener: () => void): () => void
  resolve(id: number, accepted: boolean): void
  attach(): () => void
}

const LEVELS: Record<Level, { label: string; tone: string }> = {
  info: { label: 'Check', tone: 'info' },
  warning: { label: 'Review', tone: 'warn' },
  danger: { label: 'Danger', tone: 'error' },
  blocked: { label: 'Blocked', tone: 'error' },
}

/**
 * `<omni-risk-review .gate=${gate}>`: the security review that opens *before* the wallet does. Mount it
 * once per page (in the host when there is one). While mounted it registers with the gate; without it,
 * reviews are rejected. A modal `<dialog>`: focus moves in, Escape rejects, the page behind is inert.
 * Dangerous requests need an explicit "I understand" before they can continue.
 */
export class OmniRiskReview extends LitElement {
  static override properties = {
    gate: { attribute: false },
    acknowledged: { state: true },
    tick: { state: true },
  }

  declare gate: RiskReviewSource | undefined
  declare acknowledged: boolean
  declare tick: number
  #release: (() => void) | null = null
  #shownId: number | null = null

  constructor() {
    super()
    this.acknowledged = false
    this.tick = 0
  }

  override connectedCallback(): void {
    super.connectedCallback()
    this.#bind()
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    this.#unbind()
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('gate') && this.isConnected) this.#bind()
  }

  protected override updated(): void {
    const dialog = this.renderRoot.querySelector('dialog')
    const current = this.gate?.getState().current
    if (!dialog) return
    if (current && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal()
      else dialog.setAttribute('open', '')
    } else if (!current && dialog.open) {
      dialog.close()
    }
  }

  static override styles = [
    base,
    css`
      dialog {
        width: min(480px, calc(100vw - 32px));
        max-height: calc(100vh - 32px);
        padding: 0;
        border: 1px solid var(--omni-color-border, #262c38);
        border-radius: var(--omni-radius, 12px);
        background: var(--omni-color-surface, #161a22);
        color: inherit;
      }
      dialog::backdrop {
        background: rgb(0 0 0 / 0.6);
      }
      .body {
        padding: 20px;
        display: grid;
        gap: 14px;
      }
      header {
        display: grid;
        gap: 6px;
      }
      h2 {
        margin: 0;
        font-size: 17px;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }
      .chip {
        justify-self: start;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
        border: 1px solid currentColor;
      }
      .muted {
        color: var(--omni-color-muted, #8a93a6);
        font-size: 13px;
        margin: 0;
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 8px;
      }
      li {
        padding: 10px 12px;
        border-radius: var(--omni-radius-sm, 8px);
        border-left: 3px solid currentColor;
        background: color-mix(in srgb, currentColor 8%, transparent);
      }
      li b {
        display: block;
        color: var(--omni-color-text, #e7eaf0);
        font-size: 14px;
      }
      li span {
        display: block;
        margin-top: 2px;
        color: var(--omni-color-muted, #8a93a6);
        font-size: 13px;
      }
      .info {
        color: var(--omni-color-accent, #6d8bff);
      }
      .warn {
        color: var(--omni-color-warn, #f2c14e);
      }
      .error {
        color: var(--omni-color-error, #ff6b6b);
      }
      dl {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 6px 12px;
        margin: 0;
        font-size: 13px;
      }
      dt {
        color: var(--omni-color-muted, #8a93a6);
      }
      dd {
        margin: 0;
        overflow-wrap: anywhere;
      }
      label {
        display: flex;
        gap: 8px;
        align-items: flex-start;
        font-size: 14px;
      }
      footer {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        flex-wrap: wrap;
        padding: 14px 20px;
        border-top: 1px solid var(--omni-color-border, #262c38);
      }
    `,
  ]

  override render() {
    const current = this.gate?.getState().current
    if (!current) return html`<dialog aria-label="Security review"></dialog>`
    const { report } = current
    const level = LEVELS[report.level] ?? LEVELS.warning
    const danger = report.level === 'danger'
    const queued = this.gate!.getState().queued

    return html`<dialog aria-labelledby="summary" aria-describedby="findings" @cancel=${this.#onCancel}>
      <div class="body">
        <header>
          <span class="chip ${level.tone}">${level.label}</span>
          <h2 id="summary">${report.summary}</h2>
          <p class="muted">Checked by OmniMarket before your wallet opens.${queued ? ` ${queued} more waiting.` : ''}</p>
        </header>
        ${report.findings.length
          ? html`<ul id="findings">
              ${report.findings.map(
                (f) => html`<li class=${LEVELS[f.level]?.tone ?? 'info'}>
                  <b>${f.title}</b>${f.detail ? html`<span>${f.detail}</span>` : nothing}
                </li>`,
              )}
            </ul>`
          : nothing}
        ${report.details.length
          ? html`<dl>
              ${report.details.map(
                (d) =>
                  html`<dt>${d.label}</dt>
                    <dd>${d.address && d.value === d.address ? html`<omni-address .value=${d.address} chars="6"></omni-address>` : d.value}</dd>`,
              )}
            </dl>`
          : nothing}
        ${danger
          ? html`<label>
              <input type="checkbox" .checked=${this.acknowledged} @change=${this.#onAcknowledge} />
              I understand the risk and want to continue.
            </label>`
          : nothing}
      </div>
      <footer>
        <omni-button variant="secondary" autofocus @click=${() => this.#answer(false)}>Reject</omni-button>
        <omni-button variant=${danger ? 'secondary' : 'primary'} ?disabled=${danger && !this.acknowledged} @click=${() => this.#answer(true)}>
          Continue to wallet
        </omni-button>
      </footer>
    </dialog>`
  }

  #bind(): void {
    this.#unbind()
    const gate = this.gate
    if (!gate) return
    const detach = gate.attach()
    const unsubscribe = gate.subscribe(() => this.#sync())
    this.#release = () => {
      unsubscribe()
      detach()
    }
    this.#sync()
  }

  #unbind(): void {
    this.#release?.()
    this.#release = null
  }

  #sync(): void {
    const id = this.gate?.getState().current?.id ?? null
    // A new review starts unacknowledged: consent never carries over to the next request.
    if (id !== this.#shownId) this.acknowledged = false
    this.#shownId = id
    this.tick++
  }

  #answer(accepted: boolean): void {
    const current = this.gate?.getState().current
    if (!current) return
    if (accepted && current.report.level === 'danger' && !this.acknowledged) return
    this.gate!.resolve(current.id, accepted)
  }

  #onAcknowledge = (event: Event): void => {
    this.acknowledged = (event.target as HTMLInputElement).checked
  }

  #onCancel = (event: Event): void => {
    // Escape: reject instead of just hiding the dialog with the request still pending.
    event.preventDefault()
    this.#answer(false)
  }
}
