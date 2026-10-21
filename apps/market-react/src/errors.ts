import { SiweClientError } from '@omnimarket/auth/client'
import type { TxErrorInfo } from '@omnimarket/tx-engine'
import { WalletError } from '@omnimarket/wallet-core'
import { ApiError } from './lib/orders'

const WALLET_MESSAGES: Partial<Record<WalletError['code'], string>> = {
  USER_REJECTED: 'You rejected the request in your wallet.',
  REQUEST_PENDING: 'Your wallet already has a pending request. Open the wallet to finish it.',
  UNRECOGNIZED_CHAIN: 'This network is not available in your wallet.',
  CHAIN_MISMATCH: 'The data you are signing is for another network. Switch networks first.',
  ACCOUNT_MISMATCH: 'The selected account is not connected.',
  NOT_CONNECTED: 'Connect a wallet first.',
  TIMEOUT: 'Your wallet did not answer in time. Open the wallet app and try again.',
  DISCONNECTED: 'The wallet ended the session.',
  UNSUPPORTED_METHOD: 'Your wallet does not support this action here.',
}

const SIWE_MESSAGES: Record<string, string> = {
  NONCE_INVALID: 'The sign-in request expired. Try again.',
  EXPIRED: 'The sign-in request expired. Try again.',
  DOMAIN_MISMATCH: 'The sign-in message was created for another website.',
  INVALID_SIGNATURE: 'The signature could not be verified.',
  CHAIN_NOT_ALLOWED: 'Sign-in is not available on this network.',
}

/** Custom errors from OmniMarket, OmniNFT and OpenZeppelin, in user language. */
const CONTRACT_ERRORS: Record<string, string> = {
  OrderExpired: 'This listing has expired.',
  OrderUnavailable: 'Someone bought this NFT first, or the seller cancelled the listing.',
  InvalidNonce: 'The seller cancelled all their listings.',
  IncorrectPayment: 'The payment does not match the listing price.',
  InvalidSignature: 'The listing signature is not valid.',
  NotSeller: 'Only the seller can cancel this listing.',
  PaymentFailed: 'The seller could not receive the payment.',
  MintAmountInvalid: 'You can mint 1 to 5 tokens at a time.',
  ERC721InsufficientApproval: 'The seller revoked the market’s access to this NFT.',
  ERC721IncorrectOwner: 'The seller no longer owns this NFT.',
  ERC721NonexistentToken: 'This token does not exist.',
  // Metaplex Core
  NoApprovals: 'You are not allowed to transfer this asset (are you still its owner?).',
  InvalidAuthority: 'You are not allowed to change this asset.',
}

const TX_KINDS: Partial<Record<TxErrorInfo['kind'], string>> = {
  user_rejected: 'You rejected the transaction in your wallet.',
  insufficient_funds: 'Not enough funds for the price plus gas.',
  chain_mismatch: 'Your wallet is on another network.',
  nonce: 'Your wallet’s nonce is out of sync. Reset the account in your wallet’s settings.',
  network: 'Network problem while sending. Check your connection and try again.',
  dropped: 'The network dropped this transaction. Nothing was executed, no gas was spent.',
  expired: 'The transaction expired before it was included. Nothing was executed; it is safe to try again.',
  interrupted: 'The page was closed before the wallet confirmed.',
}

export function describeTxError(error: TxErrorInfo): string {
  if (error.errorName && CONTRACT_ERRORS[error.errorName]) return CONTRACT_ERRORS[error.errorName]!
  if (TX_KINDS[error.kind]) return TX_KINDS[error.kind]!
  // Sui clever errors carry the contract's own message; prefer it to a generic text.
  if (error.kind === 'simulation_reverted') return `The transaction would fail: ${error.message}`
  if (error.kind === 'reverted') return `The transaction failed on-chain${error.errorName ? ` (${error.errorName})` : ''}.`
  return error.message
}

export function describeError(error: unknown): string {
  if (error instanceof WalletError) return WALLET_MESSAGES[error.code] ?? error.message
  if (error instanceof SiweClientError) return SIWE_MESSAGES[error.code] ?? `Sign-in failed (${error.code}).`
  if (error instanceof ApiError) return error.message
  return error instanceof Error ? error.message : String(error)
}
