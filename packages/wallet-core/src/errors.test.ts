import { UserRejectedRequestError } from 'viem'
import { describe, expect, it } from 'vitest'
import { WalletError, toWalletError } from './errors'

describe('toWalletError', () => {
  it('maps raw EIP-1193 errors by code', () => {
    expect(toWalletError({ code: 4001, message: 'nope' }).code).toBe('USER_REJECTED')
    expect(toWalletError({ code: -32002, message: 'pending' }).code).toBe('REQUEST_PENDING')
  })

  it('walks viem cause chains and keeps the short message', () => {
    const error = toWalletError(new UserRejectedRequestError(new Error('inner')))
    expect(error.code).toBe('USER_REJECTED')
    expect(error.message).not.toContain('\n')
  })

  it('finds MetaMask Mobile codes in data.originalError', () => {
    expect(toWalletError({ code: -32603, data: { originalError: { code: 4902 } } }).code).toBe('UNRECOGNIZED_CHAIN')
  })

  it('recognizes code-less rejections by message', () => {
    expect(toWalletError(new Error('User rejected the request')).code).toBe('USER_REJECTED')
    expect(toWalletError('boom').code).toBe('UNKNOWN')
  })

  it('passes WalletError through unchanged', () => {
    const original = new WalletError('NOT_CONNECTED', 'x')
    expect(toWalletError(original)).toBe(original)
  })
})
