# ADR 0006: Security checks as EIP-1193 middleware, reviewed in the host

- Status: accepted
- Date: 2026-10-22

## Context

Drainers rarely exploit a bug. Usually the user signs something they couldn't read. Unlimited approvals,
`setApprovalForAll`, gasless permits (EIP-2612, Permit2) and blind hashes look harmless in most wallets:
raw hex, or "Signature request" with a JSON tree. The app knows more than the wallet: which contracts are
ours, which chain the user is on, which domain they signed in to.

Where should the checks run?

- **In each feature** (the listing form checks its approval). Easy, but the next feature forgets. Paths
  that don't go through our forms, such as the SIWE client, a transaction from the tx engine or
  WalletConnect, are not covered.
- **In the tx engine.** Covers transactions only; typed data and messages go through the connector.
- **At the provider.** Every signing request of every EVM wallet ends up as one `provider.request` call:
  `eth_sendTransaction`, `eth_signTypedData_v4`, `personal_sign`, `eth_sign`, `wallet_sendCalls`.

## Decision

1. **`guardProvider(provider, options)`** wraps the EIP-1193 provider of every EVM connector: EIP-6963
   wallets, the legacy injected one, and the WalletConnect provider (`wrapProvider` in the EVM adapter and
   in `createWalletConnect`). It is a `Proxy`: only `request` is replaced, other properties and events pass
   through (bound to the original, for providers with private fields).
2. **Pure analyzers.** `inspectTransaction`, `inspectCalls`, `inspectTypedData`, `inspectMessage` return a
   `RiskReport`: decoded intent, findings with a level, formatted details. They do RPC reads only (code,
   ERC-165, token metadata), through a reader, never through the wallet. The same functions run on the
   "Check a request" page.
3. **Four levels.** `info` goes straight to the wallet. `warning` is reviewed. `danger` is reviewed and
   needs an explicit "I understand". `blocked` is never forwarded and fails with `WalletError('BLOCKED')`,
   which the tx engine records as `blocked`. A rejected review is `USER_REJECTED` (4001), like a rejection
   in the wallet.
4. **Decode by shape, trust by address.** Permits are recognized from their EIP-712 field types, not the
   `primaryType` name. ERC-20 vs ERC-721 `approve` (same selector) is decided by ERC-165. Names come only
   from contracts the app knows (`knownContract`: our deployments, canonical Permit2). Token symbols are
   untrusted: sanitized, marked unverified and always shown with the address.
5. **Fail closed.** If a request can't be analyzed (RPC down, malformed data), it gets a review with
   `INSPECTION_FAILED`, never a silent pass. Malformed typed data is blocked. If no UI is attached to the
   gate, the review is rejected.
6. **One review UI per page, owned by the host.** `ReviewGate` (framework-free store) queues reviews one at
   a time. `<omni-risk-review>` (Lit, in `@omnimarket/ui`) registers with it while mounted and renders a
   modal `<dialog>`. The standalone React app and the Vue shell each mount one. The remote doesn't: its
   transactions go through the same core, and a second dialog would answer the same review twice.

## Consequences

- Our own flows (listing approval for the verified market, order signatures, sign-in on our domain) are
  `info` and show no extra dialog. The review appears only for what deserves it.
- Up to four extra RPC reads per signing request, in parallel. That is negligible next to a wallet prompt.
- A dApp-side guard is defence in depth, not a replacement for the wallet's own checks. A compromised build
  can remove it, and it can't see where assets go inside an arbitrary contract call. Balance-diff
  simulation (Tenderly, Blockaid) is the next step, and so are Seaport orders and Solana/Sui instructions.
  See [the threat model](../threat-model.md).
- Wallets that already show rich previews (Rabby) produce a double check for warnings. That is acceptable
  for warnings; `info` requests never double up.
