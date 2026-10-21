import { LitElement, css, html } from 'lit'
import { base } from './shared'

/**
 * `<omni-button variant="primary|secondary|ghost" size="md|sm" busy disabled>`. An action button: it is
 * not form-associated, so don't rely on it to submit forms.
 */
export class OmniButton extends LitElement {
  static override properties = {
    variant: { reflect: true },
    size: { reflect: true },
    disabled: { type: Boolean, reflect: true },
    busy: { type: Boolean, reflect: true },
  }

  declare variant: 'primary' | 'secondary' | 'ghost'
  declare size: 'md' | 'sm'
  declare disabled: boolean
  declare busy: boolean

  constructor() {
    super()
    this.variant = 'primary'
    this.size = 'md'
    this.disabled = false
    this.busy = false
  }

  static override styles = [
    base,
    css`
      :host {
        display: inline-block;
      }
      button {
        display: inline-flex;
        gap: 8px;
        align-items: center;
        justify-content: center;
        width: 100%;
        font: inherit;
        font-weight: 600;
        padding: 10px 14px;
        border-radius: var(--omni-radius-sm, 8px);
        border: 1px solid transparent;
        background: var(--omni-color-accent, #6d8bff);
        color: var(--omni-color-accent-text, #0d0f14);
        cursor: pointer;
      }
      :host([size='sm']) button {
        padding: 6px 10px;
        font-size: 13px;
      }
      :host([variant='secondary']) button {
        background: transparent;
        color: var(--omni-color-text, #e7eaf0);
        border-color: var(--omni-color-border, #262c38);
      }
      :host([variant='ghost']) button {
        background: transparent;
        color: var(--omni-color-accent, #6d8bff);
      }
      button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      :host([busy]) button {
        cursor: progress;
      }
      .spinner {
        width: 1em;
        height: 1em;
        border: 2px solid currentColor;
        border-right-color: transparent;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .spinner {
          animation: none;
        }
      }
    `,
  ]

  override render() {
    return html`<button part="button" ?disabled=${this.disabled || this.busy} aria-busy=${this.busy ? 'true' : 'false'}>
      ${this.busy ? html`<span class="spinner" aria-hidden="true"></span>` : null}<slot></slot>
    </button>`
  }
}
