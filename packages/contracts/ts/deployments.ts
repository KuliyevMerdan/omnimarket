import type { Address } from 'viem'
import deploymentsJson from '../deployments/index.json'

export interface Deployment {
  readonly OmniMarket: Address
  readonly OmniNFT: Address
  readonly startBlock: number
}

const deployments = deploymentsJson as Readonly<Record<string, Deployment>>

export function getDeployment(chainId: number): Deployment | undefined {
  return deployments[chainId]
}

export function deployedChainIds(): number[] {
  return Object.keys(deployments).map(Number)
}

/**
 * Before asking for `setApprovalForAll`, check the operator is our own deployment. A phishing
 * page asking to approve an arbitrary operator is the most common NFT drain.
 */
export function isTrustedOperator(chainId: number, operator: Address): boolean {
  return getDeployment(chainId)?.OmniMarket.toLowerCase() === operator.toLowerCase()
}
