import { hasBrand } from './brand'
export type WalletErrorCode =
  | 'USER_REJECTED'
  | 'UNAUTHORIZED'
  | 'UNSUPPORTED_METHOD'
  | 'DISCONNECTED'
  | 'CHAIN_DISCONNECTED'
  | 'UNRECOGNIZED_CHAIN'
  | 'REQUEST_PENDING'
  | 'WALLET_NOT_FOUND'
  | 'NOT_CONNECTED'
  | 'ACCOUNT_MISMATCH'
  | 'CHAIN_MISMATCH'
  | 'TIMEOUT'
  | 'UNKNOWN'

/** EIP-1193 / EIP-1474 provider error codes mapped to our codes. */
const RPC_CODES: Readonly<Record<number, WalletErrorCode>> = {
  4001: 'USER_REJECTED',
  4100: 'UNAUTHORIZED',
  4200: 'UNSUPPORTED_METHOD',
  4900: 'DISCONNECTED',
  4901: 'CHAIN_DISCONNECTED',
  4902: 'UNRECOGNIZED_CHAIN',
  [-32002]: 'REQUEST_PENDING',
  // WalletConnect SDK error codes (wallets answer with these over the relay).
  5000: 'USER_REJECTED',
  5001: 'USER_REJECTED', // chains
  5002: 'USER_REJECTED', // methods
  5003: 'USER_REJECTED', // events
  5100: 'UNRECOGNIZED_CHAIN',
  5101: 'UNSUPPORTED_METHOD',
  5102: 'UNSUPPORTED_METHOD', // events
  5103: 'UNAUTHORIZED', // accounts
  5104: 'UNSUPPORTED_METHOD', // namespace key
  6000: 'DISCONNECTED',
}

// Non-EVM wallets often reject without a numeric code.
const USER_REJECTED_MESSAGE = /user (rejected|denied|cancel)|rejected by (the )?user/i

const WALLET_ERROR_BRAND: unique symbol = Symbol.for('omnimarket.WalletError')

export class WalletError extends Error {
  /** Cross-bundle `instanceof`, see brand.ts. */
  readonly [WALLET_ERROR_BRAND] = true
  static override [Symbol.hasInstance](value: unknown): boolean {
    return hasBrand(value, WALLET_ERROR_BRAND)
  }

  override readonly name = 'WalletError'
  readonly code: WalletErrorCode
  readonly rpcCode: number | undefined

  constructor(code: WalletErrorCode, message: string, options: { cause?: unknown; rpcCode?: number } = {}) {
    super(message, { cause: options.cause })
    this.code = code
    this.rpcCode = options.rpcCode
  }
}

/**
 * Normalizes anything a wallet or viem may throw into a `WalletError`.
 * Walks `cause` (viem wraps RPC errors) and `data.originalError` (MetaMask Mobile).
 */
export function toWalletError(error: unknown): WalletError {
  if (error instanceof WalletError) return error

  let current: unknown = error
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'number' && RPC_CODES[code]) {
      return new WalletError(RPC_CODES[code], messageOf(error), { cause: error, rpcCode: code })
    }
    const data = (current as { data?: { originalError?: unknown } }).data
    current = (current as { cause?: unknown }).cause ?? data?.originalError
  }

  const message = messageOf(error)
  const code = USER_REJECTED_MESSAGE.test(message) ? 'USER_REJECTED' : 'UNKNOWN'
  return new WalletError(code, message, { cause: error })
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    // viem errors carry a multi-line message with docs links; the short one is enough for UI.
    return (error as { shortMessage?: string }).shortMessage ?? error.message
  }
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  return String(error)
}
