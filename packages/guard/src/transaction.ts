import { decodeFunctionData, formatEther, isAddressEqual, parseAbi, slice, zeroAddress, type Abi, type Address, type Hex } from 'viem'
import { PERMIT2_ADDRESS, UNLIMITED_THRESHOLD, knownContract, tokenInfo, type TokenInfo } from './chain'
import {
  addressDetail,
  buildReport,
  finding,
  formatAmount,
  formatDeadline,
  nameOf,
  spenderFindings,
  tokenLabel,
  type Analysis,
} from './report'
import type { Finding, GuardContext, ReportDetail, RiskReport } from './types'

/**
 * Functions that move or grant access to assets. Several share a selector across standards
 * (`approve`, `transferFrom` in ERC-20 and ERC-721; `setApprovalForAll` in ERC-721 and ERC-1155).
 */
const ASSET_ABI = parseAbi([
  'function approve(address spender, uint256 amountOrTokenId)',
  'function increaseAllowance(address spender, uint256 addedValue)',
  'function setApprovalForAll(address operator, bool approved)',
  'function transfer(address to, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amountOrTokenId)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
  'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
  'function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)',
])

const PERMIT2_ABI = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)'])

export interface TransactionLike {
  readonly to?: Address | null
  readonly data?: Hex
  readonly value?: bigint
}

/** `eth_sendTransaction`: decode what the call grants or moves and who receives it. */
export async function inspectTransaction(tx: TransactionLike, ctx: GuardContext): Promise<RiskReport> {
  return buildReport('eth_sendTransaction', ctx, await analyzeCall(tx, ctx))
}

/** EIP-5792 `wallet_sendCalls`: every call is inspected; one approval hidden in a batch is still an approval. */
export async function inspectCalls(calls: readonly TransactionLike[], ctx: GuardContext): Promise<RiskReport> {
  const analyses = await Promise.all(calls.map((call) => analyzeCall(call, ctx)))
  return buildReport('wallet_sendCalls', ctx, {
    intent: { kind: 'batch', calls: analyses.map((a) => a.intent) },
    summary: analyses.length === 1 ? analyses[0]!.summary : `${analyses.length} calls: ${analyses.map((a) => a.summary).join('; ')}`,
    findings: analyses.flatMap((a) => a.findings),
    details: analyses.flatMap((a, i) => a.details.map((d) => ({ ...d, label: `#${i + 1} ${d.label}` }))),
  })
}

export async function analyzeCall({ to, data, value = 0n }: TransactionLike, ctx: GuardContext): Promise<Analysis> {
  const symbol = ctx.nativeSymbol ?? 'ETH'
  const valueFindings: Finding[] = value > 0n ? [finding('info', 'NATIVE_VALUE', `Sends ${formatEther(value)} ${symbol}`)] : []
  const valueDetails: ReportDetail[] = value > 0n ? [{ label: 'Value', value: `${formatEther(value)} ${symbol}` }] : []

  if (!to) {
    return {
      intent: { kind: 'deploy' },
      summary: 'Deploy a contract',
      findings: [finding('info', 'CONTRACT_DEPLOYMENT', 'Deploys a new contract'), ...valueFindings],
      details: valueDetails,
    }
  }
  if (!data || data === '0x') {
    return {
      intent: { kind: 'native_transfer', to, value },
      summary: `Send ${formatEther(value)} ${symbol} to ${nameOf(ctx, to)}`,
      findings: valueFindings,
      details: [addressDetail(ctx, 'To', to), ...valueDetails],
    }
  }

  const asset = isAddressEqual(to, PERMIT2_ADDRESS) ? await permit2Call(to, data, ctx) : await assetCall(to, data, ctx)
  if (asset) return { ...asset, findings: [...asset.findings, ...valueFindings], details: [...asset.details, ...valueDetails] }

  const known = knownContract(ctx, to)
  return {
    intent: { kind: 'contract_call', to, selector: data.length >= 10 ? slice(data, 0, 4) : undefined, value },
    summary: `Call ${nameOf(ctx, to)}`,
    findings: [
      known
        ? finding('info', 'KNOWN_CONTRACT', `${known.name} is a contract this app knows`)
        : finding('info', 'UNKNOWN_CONTRACT', 'Calls a contract this app can’t describe', 'The transaction was simulated and does not revert.'),
      ...valueFindings,
    ],
    details: [addressDetail(ctx, 'Contract', to), ...valueDetails],
  }
}

