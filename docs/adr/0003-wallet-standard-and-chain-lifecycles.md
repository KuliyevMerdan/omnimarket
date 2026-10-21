# ADR 0003: Wallet Standard for Solana and Sui, one store with per-chain lifecycles

- Status: accepted
- Date: 2026-10-22

## Context

Phase 3 adds Solana and Sui to the EVM-only wallet layer and transaction engine. The two ecosystems
differ from EVM, and from each other, in exactly the places a marketplace cares about:

| | EVM | Solana | Sui |
|---|---|---|---|
| Wallet discovery | EIP-6963 | Wallet Standard | Wallet Standard |
| Chain switching | wallet request | chain is a parameter of each signing call | same |
| Transaction validity | nonce | recent blockhash (~60–90 s) | owned object versions |
| Finality signal | confirmations | commitment level | effects, then checkpoint |
| Errors | ABI custom errors | `InstructionError [i, Custom(n)]` | Move abort + clever error |

## Decision

1. **One Wallet Standard adapter, two connectors.** `createWalletStandardAdapter` handles
   discovery (the `wallet-standard` window protocol), feature-set filtering and connector caching.
   `WalletStandardConnector` handles connect, disconnect, events, account filtering and app-side
   chain selection. `SolanaConnector` and `SuiConnector` add only their signing features. Adding
   another Wallet Standard chain (Aptos, Bitcoin) means writing one connector.
2. **The Solana wallet is a kit *modifying* signer.** Wallets may add instructions (priority fees,
   guards), which invalidates earlier signatures, so kit runs the wallet first and partial
   signers after it (e.g. the new Core asset keypair).
3. **App-side submission where the wallet allows it.** We prefer `signTransaction` over
   `signAndSend*`. On Solana that lets us rebroadcast with `maxRetries: 0` until the blockhash
   expires. On Sui we know the digest before submitting and can re-execute the same signed bytes
   (execution is idempotent). Wallets that only offer sign-and-send still work, tracked by
   signature or digest.
4. **One `TxStore`, three engines.** The engines share persistence, terminal-state waiters and a
   polling scheduler (serialized rounds per chain, backoff, wake on focus/online). Each owns its
   lifecycle. Records are a discriminated union (`namespace`) with a common base, so the UI has
   one Activity list.
5. **Sign-in is CAIP-122 everywhere.** Ethereum keeps exact EIP-4361 (wallets render it). Solana
   and Sui use the same layout. One strict parser and one set of checks: domain, origin, chain
   allowlist, times, single-use nonce. The signature scheme is the only per-chain part.
6. **Metaplex Core through Umi as an encoder only.** `mpl-core` ships Umi builders, so Umi encodes
   instructions and they are converted to kit instructions. The app keeps one Solana stack (kit)
   for RPC and signing. Assets are read via `getProgramAccounts`, so no DAS indexer is needed.
7. **Sui trading through Kiosk, not a custom market contract.** The Move package only provides a
   `TransferPolicy`. Purchases resolve the `TransferRequest` in the same programmable
   transaction. `mint_one` returns the object (composable), so "mint and list" is one signature.

## Consequences

- Tested against real nodes:
  - Solana: `solana-test-validator` with the actual Metaplex Core program — mint, owner lookup,
    transfer, and Core error names from simulation.
  - Sui: localnet — publish, mint, clever errors, list, sell, mint-and-list in one PTB, framework
    aborts, and a lost execute response resubmitted to exactly one execution.
  - Blockhash expiry, rebroadcast and fork drops are deterministic unit tests against a fake RPC.
- Sui 1.82 local nodes are gRPC-only, so the app uses `SuiGrpcClient` (gRPC-web) and normalized
  type strings in filters.
- Solana listings would need an escrow program; they are left out rather than faked.
