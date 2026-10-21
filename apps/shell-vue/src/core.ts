import { createOmniCore } from '@omnimarket/app-core'

/**
 * The page's only core. The React marketplace (remote) receives it through `mount()` and binds to
 * these instances: one wallet connection, one WalletConnect session, one transaction history.
 */
export const core = createOmniCore()
