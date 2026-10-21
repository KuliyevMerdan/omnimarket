import { WalletError } from '@omnimarket/wallet-core'
import { hexToNumber, isAddress, type Address, type EIP1193Provider, type Hex } from 'viem'
import { toAddress, toBigInt } from './chain'
import { inspectMessage, inspectRawSignature } from './message'
import { buildReport, finding } from './report'
import { inspectCalls, inspectTransaction, type TransactionLike } from './transaction'
import { inspectTypedData, type TypedDataLike } from './typed-data'
import { RISK_ORDER, type GuardContext, type GuardReader, type GuardedMethod, type KnownContract, type RiskLevel, type RiskReport } from './types'

export interface GuardOptions {
  /** RPC reads per chain (code, ERC-165, token metadata). Never the wallet: reads must not wake a phone. */
  readonly getClient?: (chainId: number) => GuardReader | undefined
  readonly known?: (chainId: number, address: Address) => KnownContract | undefined
  readonly domain?: string
  readonly nativeSymbol?: (chainId: number) => string | undefined
  readonly now?: () => number
  /**
   * Shows the report and resolves `true` to forward the request to the wallet. Called for reports at
   * or above `reviewFrom`; `blocked` reports never reach it.
   */
  readonly review: (report: RiskReport) => Promise<boolean>
  /** Default `warning`: plain, described requests go straight to the wallet. */
  readonly reviewFrom?: Exclude<RiskLevel, 'blocked'>
  /** Every report, reviewed or not (logging, tests). */
  readonly onReport?: (report: RiskReport) => void
}

const GUARDED = new Set<string>([
  'eth_sendTransaction',
  'wallet_sendCalls',
  'eth_signTypedData_v4',
  'eth_signTypedData_v3',
  'personal_sign',
  'eth_sign',
])

/**
 * EIP-1193 middleware: every signing request is decoded and checked *before* the wallet sees it.
 * Wallets show raw hex or a generic "Signature request" for most of these, and users approve what they
 * can't read. Plugged in at the provider, so every path is covered: the tx engine, typed data, sign-in,
 * extensions and WalletConnect alike. Everything else (reads, events) passes through untouched.
 */
export function guardProvider(provider: EIP1193Provider, options: GuardOptions): EIP1193Provider {
  const request = async (args: { method: string; params?: unknown }) => {
    if (GUARDED.has(args.method)) await check(provider, args.method, args.params, options)
    return provider.request(args as Parameters<EIP1193Provider['request']>[0])
  }
  // A Proxy keeps provider flags (`isMetaMask`, …) and binds methods to the original: providers with
  // private fields break when called with the proxy as `this`.
  return new Proxy(provider, {
    get(target, property, receiver) {
      if (property === 'request') return request
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

async function check(provider: EIP1193Provider, method: string, params: unknown, options: GuardOptions): Promise<void> {
  const list = Array.isArray(params) ? params : []
  const report = await inspect(provider, method, list, options).catch((error: unknown) =>
    // Fail closed into a review, not open: a bug or an RPC outage must not wave a request through.
    fallbackReport(method, list, error),
  )
  options.onReport?.(report)

  if (report.level === 'blocked') {
    const reason = report.findings.find((f) => f.level === 'blocked')
    throw new WalletError('BLOCKED', `Blocked by OmniMarket: ${reason?.title ?? report.summary}.`)
  }
  if (RISK_ORDER[report.level] < RISK_ORDER[options.reviewFrom ?? 'warning']) return
  if (!(await options.review(report))) {
    throw new WalletError('USER_REJECTED', 'You rejected the request in the security review.', { rpcCode: 4001 })
  }
}

async function inspect(provider: EIP1193Provider, method: string, params: readonly unknown[], options: GuardOptions): Promise<RiskReport> {
  const context = async (account: unknown, chainHint?: unknown): Promise<GuardContext> => {
    const chainId = parseChainId(chainHint) ?? parseChainId(await provider.request({ method: 'eth_chainId' }))
    if (chainId === undefined) throw new Error('Unknown chain')
    const address = toAddress(account) ?? toAddress(((await provider.request({ method: 'eth_accounts' })) as string[])[0])
    if (!address) throw new Error('Unknown account')
    return {
      chainId,
      account: address,
      client: options.getClient?.(chainId),
      known: options.known,
      domain: options.domain,
      nativeSymbol: options.nativeSymbol?.(chainId),
      now: options.now,
    }
  }

  switch (method) {
    case 'eth_sendTransaction': {
      const tx = (params[0] ?? {}) as { from?: string; to?: string | null; data?: Hex; input?: Hex; value?: string; chainId?: string }
      const ctx = await context(tx.from, tx.chainId)
      return inspectTransaction(toTransaction(tx), ctx)
    }
    case 'wallet_sendCalls': {
      const batch = (params[0] ?? {}) as { from?: string; chainId?: string; calls?: unknown[] }
      const ctx = await context(batch.from, batch.chainId)
      return inspectCalls((batch.calls ?? []).map((c) => toTransaction(c as Parameters<typeof toTransaction>[0])), ctx)
    }
    case 'eth_signTypedData_v3':
    case 'eth_signTypedData_v4': {
      const [account, raw] = params
      const ctx = await context(account)
      const typedData = (typeof raw === 'string' ? JSON.parse(raw) : raw) as TypedDataLike
      if (!typedData || typeof typedData !== 'object' || typeof typedData.primaryType !== 'string' || !typedData.types) {
        throw new Error('Malformed typed data')
      }
      return inspectTypedData(typedData, ctx)
    }
    case 'personal_sign': {
      // Spec order is [message, address]; some dApps still send them swapped.
      const [first, second] = params as [string, string]
      const swapped = isAddress(first ?? '') && !isAddress(second ?? '')
      const ctx = await context(swapped ? first : second)
      return inspectMessage(String(swapped ? second : first), ctx)
    }
    default: {
      const [account, hash] = params as [string, string]
      return inspectRawSignature(String(hash), await context(account))
    }
  }
}

function toTransaction(tx: { to?: string | null; data?: Hex; input?: Hex; value?: string }): TransactionLike {
  return { to: toAddress(tx.to) ?? null, data: tx.data ?? tx.input, value: toBigInt(tx.value) ?? 0n }
}

function parseChainId(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.startsWith('0x')) return hexToNumber(value as Hex)
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return undefined
}

function fallbackReport(method: string, params: readonly unknown[], error: unknown): RiskReport {
  const account = toAddress((params[0] as { from?: string } | undefined)?.from) ?? toAddress(params[0]) ?? toAddress(params[1])
  const malformed = error instanceof SyntaxError || (error instanceof Error && error.message.startsWith('Malformed'))
  return buildReport(method as GuardedMethod, { chainId: 0, account: account ?? '0x0000000000000000000000000000000000000000' }, {
    intent: { kind: 'typed_data', primaryType: method },
    summary: malformed ? 'Malformed request' : 'This request could not be checked',
    findings: [
      malformed
        ? finding('blocked', 'MALFORMED_REQUEST', 'This request is malformed')
        : finding('warning', 'INSPECTION_FAILED', 'This request could not be checked', error instanceof Error ? error.message : String(error)),
    ],
    details: [],
  })
}
