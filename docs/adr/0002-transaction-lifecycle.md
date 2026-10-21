# ADR 0002: Own transaction tracker instead of `waitForTransactionReceipt`

- Status: accepted
- Date: 2026-10-21

## Context

A marketplace needs more than "await the receipt". It has to:
- survive page reloads with transactions still pending;
- follow speed-ups and cancels, both ours and ones made in the wallet's own UI;
- notice reorgs, stuck and dropped transactions;
- explain failures in user language;
- keep working on flaky mobile connections.

viem's `waitForTransactionReceipt` detects replacements only in blocks it observes while waiting. It needs the original
transaction to be fetchable at least once and follows a single hash. After a reload, a replacement that was mined
while the tab was closed would never be found.

## Decision

1. **One record per nonce, many attempts.** A record (`TxRecord`, plain JSON) holds every broadcast for its nonce:
   `original`, `speedup` and `cancel`. Each poll checks the receipts of all attempts, newest first.
2. **Nonce as the source of truth.** If the account's mined nonce has passed ours and no attempt has a receipt, a
   foreign transaction took the nonce. We binary-search `getTransactionCount(blockNumber)` to find the block, fetch that
   transaction and classify it:
   - same to/value/data → `repriced` (a wallet-side speed-up, adopted as an attempt);
   - a 0-value self-transfer → `cancelled`;
   - anything else → `replaced`.
3. **A pure poll step.** `pollRecord(ctx, record) → patch` does only RPC reads. The engine owns the state, persistence and
   scheduling. Per-chain polling is serialized (a promise queue) and backs off exponentially on errors. It also re-polls on
   `online` and on `visibilitychange`.
4. **Simulate before signing.** `simulateContract` first, then `estimateGas` with a 20% buffer, then the chain switch, then
   the wallet prompt. Fees are left to the wallet.
5. **Revert reasons from post-state replay.** Receipts carry no reason, so the call is replayed on the block's post-state.
   The usual cause (someone filled the order first, the deadline passed) is visible only there.
6. **Replacement is opt-in per wallet.** MetaMask ignores a dApp-supplied `nonce`, so an in-app "speed up" would send a
   second, independent transaction. `canReplace(wallet)` gates the buttons. Other wallets use their own speed-up, which
   (2) detects. After any app-side replacement we check the sent nonce; if it differs, the transaction becomes a separate
   record and the user is told.

## Consequences

- Speed-up, cancel, wallet-side replacement, unrelated replacement, drop, reorg, N confirmations, resume-after-reload and
  revert-reason decoding are covered by integration tests against a real anvil with manual mining
  (`packages/tx-engine/test`).
- The binary search needs historical state (`eth_getTransactionCount` at a block). On pruned nodes it fails, and the record
  falls back to `replaced` without a hash.
- Solana (blockhash expiry) and Sui (effects, gas objects) get their own trackers behind the same `TxRecord` / `TxStatus`
  surface in phase 3.
