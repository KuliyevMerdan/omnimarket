import { formatUnits, type Address } from 'viem'
import { accountKind, knownContract, type TokenInfo } from './chain'
import {
  RISK_ORDER,
  type Finding,
  type FindingCode,
  type GuardContext,
  type GuardedMethod,
  type Intent,
  type ReportDetail,
  type RiskLevel,
  type RiskReport,
} from './types'

export function finding(level: RiskLevel, code: FindingCode, title: string, detail?: string): Finding {
  return detail === undefined ? { code, level, title } : { code, level, title, detail }
}

export function maxLevel(findings: readonly Finding[]): RiskLevel {
  return findings.reduce<RiskLevel>((max, f) => (RISK_ORDER[f.level] > RISK_ORDER[max] ? f.level : max), 'info')
}

/** What an analyzer produces; `buildReport` adds the request context. */
export interface Analysis {
  readonly intent: Intent
  readonly summary: string
  readonly findings: readonly Finding[]
  readonly details: readonly ReportDetail[]
}

export function buildReport(method: GuardedMethod, ctx: GuardContext, analysis: Analysis): RiskReport {
  const findings = [...analysis.findings].sort((a, b) => RISK_ORDER[b.level] - RISK_ORDER[a.level])
  return {
    method,
    chainId: ctx.chainId,
    account: ctx.account,
    level: maxLevel(findings),
    summary: analysis.summary,
    intent: analysis.intent,
    findings,
    details: analysis.details,
  }
}

export function shortAddress(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/** A known contract by name, anything else by (short) address: never by a name the contract chose itself. */
export function nameOf(ctx: GuardContext, address: Address): string {
  return knownContract(ctx, address)?.name ?? shortAddress(address)
}

export function addressDetail(ctx: GuardContext, label: string, address: Address): ReportDetail {
  const known = knownContract(ctx, address)
  return { label, value: known ? `${known.name} (${shortAddress(address)})` : address, address }
}

/** "1,000 USDC", "unlimited USDC", "1000000 units" (no decimals known). */
export function formatAmount(amount: bigint, unlimited: boolean, token: TokenInfo): string {
  const symbol = token.symbol ?? 'tokens'
  if (unlimited) return `unlimited ${symbol}`
  if (token.decimals === undefined) return `${amount} ${token.symbol ? `${token.symbol} base units` : 'base units'}`
  return `${formatUnits(amount, token.decimals)} ${symbol}`
}

export function tokenLabel(ctx: GuardContext, token: Address, info: TokenInfo): string {
  const known = knownContract(ctx, token)
  if (known) return known.name
  return info.symbol ? `${info.symbol} (${shortAddress(token)}, unverified symbol)` : shortAddress(token)
}

/** Who receives a permission. Known → fine; contract → check it; personal address → almost always a scam. */
export async function spenderFindings(ctx: GuardContext, spender: Address): Promise<Finding[]> {
  const known = knownContract(ctx, spender)
  if (known) return [finding('info', 'SPENDER_KNOWN', `${known.name} is a contract this app knows`)]
  switch (await accountKind(ctx, spender)) {
    case 'eoa':
      return [
        finding(
          'danger',
          'SPENDER_EOA',
          'The spender is a personal address, not a contract',
          'Approvals are meant for contracts. Giving one to a wallet address is how most token-draining scams work.',
        ),
      ]
    case 'delegated':
      return [
        finding(
          'danger',
          'SPENDER_DELEGATED',
          'The spender is a personal address with delegated code (EIP-7702)',
          'Whoever holds its key can replace that code at any time.',
        ),
      ]
    case 'contract':
      return [
        finding(
          'warning',
          'SPENDER_UNVERIFIED',
          'The spender is a contract this app doesn’t know',
          'Check the address on a block explorer before you continue.',
        ),
      ]
    case 'unknown':
      return [finding('warning', 'SPENDER_UNCHECKED', 'The spender could not be checked', 'The network did not answer.')]
  }
}

export function expiryFindings(deadline: bigint | undefined, ctx: GuardContext, what: string): Finding[] {
  if (deadline === undefined) return []
  if (deadline >= NEVER) return [finding('warning', 'NO_EXPIRY', `The ${what} never expires`, 'It stays usable until you revoke it.')]
  const now = BigInt(Math.floor((ctx.now?.() ?? Date.now()) / 1000))
  const days = (deadline - now) / 86_400n
  if (days > 730n) return [finding('warning', 'LONG_EXPIRY', `The ${what} stays valid for ${(days + 182n) / 365n} years`)]
  if (days > 30n) return [finding('warning', 'LONG_EXPIRY', `The ${what} stays valid for ${days} days`)]
  return []
}

/** Year 2286: past this a deadline is a "max value", not a date (`type(uint48).max`, `type(uint256).max`). */
const NEVER = 10_000_000_000n

export function formatDeadline(deadline: bigint): string {
  if (deadline >= NEVER) return 'never'
  return new Date(Number(deadline) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}
