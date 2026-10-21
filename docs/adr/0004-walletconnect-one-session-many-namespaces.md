# ADR 0004: WalletConnect v2 as connectors over one multi-namespace session

- Status: accepted
- Date: 2026-10-22

## Context

Phase 4 adds mobile wallets. On the web that means WalletConnect v2: a relay between the dApp and a
wallet app, paired with a QR code (desktop) or a deep link (mobile browser). One WalletConnect
session can cover several CAIP-2 namespaces at once, so a single approval can give EVM, Solana and Sui
accounts.

The usual options are Reown AppKit (UI kit, modal, its own state), the `@walletconnect/ethereum-provider`
(EVM only) or the Solana/Sui adapters of each ecosystem's kit. Each one brings its own state model,
next to the one ADR 0001 established.

## Decision

1. **Only `@walletconnect/sign-client`, behind an interface.** `WalletConnectSession` talks to a
   `WalletConnectClient` (connect, request, disconnect, events). The real client is loaded with a
   dynamic `import()` on first use, so the SDK (106 kB gzip) never weighs on the initial bundle. Tests
   and the dev mock implement the same interface.
2. **One session, one connector per namespace.** `createWalletConnect()` returns the session plus one
   `ChainAdapter` per configured namespace. Each connector is an existing class:
   - EVM: `Eip1193Connector` over our own EIP-1193 provider (`createWalletConnectEip1193Provider`);
   - Solana / Sui: `SolanaConnector` / `SuiConnector` over a Wallet Standard `Wallet` object backed by
     the session.
   The WalletManager, the tx engines, SIWE and the UI don't know a phone is involved. Connectors
   `attach` to the session and `detach` when the app disconnects them. The session ends when the
   last one detaches, so switching from EVM to Solana keeps it, and "Disconnect" ends it.
3. **Everything in `optionalNamespaces`.** A wallet that can't satisfy a *required* namespace must
   reject the whole proposal, so an EVM-only wallet could never connect to a multi-chain dApp. We
   decide after approval what is usable.
4. **The settled session is untrusted input.** `parseApprovedNamespaces` keeps only accounts on chains
   we requested, with valid addresses (checksummed EVM, base58 Solana, normalized Sui). It keeps only
   methods we asked for, and only namespaces that can sign in and transact. A session with nothing
   usable is closed immediately.
5. **Reads never cross the relay.** The EVM provider sends only wallet methods (`personal_sign`,
   `eth_signTypedData_v4`, `eth_sendTransaction`, chain switch/add) to the phone. `eth_chainId`, gas
   estimation, simulation and receipts go to the public RPC. Switching between chains the wallet
   approved is local.
6. **Verify what comes back.**
   - Solana `solana_signMessage` returns only a signature, so we check it with ed25519 against the
     message we sent. Signatures in returned transactions are checked as well.
   - Sui `sui_signTransaction` returns `transactionBytes`, which must equal the bytes we built, and the
     signature is verified against the sender.
   - Wallets that sign something else are refused, never submitted.
7. **Mobile specifics.**
   - Curated universal links (no explorer API call, no remote icons).
   - The peer's `redirect` is only used when it is a safe scheme, to bring the wallet to the front
     after a request.
   - The relay socket is restarted when a backgrounded tab becomes visible again.
   - Proposals are cancellable: a late approval of a cancelled proposal is disconnected.
   - Sessions about to expire are not restored, and stale ones are closed.
8. **PWA without Workbox.** A small build plugin emits a ~70-line `sw.js`:
   - precache only the app shell (entry chunk and its static imports);
   - cache hashed `/assets/*` first, use the network first for navigations;
   - never cache `/api`, RPC or the relay.
   Updates wait for the user and are deferred while a wallet prompt or a pairing is open.

## Consequences

- WalletConnect support reuses all of phase 1–3: chain switching, EIP-712 replay checks, the tx
  lifecycles and CAIP-122 sign-in work over the relay unchanged (tested on anvil through the engine).
- Sui over WalletConnect needs the dApp to build BCS bytes (the protocol has no transaction JSON), so
  the Sui WalletConnect wallet takes a `getClient` option.
- Without a WalletConnect project id the app simply hides the option. In development
  `localStorage['omni:wc-mock'] = '1'` swaps the relay for an in-page wallet with real keys, so the
  whole flow (QR → approve → sign → switch ecosystem → reload → disconnect) is testable without a phone.
- One relay round trip is tested only when `WC_PROJECT_ID` is set (two real SignClients). The rest
  runs against the mock in CI.
