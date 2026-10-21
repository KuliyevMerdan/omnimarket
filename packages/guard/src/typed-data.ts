import { isAddressEqual, type Address } from 'viem'
import { PERMIT2_ADDRESS, UNLIMITED_THRESHOLD, knownContract, toAddress, toBigInt, tokenInfo } from './chain'
import {
  addressDetail,
  buildReport,
  expiryFindings,
  finding,
  formatAmount,
  formatDeadline,
  nameOf,
  spenderFindings,
  tokenLabel,
  type Analysis,
} from './report'
import type { Finding, GuardContext, ReportDetail, RiskReport, TokenAmount } from './types'

export interface TypedDataLike {
  readonly domain?: Readonly<Record<string, unknown>>
  readonly types: Readonly<Record<string, readonly { readonly name: string; readonly type: string }[]>>
  readonly primaryType: string
  readonly message: Readonly<Record<string, unknown>>
}

type Fields = Readonly<Record<string, string>>

const PERMIT2_TYPES = new Set([
  'PermitSingle',
  'PermitBatch',
  'PermitTransferFrom',
  'PermitBatchTransferFrom',
  'PermitWitnessTransferFrom',
  'PermitBatchWitnessTransferFrom',
])

/**
 * `eth_signTypedData_v4`. A signature costs nothing and leaves no trace in the wallet's history, which
 * is why permits are the favourite drainer tool: one signature, and the spender moves the tokens later.
 */
export async function inspectTypedData(typedData: TypedDataLike, ctx: GuardContext): Promise<RiskReport> {
  return buildReport('eth_signTypedData_v4', ctx, await analyzeTypedData(typedData, ctx))
}

async function analyzeTypedData(typedData: TypedDataLike, ctx: GuardContext): Promise<Analysis> {
  const domain = typedData.domain ?? {}
  const domainName = typeof domain.name === 'string' ? domain.name : undefined
  const verifyingContract = toAddress(domain.verifyingContract)
  const fields: Fields = Object.fromEntries((typedData.types[typedData.primaryType] ?? []).map((f) => [f.name, f.type]))
  const message = typedData.message ?? {}

  const chainFindings: Finding[] = []
  const chainId = toBigInt(domain.chainId)
  if (domain.chainId !== undefined && chainId !== BigInt(ctx.chainId)) {
    chainFindings.push(
      finding('blocked', 'CHAIN_MISMATCH', `This signature is for chain ${String(domain.chainId)}, you are on ${ctx.chainId}`, 'A signature for another network can be replayed there.'),
    )
  } else if (domain.chainId === undefined) {
    chainFindings.push(finding('warning', 'MISSING_CHAIN_ID', 'This signature is valid on every network', 'Its domain has no chain id.'))
  }

  const permit2 = domainName === 'Permit2' || (verifyingContract && isAddressEqual(verifyingContract, PERMIT2_ADDRESS))
  let analysis: Analysis | undefined
  if (permit2 && PERMIT2_TYPES.has(typedData.primaryType)) {
    analysis = await permit2Signature(typedData.primaryType, message, ctx)
    if (!verifyingContract || !isAddressEqual(verifyingContract, PERMIT2_ADDRESS)) {
      analysis = {
        ...analysis,
        findings: [
          finding('danger', 'PERMIT2_IMPOSTOR', 'Looks like Permit2 but is signed for another contract', `Verifying contract: ${verifyingContract ?? 'none'}.`),
          ...analysis.findings,
        ],
      }
    }
  } else if (verifyingContract && isEip2612(fields)) {
    analysis = await permit(ctx, 'eip2612', verifyingContract, message.spender, toBigInt(message.value), toBigInt(message.deadline))
  } else if (verifyingContract && isDaiPermit(fields)) {
    const allowed = message.allowed === true || message.allowed === 'true'
    // DAI's permit is all or nothing.
    analysis = await permit(ctx, 'dai', verifyingContract, message.spender, allowed ? 2n ** 256n - 1n : 0n, toBigInt(message.expiry))
  }

  analysis ??= genericTypedData(typedData.primaryType, domainName, verifyingContract, ctx)
  return { ...analysis, findings: [...chainFindings, ...analysis.findings] }
}

function isEip2612(fields: Fields): boolean {
  return fields.owner === 'address' && fields.spender === 'address' && fields.value === 'uint256' && fields.deadline === 'uint256'
}

function isDaiPermit(fields: Fields): boolean {
  return fields.holder === 'address' && fields.spender === 'address' && fields.allowed === 'bool' && fields.expiry === 'uint256'
}

const OFFCHAIN = finding(
  'warning',
  'OFFCHAIN_APPROVAL',
  'Gasless approval: a signature, not a transaction',
  'Nothing happens now and nothing shows up in your wallet history. Whoever receives this signature can use it later, until it expires.',
)

