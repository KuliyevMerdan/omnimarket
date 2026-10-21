import { createSiweClient } from '@omnimarket/auth/client'
import { omniMarketAbi, omniNftAbi } from '@omnimarket/contracts'
import { TxEngineProvider, WalletProvider } from '@omnimarket/react'
import { SolanaTxEngine, SuiTxEngine, TxEngine, TxStore } from '@omnimarket/tx-engine'
import { WalletManager } from '@omnimarket/wallet-core'
import { createEvmAdapter } from '@omnimarket/wallet-core/evm'
import { createSolanaAdapter } from '@omnimarket/wallet-core/solana'
import { createSuiAdapter } from '@omnimarket/wallet-core/sui'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { SUPPORTED_CHAINS } from './chains'
import { getPublicClient, getSolanaRpc, getSuiClient, solanaProgramErrorName } from './clients'
import { SOLANA_NETWORKS, SUI_NETWORKS } from './networks'
import './styles.css'

// Created once, outside React: the wallet and tx layers must not depend on component lifecycles.
// EIP-6963 for EVM; Solana and Sui share the Wallet Standard registry.
const manager = new WalletManager({
  adapters: [
    createEvmAdapter({ chains: SUPPORTED_CHAINS }),
    createSolanaAdapter({ chains: SOLANA_NETWORKS }),
    createSuiAdapter({ chains: SUI_NETWORKS }),
  ],
})
const siwe = createSiweClient({ baseUrl: '/api', statement: 'Sign in to OmniMarket.' })

// One persisted history for all three lifecycles.
const store = new TxStore()
const evm = new TxEngine({
  store,
  getPublicClient,
  abis: [omniMarketAbi, omniNftAbi],
  stuckAfterMs: (chainId) => (chainId === 31337 ? 20_000 : 3 * 60_000),
  // Only wallets known to honour a dApp-supplied nonce get in-app speed-up/cancel.
  // Everyone else uses the wallet's own button; the tracker follows the replacement.
  canReplace: (wallet) => wallet.rdns?.startsWith('dev.omnimarket') ?? false,
})
const solana = new SolanaTxEngine({ store, getRpc: getSolanaRpc, programErrors: solanaProgramErrorName })
const sui = new SuiTxEngine({ store, getClient: getSuiClient })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WalletProvider manager={manager}>
      <TxEngineProvider engine={evm} solana={solana} sui={sui}>
        <App siwe={siwe} />
      </TxEngineProvider>
    </WalletProvider>
  </StrictMode>,
)
