import type { OmniCore } from '@omnimarket/app-core'
import { TxEngineProvider, WalletConnectProvider, WalletProvider } from '@omnimarket/react'
import type { ReactNode } from 'react'

/** Binds React to an existing core; never creates one (the host may own it). */
export function Providers({ core, children }: { core: OmniCore; children: ReactNode }) {
  return (
    <WalletProvider manager={core.manager}>
      <WalletConnectProvider session={core.walletConnect?.session ?? null}>
        <TxEngineProvider engine={core.evm} solana={core.solana} sui={core.sui}>
          {children}
        </TxEngineProvider>
      </WalletConnectProvider>
    </WalletProvider>
  )
}
