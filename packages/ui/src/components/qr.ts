import { LitElement, css, html, svg } from 'lit'
import { encode } from 'uqr'

/**
 * `<omni-qr value="wc:…" label="…">`: the matrix as one SVG path. Always dark on white with a quiet
 * zone, whatever the theme: inverted or low-contrast codes fail on many phone cameras.
 */
export class OmniQr extends LitElement {
  static override properties = { value: {}, label: {} }
  declare value: string
  declare label: string

  constructor() {
    super()
    this.value = ''
    this.label = 'QR code'
  }

  static override styles = css`
    :host {
      display: block;
      max-width: 260px;
      margin: 0 auto;
    }
    svg {
      display: block;
      width: 100%;
      height: auto;
      border-radius: 8px;
    }
  `

  override render() {
    if (!this.value) return null
    const { data, size } = encode(this.value, { ecc: 'M', border: 2 })
    let path = ''
    data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) path += `M${x} ${y}h1v1h-1z`
      }),
    )
    return html`<svg viewBox="0 0 ${size} ${size}" role="img" aria-label=${this.label} shape-rendering="crispEdges">
      ${svg`<rect width=${size} height=${size} fill="#fff"></rect><path d=${path} fill="#000"></path>`}
    </svg>`
  }
}
