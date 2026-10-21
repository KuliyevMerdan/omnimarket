/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

/** The React marketplace, exposed by apps/market-react in `--mode remote` (see MarketRemote). */
declare module 'market/market' {
  import type { MarketRemote } from '@omnimarket/app-core'
  export const version: MarketRemote['version']
  export const mount: MarketRemote['mount']
}