async function assetCall(to: Address, data: Hex, ctx: GuardContext): Promise<Analysis | undefined> {
  const call = decode(ASSET_ABI, data)
  if (!call) return undefined

  switch (call.functionName) {
    case 'approve':
    case 'increaseAllowance': {
      const [spender, amount] = call.args as readonly [Address, bigint]
      const token = await tokenInfo(ctx, to)
      if (call.functionName === 'approve' && token.standard === 'erc721') return nftApproval(ctx, to, spender, amount)
      return erc20Approval(ctx, to, spender, amount, token, call.functionName === 'increaseAllowance')
    }
    case 'setApprovalForAll': {
      const [operator, approved] = call.args as readonly [Address, boolean]
      const known = knownContract(ctx, operator)
      const findings = approved
        ? [
            finding(
              known ? 'info' : 'warning',
              'APPROVAL_FOR_ALL',
              `${nameOf(ctx, operator)} can transfer every NFT you hold in ${nameOf(ctx, to)}`,
              'Including NFTs you receive later, until you revoke it.',
            ),
            ...(await spenderFindings(ctx, operator)),
          ]
        : [finding('info', 'REVOKE', 'Removes an approval')]
      return {
        intent: { kind: 'approval_for_all', collection: to, operator, approved },
        summary: approved
          ? `Give ${nameOf(ctx, operator)} access to all your ${nameOf(ctx, to)} NFTs`
          : `Revoke ${nameOf(ctx, operator)}’s access to ${nameOf(ctx, to)}`,
        findings,
        details: [addressDetail(ctx, 'Collection', to), addressDetail(ctx, 'Operator', operator)],
      }
    }
    case 'transfer': {
      const [recipient, amount] = call.args as readonly [Address, bigint]
      return transfer(ctx, to, ctx.account, recipient, amount, await tokenInfo(ctx, to))
    }
    case 'transferFrom':
    case 'safeTransferFrom':
    case 'safeBatchTransferFrom': {
      const [from, recipient, idOrIds] = call.args as readonly [Address, Address, bigint | readonly bigint[]]
      const token = await tokenInfo(ctx, to)
      // safe* exist only on NFTs; plain transferFrom is whatever ERC-165 says.
      const standard = call.functionName === 'transferFrom' ? token.standard : token.standard === 'erc1155' ? 'erc1155' : 'erc721'
      return transfer(ctx, to, from, recipient, idOrIds, { ...token, standard })
    }
  }
}

async function nftApproval(ctx: GuardContext, collection: Address, spender: Address, tokenId: bigint): Promise<Analysis> {
  const revoke = isAddressEqual(spender, zeroAddress)
  return {
    intent: { kind: 'nft_approve', collection, spender, tokenId },
    summary: revoke ? `Remove the approval for #${tokenId}` : `Let ${nameOf(ctx, spender)} transfer ${nameOf(ctx, collection)} #${tokenId}`,
    findings: revoke ? [finding('info', 'REVOKE', 'Removes an approval')] : await spenderFindings(ctx, spender),
    details: [
      addressDetail(ctx, 'Collection', collection),
      { label: 'Token', value: `#${tokenId}` },
      ...(revoke ? [] : [addressDetail(ctx, 'Spender', spender)]),
    ],
  }
}

