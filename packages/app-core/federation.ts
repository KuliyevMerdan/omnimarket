/**
 * Module Federation settings shared by the host (Vue shell) and the remote (React marketplace).
 * Build-time only (imported by vite.config files).
 *
 * Every package with module-level state must be a singleton, or the host and the remote would each
 * get their own: two RPC client caches, two program-error registries, two "current" WalletConnect
 * sessions. Workspace packages are listed per entry point because each subpath is its own share key.
 */
const workspace = { singleton: true, requiredVersion: '^0.1.0' } as const

export const OMNI_SHARED = {
  '@omnimarket/app-core': workspace,
  '@omnimarket/auth': workspace,
  '@omnimarket/auth/client': workspace,
  '@omnimarket/contracts': workspace,
  '@omnimarket/tx-engine': workspace,
  '@omnimarket/ui': workspace,
  '@omnimarket/wallet-core': workspace,
  '@omnimarket/wallet-core/evm': workspace,
  '@omnimarket/wallet-core/solana': workspace,
  '@omnimarket/wallet-core/sui': workspace,
  '@omnimarket/wallet-core/wallet-standard': workspace,
  '@omnimarket/wallet-core/walletconnect': workspace,
  viem: { singleton: true, requiredVersion: '^2.57.0' },
}

export const MARKET_REMOTE = {
  name: 'market',
  /** `import('market/market')` in the host. */
  expose: './market',
  /** Where the host finds the remote; override per environment with `VITE_MARKET_REMOTE_URL`. */
  defaultEntry: 'http://localhost:5181/remoteEntry.js',
} as const
