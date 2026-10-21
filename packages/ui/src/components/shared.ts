import { css } from 'lit'

/** Base for every element: tokens with fallbacks, so an element still looks right without tokens.css. */
export const base = css`
  :host {
    font-family: var(--omni-font, system-ui, sans-serif);
    color: var(--omni-color-text, #e7eaf0);
    box-sizing: border-box;
  }
  *,
  *::before,
  *::after {
    box-sizing: inherit;
  }
  :focus-visible {
    outline: 2px solid var(--omni-color-accent, #6d8bff);
    outline-offset: 2px;
  }
`
