# OmniMarket

[![CI](https://github.com/KuliyevMerdan/omnimarket/actions/workflows/ci.yml/badge.svg)](https://github.com/KuliyevMerdan/omnimarket/actions/workflows/ci.yml)

A multi-chain NFT marketplace built on its own wallet SDK: one adapter layer over EVM, Solana and Sui,
with React and Vue bindings over the same framework-agnostic core.

> Status: **phase 6**. Three ecosystems run end to end on local nodes:
> - EVM: EIP-6963 wallets, gasless EIP-712 listings;
> - Solana: Wallet Standard, Metaplex Core;
> - Sui: Wallet Standard, Move package, Kiosk.
>
> Mobile wallets connect through WalletConnect v2: one QR scan gives a session across all three
> namespaces. One sign-in (SIWE / CAIP-122) and one transaction history cover all three.
>
> Two ways to run the frontend:
> - the React marketplace on its own, as an installable PWA;
> - a Vue 3 shell that hosts the marketplace as a Module Federation micro-frontend. Both bind to the
>   same core instances and share a Web Components UI library.
>
> Every EVM signature and transaction is decoded and checked before the wallet opens: unlimited
> approvals, `setApprovalForAll`, gasless permits (EIP-2612, DAI, Permit2), blind hashes, sign-ins for other
> domains. See the [threat model](docs/threat-model.md).

## Layout

```
packages/
  wallet-core/   framework-agnostic SDK: CAIP ids, WalletManager, store, error model
    src/adapters/evm/              EIP-6963 discovery, EIP-1193 connector (viem), chain add/switch
    src/adapters/wallet-standard/  shared discovery + connection lifecycle for Solana and Sui
    src/adapters/solana/           Solana connector (kit modifying signer, signMessage, signAndSend fallback)
    src/adapters/sui/              Sui connector (personal message, signTransaction, signAndExecute fallback)
    src/adapters/walletconnect/    WalletConnect v2: one session, EIP-1193 provider + Wallet Standard wallets over it
    src/testing/                   real-key mock wallets: EIP-1193, Solana and Sui Wallet Standard, WalletConnect
  auth/          SIWE (EIP-4361) + CAIP-122 for Solana/Sui: builder, strict parser, server verification, did:pkh
  guard/         signing firewall: decodes approvals, permits, Permit2, batches, messages into risk reports;
                 EIP-1193 middleware + review gate (ADR 0006)
  tx-engine/     one TxStore, three engines: EVM (nonce replacements, reorgs), Solana (blockhash expiry,
                 rebroadcast, commitment), Sui (digest-first, idempotent resubmit, checkpoints);
                 /solana and /sui are separate entry points, loaded lazily (lazyEngine)
  contracts/     Solidity (Foundry) + Move (omni_nft) + Metaplex Core/Kiosk helpers, safe metadata parsing
  react/         WalletProvider/TxEngineProvider/WalletConnectProvider, useAccount, useTransactions, useSiwe
  vue/           createOmniVue, useAccount/useWallets/useTransactions/useSiwe/useWalletConnect; Pinia stores (/pinia)
  ui/            Web Components (Lit): button, address, tx status, network badge, wallet option, QR, risk review;
                 tokens; Storybook
  app-core/      composition root shared by every frontend: chain config, RPC clients, createOmniCore(),
                 the guard wiring, the host/remote contract and the Module Federation share list (federation.ts);
                 /solana and /sui: chain clients + engines, loaded on demand
apps/
  api/           Hono: SIWE + session, signed order book
  market-react/  Vite + React 19 marketplace: mint, list (gasless), buy, activity, "Check a request"; PWA (pwa/:
                 service worker plugin); `--mode remote` builds it as a micro-frontend (src/remote.tsx);
                 windowed token grid, metadata worker, bundle budget (scripts/bundle-budget.mjs)
  shell-vue/     Vue 3 + Pinia + vue-router shell: connect, WalletConnect, account, sign-in, activity; hosts the marketplace
docs/adr/        architecture decisions
```

```mermaid
flowchart LR
  subgraph browser
    SHELL[Vue shell] -- mount core, page --> REMOTE[React marketplace remote]
    SHELL --> VB[vue bindings]
    REMOTE --> RB[react bindings]
    VB --> CORE[app-core: one core per page]
    RB --> CORE
    CORE --> M[WalletManager]
    M --> EVM[EVM adapter<br/>EIP-6963 + EIP-1193]
    EVM -. every signing request .-> GUARD[guard middleware<br/>review in the host]
    M --> WS[Wallet Standard registry]
    WS --> SOL[Solana connector]
    WS --> SUI[Sui connector]
    M --> WC[WalletConnect session]
    WC --> EVM
    WC --> SOL
    WC --> SUI
  end
  WC -. relay .-> PHONE[mobile wallet]
  CORE -- nonce / verify --> API[api: SIWE + session]
```

## Run

Requires Node ≥ 22, pnpm, [Foundry](https://getfoundry.sh), the Solana (Agave) and Sui CLIs:
`brew install foundry solana sui`.

```bash
pnpm install
git submodule update --init   # forge-std
pnpm dev:chain                # anvil :8545, 2 s blocks, state persisted to anvil-state.json
pnpm deploy:local             # forge build + generate ABIs + deploy → deployments/index.json
pnpm dev:solana               # solana-test-validator :8899 with Metaplex Core loaded from solana/mpl_core.so
pnpm dev:sui                  # Sui localnet :9000 (gRPC) + faucet :9123, fresh genesis each start
pnpm --filter @omnimarket/contracts deploy:sui   # publish omni_nft → deployments/sui.json (after every dev:sui)
pnpm dev                      # api :8787, web :5173 (proxied as /api)

pnpm test                     # TypeScript unit + integration (spawn their own anvil / validator / localnet)
pnpm --filter @omnimarket/market-react budget   # production build + startup JS budget (fails over 225 kB gzip)
pnpm test:sol                 # Solidity: forge tests incl. fuzzing, EIP-1271, reentrancy
(cd packages/contracts/move/omni_nft && sui move test)
pnpm typecheck
```

> The local Solana validator ledger grows by roughly 2 GB/h. It is reset on every start (`--reset`); stop
> it when idle. Tests use a temp ledger and delete it.

Browsers without wallet extensions (CI, the built-in preview) can register real-key mock wallets in dev:
`await (await import('/src/dev/mockWallets.ts')).installMockWallets()`.

WalletConnect needs a project id from [dashboard.reown.com](https://dashboard.reown.com): put
`VITE_WC_PROJECT_ID=…` in `apps/market-react/.env.local` (see `.env.example`). Without it the app hides the
WalletConnect option. In development, `localStorage.setItem('omni:wc-mock', '1')` replaces the relay with
an in-page mock wallet holding real keys (anvil account #3). The full QR → approve → sign → switch
ecosystem → reload → disconnect flow then works without a phone. `WC_PROJECT_ID=… pnpm test` also runs
one round trip through the real relay.

Vue shell with the marketplace as a micro-frontend (Module Federation):

```bash
pnpm --filter @omnimarket/market-react dev:remote   # remote, built + watched, served at :5181
pnpm --filter @omnimarket/shell-vue dev             # shell at :5180 (needs an API whose SIWE_ORIGIN is :5180)
PORT=8788 SIWE_ORIGIN=http://localhost:5180 pnpm --filter @omnimarket/api dev   # with OMNI_API_URL=http://localhost:8788 for the shell
pnpm --filter @omnimarket/ui storybook              # component library at :6006
```

`VITE_MARKET_REMOTE_URL` points the shell at a deployed remote. The service worker is registered in production builds only: `pnpm --filter @omnimarket/market-react build && … preview`.

Import an anvil dev account (keys are printed by `anvil`) into MetaMask/Rabby, using the network
`http://127.0.0.1:8545` with chain id 31337.

Testnets: `RPC_URL=… DEPLOYER_PRIVATE_KEY=… pnpm --filter @omnimarket/contracts deploy` adds Sepolia/Amoy addresses
to `deployments/index.json`. The app and API pick them up automatically.

API environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | |
| `SIWE_ORIGIN` | `http://localhost:5173` | Origin the SIWE `uri` must match; `https://` turns on `Secure` + `__Host-` cookies |
| `SIWE_DOMAIN` | host of `SIWE_ORIGIN` | Expected SIWE `domain` |
| `RPC_URL_<chainId>` | viem public RPC | Used only to verify smart-contract wallet signatures (EIP-1271 / 6492) |

## Security model (phase 1)

- **Discovery:** EIP-6963 announcements are untrusted. They are shape-checked, the first provider per rdns wins, and icons
  must be `data:image/*` and are rendered only via `<img>`.
- **Signing:** the SDK refuses to sign for accounts that aren't connected, and refuses EIP-712 data whose
  `domain.chainId` differs from the wallet chain (cross-chain replay). Wallet prompts are never auto-retried.
- **SIWE:** the server issues a single-use nonce with a TTL. Domain and origin come from config, never the `Host` header.
  The server also checks the chain allowlist, issuedAt/expiration/notBefore with clock skew, and checks the signature (local
  ecrecover, then EIP-1271/6492 over RPC). Only then is the nonce consumed, atomically, so a valid message works once
  and junk requests can't burn nonces.
- **Session:** opaque random id in an `HttpOnly; SameSite=Lax` cookie. The id rotates on every login (session fixation), JSON-only
  POST (CSRF), `Cache-Control: no-store`, secure headers. The client drops the session when the wallet switches account.

## Security model (phase 2)

- **Pre-flight simulation:** every write is simulated first, so users never sign a transaction that would revert. Custom errors
  are decoded against all known ABIs: an OpenZeppelin error raised by the NFT inside a market call still gets a readable
  message.
- **Approvals:** `setApprovalForAll` is requested only for the verified market deployment (`isTrustedOperator`). The UI states
  what it grants, and the approval can be revoked from the app.
- **Gasless listings can't be edited:** the old signature stays fillable until it is cancelled on-chain. Raising a price
  therefore cancels the old order first. `incrementNonce` voids every signature at once.
- **The order book is a cache, not a source of truth:** the API checks the signature (EOA + EIP-1271), the collection allowlist,
  deadline bounds and per-seller limits. Both API and client re-check every order against the chain in one deployless multicall
  (used / nonce / owner / approval) before showing "Buy".
- **NFT metadata is untrusted:** only `data:application/json` is parsed locally, images are restricted to `data:image/*`, `https:`
  and `ipfs://` (via a gateway), `animation_url` is ignored, and nothing is rendered as HTML.
- **Contracts:** checks-effects-interactions plus `nonReentrant` (tested with a reentrant buyer), `_safeMint` with effects first,
  and EIP-1271 sellers through `SignatureChecker`.

## Security model (phase 3)

- **Wallet Standard:** wallet registrations are untrusted like EIP-6963 announcements. Icons are sanitized, and only wallets with
  the namespace and the required feature set are listed. Accounts of other chains in multi-chain wallets are filtered out.
- **Signing exactly what was shown:** a Solana wallet that returns a signature over *different* bytes than requested
  (prefixing, rewriting) is rejected rather than forwarded.
- **Sign-in on every chain:** the same nonce, domain, origin, chain allowlist and time checks apply. Solana sign-in uses ed25519
  over the exact text. Sui verifies personal-message signatures with intent domain separation, so a transaction signature can't
  be replayed as a sign-in (tested). Multi-line statements are refused (field injection), and the parser rejects unknown or
  duplicate fields.
- **Kiosk:** purchases resolve the `TransferRequest` against the type's `TransferPolicy` inside the same programmable transaction.
  Listings found through events are re-checked against the current kiosk state.

## Security model (phase 4)

- **The WalletConnect session is untrusted input.** Only accounts on requested chains with valid addresses are
  kept, only requested methods are used, and namespaces that can't sign in plus transact are dropped. A
  session that grants nothing usable is closed. Proposals use `optionalNamespaces` only.
- **Verify what comes back over the relay.** Solana message signatures are checked with ed25519 (the protocol
  doesn't echo the signed bytes). A Sui wallet must return exactly the transaction bytes we built, with a
  signature that verifies for the sender. Anything else is refused, not submitted.
- **Reads never go to the phone.** Only signing methods cross the relay; chain id, simulation, gas and receipts
  use the RPC. Requests are checked locally against the approved chains and methods first.
- **Peer metadata is display-only.** The wallet's name is sanitized (control/bidi characters). Its redirect link
  is used only if it is a safe scheme (no `javascript:`, `data:`, `http:`). Remote peer icons are not loaded.
- **Session hygiene.** A cancelled QR dialog disconnects a late approval. Sessions close on the last disconnect,
  on `session_delete`/`session_expire`, and are not restored within a minute of expiry. Telemetry is off.
- **PWA.** The service worker caches only our hashed static files and the app shell. `/api`, RPC and the relay
  are never cached. A new version never takes over while a wallet prompt or a pairing is open.

## Micro-frontends (phase 5)

See [ADR 0005](docs/adr/0005-vue-shell-react-remote-shared-core.md).

- **One core per page.** The shell creates the wallet manager, engines, SIWE client and WalletConnect session.
  The React remote gets them through `mount(element, { core, page })` and never creates its own, so there is one
  connection, one QR scan and one Activity list across both frameworks.
- **Singletons by configuration.** `@omnimarket/*` (per entry point) and `viem` are shared singletons. At runtime
  every share is provided by the shell and loaded once. `instanceof` checks on connectors and `WalletError` work
  across bundles anyway (`Symbol.for` brands), in case a share is ever misconfigured.
- **Production builds.** Rolldown merges modules into chunks, so a chunk loaded for one share (viem) also ran
  another (app-core) before its dependencies were shared: both federated builds use strict execution order. The
  shell also dedupes `vue`/`pinia` (its TypeScript 6 pin gives them a second peer variant). Details in the ADR.
- **Failure isolation.** A versioned mount contract: the shell refuses an incompatible remote, and a remote that
  fails to load leaves the shell working, with a retry.
- **Style isolation.** Remote CSS is nested under `.omni-market` and lives in one ref-counted `<style>` that
  disappears with the last unmount.
- **One UI library, two frameworks.** Lit Web Components themed by CSS custom properties. They register once
  even if two bundles load them. Wallet icons are re-sanitized inside the component. Storybook runs with the a11y
  addon: no WCAG 2.1 A/AA violations reported by axe.

## Security model (phase 6)

See [the threat model](docs/threat-model.md) and [ADR 0006](docs/adr/0006-signing-guard-as-provider-middleware.md).

- **One checkpoint for every signature.** `@omnimarket/guard` wraps the EIP-1193 provider of every EVM wallet,
  extensions and WalletConnect alike. `eth_sendTransaction`, `wallet_sendCalls`, `eth_signTypedData_v4`,
  `personal_sign` and `eth_sign` are decoded before the wallet sees them. No feature can forget to call it.
- **What it catches.**
  - Unlimited ERC-20 allowances, and `setApprovalForAll` for an unknown operator.
  - Approvals to personal addresses, EIP-7702 delegated ones included (checked with `getCode`).
  - ERC-721 vs ERC-20 `approve` with the same selector (resolved with ERC-165).
  - EIP-2612, DAI and Permit2 permits, recognized by their EIP-712 shape: unlimited amounts, long or no
    expiry, a fake "Permit2" domain.
  - Approvals hidden in EIP-5792 batches, blind hashes, sign-ins for other domains, invisible characters.
- **Levels.** `info` passes, `warning` is reviewed, `danger` needs an explicit "I understand", and `blocked`
  (`eth_sign`, cross-chain typed data, malformed data) never reaches the wallet.
- **Fail closed.** If a request can't be analyzed, it goes to a review. If no review UI is mounted, it is
  rejected. The review UI is `<omni-risk-review>`, mounted once by the host: the standalone app or the shell.
- **Names come only from known contracts.** Token symbols are attacker-controlled, so they are sanitized,
  marked unverified and always shown with the address.
- **"Check a request"** runs the same analysis on anything pasted, without sending it to the wallet.

## Performance (phase 6)

- **Budget.** The JS a first visit must download (the entry and its static imports, gzip) is checked by
  `pnpm --filter @omnimarket/market-react budget` against 225 kB. Before phase 6 it was 304 kB; now it is 216 kB.
- **Chain SDKs on demand.** The Solana and Sui engines and clients are separate entry points
  (`@omnimarket/tx-engine/solana|sui`, `@omnimarket/app-core/solana|sui`). `core.solana` and `core.sui` are
  `lazyEngine`s. They load when a wallet of that ecosystem connects, or after a reload when the history still
  has pending transactions of that chain. The React hooks suspend until then. The Solana transaction codecs in
  the connectors load with the first transaction. In the shell, nothing from @mysten/sui or the Solana RPC
  stack is fetched for an EVM user, in the production build too (checked in the browser with `vite build` +
  `vite preview`). Module Federation preloads shares at init, so this takes two settings in
  `app-core/federation.ts`: `tx-engine/solana|sui` are not share keys (they live in the lazy
  `app-core/solana|sui` chunk), and the remote consumes `app-core/solana|sui` with `import: false`, which leaves
  a share reached only through `import()` to that import. An EVM visit to the shell went from 57 JS files
  (509 kB gzip) to 47 (407 kB).
- **Windowed grid.** Above 60 tokens only the rows near the viewport are rendered. Row heights are measured,
  rows are found by binary search over offsets, and the page itself scrolls, so it works the same in the
  shell.
- **Metadata on demand.** Each card asks for its own metadata. Requests within a frame are batched into one
  multicall and cached. A 10 000-token wallet fetches a few dozen URIs for the first screen instead of
  10 000.
- **Worker.** Batches of 24+ token URIs are decoded and sanitized in a module worker. As a micro-frontend the
  remote's chunks are cross-origin to the page, and `new Worker(url)` throws a `SecurityError` there. The worker
  is then started from a same-origin blob that `import`s it, with a main-thread fallback.
- **RPC fallback.** EVM uses viem's `fallback` transport (private RPC first). Solana gets the same with a
  failover transport that moves on only for transport errors, never for JSON-RPC errors.

## Transaction lifecycle

See [ADR 0002](docs/adr/0002-transaction-lifecycle.md) (EVM) and [ADR 0003](docs/adr/0003-wallet-standard-and-chain-lifecycles.md)
(Solana, Sui). WalletConnect: [ADR 0004](docs/adr/0004-walletconnect-one-session-many-namespaces.md).

| | EVM | Solana | Sui |
|---|---|---|---|
| Pre-flight | `simulateContract`, custom errors from all ABIs | `simulateTransaction` (errors + compute units) | build dry-run + simulate, Move clever errors |
| Fees | wallet decides; ×1.125 bump on replace | CU limit = measured ×1.1, priority fee = median recent | gas budget from dry-run |
| Validity | nonce | blockhash until `lastValidBlockHeight` | owned object versions |
| Resend | speed-up/cancel (same nonce) | rebroadcast every 2 s, `maxRetries: 0` | re-execute same signed bytes (idempotent) |
| Done when | N confirmations, reorg → pending | `confirmed`/`finalized`, fork drop → pending | effects → checkpoint |
| Terminal failures | reverted (reason by replay), dropped, replaced | expired (safe to retry), program error by name | Move abort with constant name, dropped |

EVM details:

- **States:** `preparing → awaiting_signature → pending → confirming → confirmed`, or `failed` (simulation / rejected /
  reverted with a decoded reason / dropped), `cancelled`, `replaced`.
- **Same-nonce attempts:** speed-up and cancel add attempts to one record. A speed-up done in the wallet's own UI (unknown hash)
  is found by binary-searching the account nonce over blocks and classified as repriced, cancelled or replaced.
- **Reorgs:** a receipt that disappears sends the record back to `pending`. N confirmations are configurable.
- **Weak networks:** RPC fallback transport, exponential backoff on polling errors, an immediate re-poll on `online` and
  tab-visible, and a `syncError` flag in the UI.
- **Reloads:** records are persisted and resumed. Prompts open during a reload are marked `interrupted`.

## Roadmap

| Phase | Scope |
|---|---|
| 1 ✅ | wallet-core, EVM adapter, SIWE, React bindings |
| 2 ✅ | tx-engine, OmniNFT + OmniMarket (EIP-712 orders), order book API, marketplace UI |
| 3 ✅ | Wallet Standard adapters for Solana and Sui, CAIP-122 sign-in, Solana/Sui tx engines, Metaplex Core, Move package + Kiosk |
| 4 ✅ | WalletConnect v2: one session across eip155/solana/sui namespaces, mobile deep links, PWA |
| 5 ✅ | Vue 3 shell + Pinia bindings, Module Federation with the React app as a remote, UI library + Storybook |
| 6 ✅ | Performance budget (lazy chain SDKs, virtualized grids, workers, RPC fallback), approval/permit warnings, threat model |

Production bundle (gzip JS): **125 kB** after phase 1, **174 kB** after phase 2. After phase 3 the main chunk is **93 kB**:
the Solana page with Metaplex Core (55 kB) and the Sui modules with Kiosk (~22 kB) load only when a wallet of that ecosystem
connects. Phase 6 moved the remaining chain SDKs (engines, clients, adapter codecs) behind `import()` too.

Phase 4 JS loaded at startup went from 260 kB to 281 kB gzip (main chunk 96 kB), including the whole WalletConnect
integration and the PWA. The WalletConnect SignClient (106 kB) is loaded only when someone connects through it, or
restores such a session. Sui signature verification (31 kB) and the QR encoder (4 kB) load on first use.

Known limitations:
- Solana has mint and transfer but no listings: a Core marketplace needs an escrow program.
- The Kiosk SDK's listing-price decoding is wrong on the gRPC transport, so prices come from `ItemListed` events.
- WalletConnect is tested against an in-process wallet and, with a project id, the real relay, but not yet against
  physical phones. Real wallets won't approve local chains (anvil, `solana:localnet`, `sui:localnet`): use Sepolia,
  Solana devnet and Sui testnet. Solana and especially Sui support over WalletConnect varies by wallet (the Sui RPC spec
  is still marked as under review).
- On iOS, coming back to the browser after approving in the wallet is up to the wallet (`redirect` metadata); some
  require a manual switch.
- The guard decodes EVM requests only and can't see where assets go inside an arbitrary contract call (no
  balance-diff simulation). Seaport orders and Solana/Sui instructions are not decoded yet.
