# ADR 0001: Own wallet adapter layer on CAIP identifiers

- Status: accepted
- Date: 2026-10-21

## Context

The product must support EVM (Ethereum, Polygon), Solana and Sui wallets: injected, mobile and WalletConnect v2.
It must also serve both a React and a Vue application. Off-the-shelf kits (RainbowKit/wagmi, Solana wallet-adapter,
Sui dapp-kit, Reown AppKit) each cover one ecosystem or one framework. Combining them gives three state models, three
error models and three ideas of "the connected account".

## Decision

1. **A framework-agnostic core** (`@omnimarket/wallet-core`) owns all state in one immutable store exposing
   `getState` / `subscribe`. React binds through `useSyncExternalStore` (tear-free in concurrent rendering). Vue will
   bind through `shallowRef` + subscription. Bindings contain no logic.
2. **CAIP-2 / CAIP-10 everywhere** (`eip155:1`, `eip155:1:0xabc…`). Account ids are unambiguous across chains, map
   1:1 to WalletConnect v2 namespaces, and give us `did:pkh` for free.
3. **Discovery is a standard, not a list.** EVM uses EIP-6963. Solana and Sui both use Wallet Standard, so phase 3
   shares one discovery mechanism for the two. We don't hardcode wallets; `window.ethereum` is only a fallback.
4. **Small common interface, rich concrete connectors.** `WalletConnector` has only what every chain has
   (connect, disconnect, signMessage, switchChain, events). Chain-specific features (EIP-712, transactions) live on
   the concrete class (`Eip1193Connector`), reached with a type guard (`isEvmConnector`). A lowest-common-denominator
   API would hide what users actually sign.
5. **One normalized error model** (`WalletError` codes mapped from EIP-1193 / viem / message heuristics), so the UI
   handles "user rejected" the same way on every chain.
6. **Concurrency rules in the manager:** an attempt counter discards stale connect results, and start/stop is
   ref-counted (StrictMode). Silent reconnect has a timeout, so a slow or missing extension never leaves the UI stuck.

## Consequences

- More code to own than a kit, but every behaviour is testable with the real-key mock wallet, without a browser.
- WalletConnect becomes "just another connector" (its provider is EIP-1193 for eip155), not a parallel system.
- Adding a chain = one adapter + one connector; the bindings and UI don't change.
