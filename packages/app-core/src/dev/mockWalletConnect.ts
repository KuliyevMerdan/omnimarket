/**
 * Dev-only WalletConnect "phone": a mock wallet on the other side of an in-page relay, with real keys.
 * Enabled by `localStorage.setItem('omni:wc-mock', '1')` (see `src/walletconnect.ts`). The wallet
 * approves every proposal after a short delay so the QR dialog can be seen; `window.__omniMockWc`
 * exposes its controls (reject, deleteSession, emitEvent…) for E2E runs.
 */
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { createBrowserStorage } from '@omnimarket/wallet-core'
import { createMockWalletConnect } from '@omnimarket/wallet-core/testing'
import type { WalletConnectClient } from '@omnimarket/wallet-core/walletconnect'

/** Anvil's 4th default dev account: a public key, local chain only. */
const ANVIL_KEY = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'

export async function createMockClient(): Promise<WalletConnectClient> {
  const storage = createBrowserStorage()
  const persisted = (key: string, create: () => string) => {
    const existing = storage.getItem(key)
    if (existing) return existing
    const value = create()
    storage.setItem(key, value)
    return value
  }
  const solanaSeed = persisted('omni:mock-wc:solana', () => toHex(crypto.getRandomValues(new Uint8Array(32))))
  const suiKey = persisted('omni:mock-wc:sui', () => new Ed25519Keypair().getSecretKey())

  const wallet = await createMockWalletConnect({
    name: 'Mock Mobile Wallet',
    evm: { privateKey: ANVIL_KEY, chainIds: [31337, 11155111], rpcUrl: 'http://127.0.0.1:8545' },
    solana: { privateKey: fromHex(solanaSeed), chains: ['solana:localnet'], rpcUrl: 'http://127.0.0.1:8899' },
    sui: {
      keypair: Ed25519Keypair.fromSecretKey(suiKey),
      chains: ['sui:localnet'],
      client: new SuiGrpcClient({ baseUrl: 'http://127.0.0.1:9000', network: 'localnet' }),
    },
    autoApproveMs: 2500,
    storage,
  })
  ;(window as unknown as { __omniMockWc: typeof wallet }).__omniMockWc = wallet
  return wallet.createClient()
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16))
