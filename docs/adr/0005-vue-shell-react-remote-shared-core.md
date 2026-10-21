# ADR 0005: Vue shell, React marketplace remote, one shared core

- Status: accepted
- Date: 2026-10-22

## Context

Phase 5 has to show the same wallet SDK driving two frameworks on one page: a Vue 3 shell and the
existing React marketplace, composed as micro-frontends. In a naive setup each micro-frontend brings
its own wallet layer, which breaks things:
- two EIP-6963 listeners;
- two "connected accounts" that drift apart;
- two WalletConnect sessions (two QR scans);
- two transaction histories.

## Decision

1. **One composition root, framework-free.**
   - `@omnimarket/app-core` holds the chain config, RPC clients and `createOmniCore()`. The core is
     the WalletManager, the three tx engines over one TxStore, the SIWE client and the WalletConnect
     session.
   - The shell creates the core once and passes it to the remote. The remote never creates its own.
   - The React app keeps a standalone entry that creates its own core (the PWA from phase 4).
2. **The remote contract is a mount API, not a component.**
   - `MarketRemote` = `{ version, mount(element, { core, page }) → { update, unmount } }`. It is
     typed in app-core, so the host never imports React and the remote never imports Vue.
   - The host checks the major `version` and refuses an incompatible remote.
   - A remote that fails to load leaves the shell working, with a retry.
   - `MARKET_PAGES` lets the host build its navigation without loading the remote.
3. **Module Federation (`@module-federation/vite`) with explicit singletons.**
   - Every package with module-level state is a singleton share: `@omnimarket/*` per entry point,
     and `viem`. Examples of such state: RPC client caches and the Solana program-error registry.
   - The list lives in one file (`app-core/federation.ts`) imported by both Vite configs.
   - Verified at runtime: every share is provided by the shell and loaded once.
4. **Cross-bundle `instanceof`.**
   - Connector classes and `WalletError` carry a `Symbol.for` brand and route `instanceof` through
     `Symbol.hasInstance`.
   - Type guards keep working even if a misconfigured share duplicates wallet-core.
5. **Style isolation for the remote.**
   - The React CSS is nested under `.omni-market`, so it can't restyle the shell's buttons.
   - It is injected by `mount()` as one ref-counted `<style>` and removed on the last `unmount()`.
   - Colors come from shared design tokens.
6. **A UI library as Web Components** (`@omnimarket/ui`, Lit).
   - The same `<omni-tx-status>`, `<omni-address>`, `<omni-wallet-option>` and `<omni-qr>` render in
     Vue templates and React 19 JSX (typed via `@omnimarket/ui/react`).
   - Custom properties carry the theme through shadow DOM.
   - `defineOnce` avoids the "name already defined" crash when two bundles register the elements.
   - Storybook (web-components-vite) runs with the a11y addon. axe found no WCAG 2.1 A/AA violations
     in any story.
   - Wallet icons are re-sanitized inside the component (only `data:image/*`).
7. **Vue bindings mirror the React ones** (`@omnimarket/vue`).
   - `shallowRef` + store subscription per scope: snapshots are immutable, so there is no deep
     reactivity and one trigger per change.
   - Composables: `useAccount`, `useWallets`, `useTransactions`, `useSiwe`, `useWalletConnect`.
   - The Pinia stores (`defineWalletStore`, `defineTxStore`) hold **no state of their own**: only
     getters over the manager's snapshots and delegating actions, so there is a single source of
     truth.
   - `createOmniVue` starts the manager and engines with the app and stops them on unmount. Starts
     are ref-counted, so the React remote starting them again is harmless.

## Consequences

- Connect, WalletConnect, account, sign-in and Activity are Vue; Market and My NFTs are React. A
  transaction sent from the React remote appears immediately in the Vue Activity list: same TxStore.
- The remote is served built (`pnpm --filter @omnimarket/market-react dev:remote` = build --watch +
  preview). React Fast Refresh needs its runtime in the host page, and the host is Vue. React work
  happens in the standalone app with HMR.
- An ES module that failed to *evaluate* stays failed for the page (module map cache), so "Retry"
  helps with network errors only; a broken deploy needs a reload.
- `vue-tsc` needs the TypeScript JS API, which TypeScript 7 no longer ships: the shell pins
  `typescript@6` locally for type checking. The rest of the monorepo stays on 7.
- Production builds needed two fixes that development (Vite's dep optimizer, no chunking) hides:
  - **Chunk merging vs. share init order.** The host's init loads shares in dependency waves (viem,
    then wallet-core/*, …, app-core last). Workspace singletons that other shares consume (app-core,
    wallet-core) are evaluated synchronously from the local copy, and they read their dependencies at
    module evaluation (`DEFAULT_CHAINS` uses `SOLANA_DEVNET`). Rolldown had put viem's provider into
    the same chunk as app-core, so loading viem in the first wave ran app-core while the
    wallet-core/solana share was still pending (`reading 'caip'` of undefined). Both federated builds
    now set `strictExecutionOrder` (`FEDERATED_OUTPUT` in `app-core/federation.ts`): each module
    runs when it is imported, wherever rolldown places it. Cost: about +4% JS (~25 kB gzip) in the
    shell. Splitting chunks per share by hand was the alternative; it breaks whenever a new
    dependency lands in a shared chunk.
  - **Duplicate Vue and Pinia.** The TypeScript 6 pin makes pnpm install a second peer variant of
    `vue` and `pinia` for the shell, so `@omnimarket/vue` bundled its own Pinia (another
    `piniaSymbol`, no active pinia: `reading '_s'`). The shell's Vite config sets
    `resolve.dedupe: ['vue', 'pinia']`.
