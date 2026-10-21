import { SiweClientError } from '@omnimarket/auth/client'
import { WalletError } from '@omnimarket/wallet-core'

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

/** Wallet, WalletConnect and sign-in errors in user language; shared by the Vue shell and the React app. */
export function describeError(error: unknown): string {
  if (error instanceof WalletError) return WALLET_MESSAGES[error.code] ?? error.message
  if (error instanceof SiweClientError) return SIWE_MESSAGES[error.code] ?? `Sign-in failed (${error.code}).`
  return error instanceof Error ? error.message : String(error)
}
