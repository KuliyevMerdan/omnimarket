/**
 * Module Federation settings shared by the host (Vue shell) and the remote (React marketplace).
 * Build-time only (imported by vite.config files).
 *
 * Every package with module-level state must be a singleton, or the host and the remote would each
 * get their own: two RPC client caches, two program-error registries, two "current" WalletConnect
 * sessions. Workspace packages are listed per entry point because each subpath is its own share key.
 *
 * `@omnimarket/tx-engine/solana|sui` are not share keys: only `@omnimarket/app-core/solana|sui` import
 * them, and they hold no module state, so they live in the lazy chunk of that singleton. As share keys they
 * loaded at startup: a host seeds every share its graph imports, even behind `import()`, and a share left
 * out of that seed binds its exports asynchronously, after the lazy chunk that imports it has run.
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

/**
 * The remote's share config. The chain entry points are consume-only (`import: false`): the shell is
 * their only provider anyway, and a consume-only share that the remote reaches only through `import()`
 * (the Solana and Sui pages) is left out of the remote's init and loaded by that import. With a local
 * fallback the remote's init would seed them from the shell's provider when the marketplace mounts.
 */
const consumeOnly = { ...workspace, import: false } as const

export const MARKET_REMOTE_SHARED = {
  ...OMNI_SHARED,
  '@omnimarket/app-core/solana': consumeOnly,
  '@omnimarket/app-core/sui': consumeOnly,
}

export const MARKET_REMOTE = {
  name: 'market',
  /** `import('market/market')` in the host. */
  expose: './market',
  /** Where the host finds the remote; override per environment with `VITE_MARKET_REMOTE_URL`. */
  defaultEntry: 'http://localhost:5181/remoteEntry.js',
} as const