async function erc20Approval(
  ctx: GuardContext,
  token: Address,
  spender: Address,
  amount: bigint,
  info: TokenInfo,
  increase: boolean,
): Promise<Analysis> {
  const unlimited = amount >= UNLIMITED_THRESHOLD
  const label = tokenLabel(ctx, token, info)
  const intent = { kind: 'erc20_approve', token, spender, amount, unlimited } as const
  const details = [
    addressDetail(ctx, 'Token', token),
    addressDetail(ctx, 'Spender', spender),
    { label: 'Amount', value: formatAmount(amount, unlimited, info) },
  ]
  if (amount === 0n && !increase) {
    return { intent, summary: `Revoke ${nameOf(ctx, spender)}’s ${label} allowance`, findings: [finding('info', 'REVOKE', 'Removes an approval')], details }
  }
  return {
    intent,
    summary: `${increase ? 'Increase allowance by' : 'Approve'} ${formatAmount(amount, unlimited, info)} for ${nameOf(ctx, spender)}`,
    findings: [
      ...(unlimited
        ? [
            finding(
              'warning',
              'UNLIMITED_ALLOWANCE',
              `Unlimited allowance for ${label}`,
              'The spender can take all of this token you hold now or later, until you revoke it. Approve only what you need.',
            ),
          ]
        : []),
      ...(await spenderFindings(ctx, spender)),
    ],
    details,
  }
}

function transfer(
  ctx: GuardContext,
  token: Address,
  from: Address,
  to: Address,
  idOrAmount: bigint | readonly bigint[],
  info: TokenInfo,
): Analysis {
  const nft = info.standard === 'erc721' || info.standard === 'erc1155'
  const amount = typeof idOrAmount === 'bigint' ? idOrAmount : BigInt(idOrAmount.length)
  const what =
    typeof idOrAmount !== 'bigint'
      ? `${idOrAmount.length} items of ${nameOf(ctx, token)}`
      : nft
        ? `${nameOf(ctx, token)} #${idOrAmount}`
        : formatAmount(idOrAmount, false, info)
  const yours = isAddressEqual(from, ctx.account)
  return {
    intent: { kind: 'token_transfer', token, from, to, amount, standard: info.standard },
    summary: `Send ${what} to ${nameOf(ctx, to)}`,
    findings: yours && !isAddressEqual(to, ctx.account) ? [finding('info', 'TRANSFER_OUT', `Sends ${what} out of your wallet`)] : [],
    details: [addressDetail(ctx, 'Token', token), addressDetail(ctx, 'From', from), addressDetail(ctx, 'To', to)],
  }
}

async function permit2Call(to: Address, data: Hex, ctx: GuardContext): Promise<Analysis | undefined> {
  const call = decode(PERMIT2_ABI, data)
  if (!call) return undefined
  const [token, spender, amount, expiration] = call.args as readonly [Address, Address, bigint, number]
  const info = await tokenInfo(ctx, token)
  const unlimited = amount >= 2n ** 160n - 1n
  const findings =
    amount === 0n
      ? [finding('info', 'REVOKE', 'Removes a Permit2 allowance')]
      : [
          ...(unlimited ? [finding('warning', 'UNLIMITED_ALLOWANCE', `Unlimited Permit2 allowance for ${tokenLabel(ctx, token, info)}`)] : []),
          ...(await spenderFindings(ctx, spender)),
        ]
  return {
    intent: { kind: 'permit2_approve', token, spender, amount, unlimited, expiration: BigInt(expiration) },
    summary: `Permit2: let ${nameOf(ctx, spender)} spend ${formatAmount(amount, unlimited, info)}`,
    findings,
    details: [
      addressDetail(ctx, 'Via', to),
      addressDetail(ctx, 'Token', token),
      addressDetail(ctx, 'Spender', spender),
      { label: 'Amount', value: formatAmount(amount, unlimited, info) },
      { label: 'Expires', value: formatDeadline(BigInt(expiration)) },
    ],
  }
}

function decode<const abi extends Abi>(abi: abi, data: Hex) {
  try {
    return decodeFunctionData({ abi, data })
  } catch {
    return undefined
  }
}
