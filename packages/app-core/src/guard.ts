import { getDeployment } from '@omnimarket/contracts'
import { createReviewGate, guardProvider, type GuardOptions, type KnownContract, type ReviewGate } from '@omnimarket/guard'
import type { ProviderWrapper } from '@omnimarket/wallet-core/evm'
import { isAddressEqual, type Address } from 'viem'
import { findChain } from './chains'
import { getPublicClient } from './clients'

/** Our own deployments, by name. Everything else is "unknown" to the guard, however it calls itself. */
export function knownContract(chainId: number, address: Address): KnownContract | undefined {
  const deployment = getDeployment(chainId)
  if (!deployment) return undefined
  if (isAddressEqual(address, deployment.OmniMarket)) return { name: 'OmniMarket' }
  if (isAddressEqual(address, deployment.OmniNFT)) return { name: 'Omni Genesis' }
  return undefined
}

/** Options shared by the wallet middleware and the "Check a request" page. */
export function guardOptions(gate: ReviewGate): GuardOptions {
  return {
    review: gate.review,
    getClient: (chainId) => (findChain(chainId) ? getPublicClient(chainId) : undefined),
    known: knownContract,
    domain: typeof location === 'undefined' ? undefined : location.host,
    nativeSymbol: (chainId) => findChain(chainId)?.nativeCurrency.symbol,
  }
}

/**
 * One gate per page; every EVM provider (extensions and WalletConnect) goes through the same
 * middleware, so there is no signing path that skips the review.
 */
export function createAppGuard(): { gate: ReviewGate; wrapProvider: ProviderWrapper } {
  const gate = createReviewGate()
  const options = guardOptions(gate)
  return { gate, wrapProvider: (provider) => guardProvider(provider, options) }
}
