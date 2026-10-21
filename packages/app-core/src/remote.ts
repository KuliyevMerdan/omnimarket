import type { OmniCore } from './core'

/**
 * The contract between the shell (host) and the marketplace micro-frontend (remote). Kept
 * framework-free: the host never imports React, the remote never imports Vue. Bump `version` on a
 * breaking change; the host refuses a remote with another major version instead of half-working.
 */
export const MARKET_REMOTE_VERSION = 1

/** `inspect`: paste a request from another site and see what the security checks make of it. */
export type MarketPage = 'market' | 'mine' | 'inspect'

/**
 * Pages the remote renders per ecosystem, so the host can build its navigation without loading the
 * remote. Solana listings need an escrow program (out of scope): mint and transfer only.
 */
export const MARKET_PAGES: Readonly<Record<string, readonly MarketPage[]>> = {
  eip155: ['market', 'mine', 'inspect'],
  solana: ['mine'],
  sui: ['market', 'mine'],
}

export interface MarketMountProps {
  /** Shared instances: the remote must not create its own wallet manager or engines. */
  readonly core: OmniCore
  readonly page: MarketPage
}

export interface MarketMountHandle {
  update(props: MarketMountProps): void
  unmount(): void
}

export interface MarketRemote {
  readonly version: number
  mount(element: HTMLElement, props: MarketMountProps): MarketMountHandle
}
