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
  '@omnimarket/app-core/solana': workspace,
  '@omnimarket/app-core/sui': workspace,
  '@omnimarket/auth': workspace,
  '@omnimarket/auth/client': workspace,
  '@omnimarket/contracts': workspace,
  '@omnimarket/guard': workspace,
  '@omnimarket/tx-engine': workspace,
  '@omnimarket/tx-engine/solana': workspace,
  '@omnimarket/tx-engine/sui': workspace,
  '@omnimarket/ui': workspace,
  '@omnimarket/wallet-core': workspace,
  '@omnimarket/wallet-core/evm': workspace,
  '@omnimarket/wallet-core/solana': workspace,
  '@omnimarket/wallet-core/sui': workspace,
  '@omnimarket/wallet-core/wallet-standard': workspace,
  '@omnimarket/wallet-core/walletconnect': workspace,
  viem: { singleton: true, requiredVersion: '^2.57.0' },
}

/**
 * Rolldown output options for every federated production build (host and remote).
 *
 * Host init loads the shared providers in dependency order (viem, then wallet-core/*, ..., then
 * app-core), and providers that other shared packages consume read their dependencies synchronously at
 * module evaluation (`SOLANA_NETWORKS = [SOLANA_DEVNET]`). Rolldown merges modules into chunks by
 * reachability, so the chunk that provides viem also held app-core: loading viem evaluated app-core
 * before wallet-core/solana was in the share cache. Strict execution order wraps each module in a lazy
 * initializer, so a chunk runs only the modules that were actually imported, in source order
 * (+4% JS, ~25 kB gzip for the shell).
 */
export const FEDERATED_OUTPUT = { strictExecutionOrder: true } as const

export const MARKET_REMOTE = {
  name: 'market',
  /** `import('market/market')` in the host. */
  expose: './market',
  /** Where the host finds the remote; override per environment with `VITE_MARKET_REMOTE_URL`. */
  defaultEntry: 'http://localhost:5181/remoteEntry.js',
} as const