async function permit(
  ctx: GuardContext,
  standard: 'eip2612' | 'dai',
  token: Address,
  rawSpender: unknown,
  value: bigint | undefined,
  deadline: bigint | undefined,
): Promise<Analysis> {
  const spender = toAddress(rawSpender)
  if (!spender || value === undefined) return malformed('permit')
  const info = await tokenInfo(ctx, token)
  const unlimited = value >= UNLIMITED_THRESHOLD
  const details: ReportDetail[] = [
    addressDetail(ctx, 'Token', token),
    addressDetail(ctx, 'Spender', spender),
    { label: 'Amount', value: formatAmount(value, unlimited, info) },
    ...(deadline !== undefined ? [{ label: 'Valid until', value: deadline === 0n && standard === 'dai' ? 'never' : formatDeadline(deadline) }] : []),
  ]
  const intent = { kind: 'permit', standard, transfer: false, spender, tokens: [{ token, amount: value, unlimited }], deadline } as const
  if (value === 0n) {
    return { intent, summary: `Revoke ${nameOf(ctx, spender)}’s allowance by signature`, findings: [finding('info', 'REVOKE', 'Removes an approval')], details }
  }
  return {
    intent,
    summary: `Sign a permit: ${nameOf(ctx, spender)} may spend ${formatAmount(value, unlimited, info)}`,
    findings: [
      OFFCHAIN,
      ...(unlimited ? [finding('warning', 'UNLIMITED_ALLOWANCE', `Unlimited allowance for ${tokenLabel(ctx, token, info)}`)] : []),
      // DAI: expiry 0 means "never".
      ...(standard === 'dai' && deadline === 0n
        ? [finding('warning', 'NO_EXPIRY', 'The permit never expires')]
        : expiryFindings(deadline, ctx, 'permit')),
      ...(await spenderFindings(ctx, spender)),
    ],
    details,
  }
}

/**
 * Permit2 has two modes. AllowanceTransfer (`PermitSingle`/`PermitBatch`) sets a standing allowance with
 * its own expiration; SignatureTransfer (`Permit*TransferFrom`) authorizes one transfer.
 */
async function permit2Signature(primaryType: string, message: Readonly<Record<string, unknown>>, ctx: GuardContext): Promise<Analysis> {
  const transfer = primaryType.includes('TransferFrom')
  const spender = toAddress(message.spender)
  const entries = toArray(transfer ? message.permitted : message.details)
  const max = transfer ? UNLIMITED_THRESHOLD : 2n ** 160n - 1n
  const tokens: TokenAmount[] = []
  for (const entry of entries) {
    const token = toAddress((entry as { token?: unknown })?.token)
    const amount = toBigInt((entry as { amount?: unknown })?.amount)
    if (!token || amount === undefined) return malformed('Permit2 signature')
    tokens.push({ token, amount, unlimited: amount >= max })
  }
  if (!spender || tokens.length === 0) return malformed('Permit2 signature')

  // The allowance's expiration matters more than the signature deadline: it is how long the spender keeps access.
  const expirations = transfer ? [] : entries.map((e) => toBigInt((e as { expiration?: unknown }).expiration) ?? 0n)
  const deadline = transfer ? toBigInt(message.deadline) : expirations.reduce((a, b) => (b > a ? b : a), 0n)
  const infos = await Promise.all(tokens.map((t) => tokenInfo(ctx, t.token)))
  const amounts = tokens.map((t, i) => `${formatAmount(t.amount, t.unlimited, infos[i]!)}`)

  return {
    intent: { kind: 'permit', standard: 'permit2', transfer, spender, tokens, deadline },
    summary: transfer
      ? `Permit2: let ${nameOf(ctx, spender)} transfer ${amounts.join(', ')} once`
      : `Permit2: let ${nameOf(ctx, spender)} spend ${amounts.join(', ')}`,
    findings: [
      OFFCHAIN,
      ...tokens.flatMap((t, i) =>
        t.unlimited ? [finding('warning', 'UNLIMITED_ALLOWANCE', `Unlimited allowance for ${tokenLabel(ctx, t.token, infos[i]!)}`)] : [],
      ),
      ...expiryFindings(deadline, ctx, transfer ? 'signature' : 'allowance'),
      ...(await spenderFindings(ctx, spender)),
    ],
    details: [
      addressDetail(ctx, 'Spender', spender),
      ...tokens.flatMap((t, i) => [addressDetail(ctx, 'Token', t.token), { label: 'Amount', value: amounts[i]! }]),
      ...(deadline !== undefined ? [{ label: transfer ? 'Valid until' : 'Allowance expires', value: formatDeadline(deadline) }] : []),
    ],
  }
}

function genericTypedData(primaryType: string, domainName: string | undefined, verifyingContract: Address | undefined, ctx: GuardContext): Analysis {
  const known = verifyingContract && knownContract(ctx, verifyingContract)
  return {
    intent: { kind: 'typed_data', primaryType, domainName, verifyingContract },
    summary: `Sign “${primaryType}” for ${known ? known.name : (domainName ?? 'an unknown app')}`,
    findings: [
      known
        ? finding('info', 'KNOWN_CONTRACT', `${known.name} is a contract this app knows`)
        : finding(
            'warning',
            'UNKNOWN_TYPED_DATA',
            'A signature for a contract this app doesn’t know',
            'It may authorize anything that contract accepts. Read the details in your wallet.',
          ),
    ],
    details: [
      { label: 'Type', value: primaryType },
      ...(domainName ? [{ label: 'App', value: domainName.slice(0, 64) }] : []),
      ...(verifyingContract ? [addressDetail(ctx, 'Contract', verifyingContract)] : []),
    ],
  }
}

function malformed(what: string): Analysis {
  return {
    intent: { kind: 'typed_data', primaryType: what },
    summary: `Malformed ${what}`,
    findings: [finding('blocked', 'MALFORMED_REQUEST', `This ${what} is malformed`)],
    details: [],
  }
}

function toArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value
  return value && typeof value === 'object' ? [value] : []
}
