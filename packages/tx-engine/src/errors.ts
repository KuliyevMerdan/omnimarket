import { toWalletError } from '@omnimarket/wallet-core'
import {
  BaseError,
  ChainMismatchError,
  ContractFunctionRevertedError,
  HttpRequestError,
  InsufficientFundsError,
  NonceTooHighError,
  NonceTooLowError,
  TimeoutError,
  UserRejectedRequestError,
  decodeErrorResult,
  type Abi,
  type Hex,
} from 'viem'
import { toSerializable } from './serialize'
import type { TxErrorInfo } from './types'

/**
 * Maps anything thrown while preparing, signing or sending into a stable, serializable shape.
 * Custom errors are decoded against every known ABI: a revert raised by the NFT contract inside
 * a market call carries the NFT's error selector, which the market ABI alone can't decode.
 */
export function decodeTxError(error: unknown, abis: readonly Abi[] = []): TxErrorInfo {
  const message = shortMessage(error)

  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError) {
      const decoded =
        reverted.data ?? (reverted.raw ? decodeWithAbis(reverted.raw, abis) : undefined)
      const errorName = decoded?.errorName
      const errorArgs = decoded?.args ? (toSerializable([...decoded.args]) as unknown[]).map(String) : undefined
      return {
        kind: 'simulation_reverted',
        message: reverted.reason ?? (errorName ? `${errorName}` : message),
        ...(errorName && errorName !== 'Error' ? { errorName } : {}),
        ...(errorArgs ? { errorArgs } : {}),
      }
    }
    if (error.walk((e) => e instanceof UserRejectedRequestError)) return { kind: 'user_rejected', message }
    if (error.walk((e) => e instanceof InsufficientFundsError)) return { kind: 'insufficient_funds', message }
    if (error.walk((e) => e instanceof ChainMismatchError)) return { kind: 'chain_mismatch', message }
    if (error.walk((e) => e instanceof NonceTooLowError || e instanceof NonceTooHighError)) {
      return { kind: 'nonce', message }
    }
    if (error.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError)) {
      return { kind: 'network', message }
    }
  }

  const walletError = toWalletError(error)
  if (walletError.code === 'USER_REJECTED') return { kind: 'user_rejected', message: walletError.message }
  if (walletError.code === 'BLOCKED') return { kind: 'blocked', message: walletError.message }
  if (walletError.code === 'CHAIN_MISMATCH' || walletError.code === 'UNRECOGNIZED_CHAIN') {
    return { kind: 'chain_mismatch', message }
  }
  return { kind: 'unknown', message }
}

export function decodeWithAbis(data: Hex, abis: readonly Abi[]) {
  for (const abi of abis) {
    try {
      return decodeErrorResult({ abi, data })
    } catch {
      // try the next ABI
    }
  }
  return undefined
}

function shortMessage(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage
  if (error instanceof Error) return error.message
  return String(error)
}
