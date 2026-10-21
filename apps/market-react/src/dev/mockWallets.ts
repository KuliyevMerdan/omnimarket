/**
 * Dev-only: registers real-key mock wallets on the Wallet Standard window protocol, for E2E runs in
 * browsers without extensions. Not imported by the app, so it never reaches a production bundle.
 *
 *   const { installMockWallets } = await import('/src/dev/mockWallets.ts')
 *   await installMockWallets()
 */
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { createMockSolanaWallet, createMockSuiWallet, registerInBrowser } from '@omnimarket/wallet-core/testing'

export async function installMockWallets(options: { solanaName?: string; suiName?: string } = {}) {
  const solana = await createMockSolanaWallet({ name: options.solanaName ?? 'Phantom (test)', rpcUrl: 'http://127.0.0.1:8899', chains: ['solana:localnet'] })
  const sui = createMockSuiWallet({
    name: options.suiName ?? 'Slush (test)',
    client: new SuiGrpcClient({ baseUrl: 'http://127.0.0.1:9000', network: 'localnet' }),
    chains: ['sui:localnet'],
  })
  await registerInBrowser(solana.wallet)
  await registerInBrowser(sui.wallet)
  return { solana: solana.signer.address, sui: sui.address }
}
