/**
 * JSX types for the OmniMarket custom elements in React 19 (which passes props to custom elements as
 * properties). Add `import type {} from '@omnimarket/ui/react'` once, e.g. in the app's entry.
 */
import type { DetailedHTMLProps, HTMLAttributes } from 'react'
import type { RiskReviewSource } from './components/risk-review'

type Element<Props> = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & Props

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'omni-button': Element<{ variant?: 'primary' | 'secondary' | 'ghost'; size?: 'md' | 'sm'; disabled?: boolean; busy?: boolean }>
      'omni-address': Element<{ value?: string; chars?: number }>
      'omni-tx-status': Element<{ status?: string }>
      'omni-network-badge': Element<{ name?: string; state?: 'ok' | 'warn' | 'error' }>
      'omni-wallet-option': Element<{ name?: string; icon?: string; detail?: string; busy?: boolean; disabled?: boolean }>
      'omni-qr': Element<{ value?: string; label?: string }>
      'omni-risk-review': Element<{ gate?: RiskReviewSource }>
    }
  }
}
