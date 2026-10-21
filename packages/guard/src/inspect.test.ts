import { encodeFunctionData, maxUint256, parseAbi, parseUnits, type Address, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  PERMIT2_ADDRESS,
  inspectCalls,
  inspectMessage,
  inspectTransaction,
  inspectTypedData,
  type GuardContext,
  type GuardReader,
  type RiskReport,
} from '.'

const ACCOUNT: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const NFT: Address = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D'
const MARKET: Address = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const DRAINER_EOA: Address = '0x000000000000000000000000000000000000dEaD'
const ROUTER: Address = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD'
const DELEGATED: Address = '0x1111111111111111111111111111111111111111'

const abi = parseAbi([
  'function approve(address, uint256)',
  'function setApprovalForAll(address, bool)',
  'function transfer(address, uint256)',
  'function increaseAllowance(address, uint256)',
])
const permit2Abi = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)'])

const NOW = Date.UTC(2026, 9, 22)
const day = 86_400n
const nowSeconds = BigInt(NOW / 1000)

/** A chain in memory: contract code by address, ERC-165 + metadata per token. */
function chain(): GuardReader {
  const code: Record<string, Hex> = {
    [USDC.toLowerCase()]: '0x6080',
    [NFT.toLowerCase()]: '0x6080',
    [MARKET.toLowerCase()]: '0x6080',
    [ROUTER.toLowerCase()]: '0x6080',
    [PERMIT2_ADDRESS.toLowerCase()]: '0x6080',
    // EIP-7702: 0xef0100 ‖ delegate
    [DELEGATED.toLowerCase()]: `0xef0100${ROUTER.slice(2).toLowerCase()}`,
  }
  const tokens: Record<string, { symbol: string; decimals?: number; interfaces: string[] }> = {
    [USDC.toLowerCase()]: { symbol: 'USDC', decimals: 6, interfaces: [] },
    [NFT.toLowerCase()]: { symbol: 'BAYC', interfaces: ['0x80ac58cd'] },
  }
  return {
    getCode: async ({ address }: { address: Address }) => code[address.toLowerCase()],
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
      const token = tokens[address.toLowerCase()]
      if (!token) throw new Error('execution reverted')
      if (functionName === 'supportsInterface') return token.interfaces.includes(args![0] as string)
      if (functionName === 'symbol') return token.symbol
      if (functionName === 'decimals' && token.decimals !== undefined) return token.decimals
      throw new Error('execution reverted')
    },
  } as unknown as GuardReader
}

function ctx(overrides: Partial<GuardContext> = {}): GuardContext {
  return {
    chainId: 1,
    account: ACCOUNT,
    client: chain(),
    known: (_chainId, address) => (address.toLowerCase() === MARKET.toLowerCase() ? { name: 'OmniMarket' } : undefined),
    domain: 'omnimarket.app',
    now: () => NOW,
    ...overrides,
  }
}

const codes = (report: RiskReport) => report.findings.map((f) => f.code)

describe('transactions', () => {
  it('flags an unlimited ERC-20 approval to a personal address as danger', async () => {
    const report = await inspectTransaction(
      { to: USDC, data: encodeFunctionData({ abi, functionName: 'approve', args: [DRAINER_EOA, maxUint256] }) },
      ctx(),
    )
    expect(report.level).toBe('danger')
    expect(report.intent).toMatchObject({ kind: 'erc20_approve', unlimited: true, spender: DRAINER_EOA })
    expect(codes(report)).toEqual(['SPENDER_EOA', 'UNLIMITED_ALLOWANCE'])
    expect(report.summary).toBe('Approve unlimited USDC for 0x0000…dEaD')
    // A token's own symbol is never shown alone: it could say anything.
    expect(report.findings[1]!.title).toContain('unverified symbol')
  })

  it('formats a bounded approval to an unknown contract and asks for review', async () => {
    const report = await inspectTransaction(
      { to: USDC, data: encodeFunctionData({ abi, functionName: 'approve', args: [ROUTER, parseUnits('100', 6)] }) },
      ctx(),
    )
    expect(report.level).toBe('warning')
    expect(codes(report)).toEqual(['SPENDER_UNVERIFIED'])
    expect(report.details).toContainEqual({ label: 'Amount', value: '100 USDC' })
  })

  it('treats a spender delegated with EIP-7702 as a personal address', async () => {
    const report = await inspectTransaction(
      { to: USDC, data: encodeFunctionData({ abi, functionName: 'increaseAllowance', args: [DELEGATED, 1n] }) },
      ctx(),
    )
    expect(codes(report)).toContain('SPENDER_DELEGATED')
    expect(report.level).toBe('danger')
  })

  it('tells an ERC-721 approve from an ERC-20 approve with the same selector', async () => {
    const report = await inspectTransaction(
      { to: NFT, data: encodeFunctionData({ abi, functionName: 'approve', args: [ROUTER, 42n] }) },
      ctx(),
    )
    expect(report.intent).toMatchObject({ kind: 'nft_approve', tokenId: 42n })
    expect(report.summary).toBe('Let 0x3fC9…7FAD transfer 0xBC4C…f13D #42')
  })

  it('lets a known operator through setApprovalForAll without a review, but not anyone else', async () => {
    const data = (operator: Address, approved = true) =>
      encodeFunctionData({ abi, functionName: 'setApprovalForAll', args: [operator, approved] })
    const trusted = await inspectTransaction({ to: NFT, data: data(MARKET) }, ctx())
    expect(trusted.level).toBe('info')
    expect(trusted.summary).toBe('Give OmniMarket access to all your 0xBC4C…f13D NFTs')

    const scam = await inspectTransaction({ to: NFT, data: data(DRAINER_EOA) }, ctx())
    expect(scam.level).toBe('danger')
    expect(codes(scam)).toEqual(['SPENDER_EOA', 'APPROVAL_FOR_ALL'])

    const revoke = await inspectTransaction({ to: NFT, data: data(DRAINER_EOA, false) }, ctx())
    expect(revoke.level).toBe('info')
    expect(codes(revoke)).toEqual(['REVOKE'])
  })

  it('does not pretend to have checked a spender when there is no RPC', async () => {
    const report = await inspectTransaction(
      { to: USDC, data: encodeFunctionData({ abi, functionName: 'approve', args: [ROUTER, 5n] }) },
      ctx({ client: undefined }),
    )
    expect(codes(report)).toEqual(['SPENDER_UNCHECKED'])
    expect(report.details).toContainEqual({ label: 'Amount', value: '5 base units' })
  })

  it('decodes Permit2 allowances', async () => {
    const report = await inspectTransaction(
      {
        to: PERMIT2_ADDRESS,
        data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [USDC, ROUTER, 2n ** 160n - 1n, 2 ** 48 - 1] }),
      },
      ctx(),
    )
    expect(report.intent).toMatchObject({ kind: 'permit2_approve', unlimited: true })
    expect(codes(report)).toEqual(['UNLIMITED_ALLOWANCE', 'SPENDER_UNVERIFIED'])
    expect(report.details).toContainEqual({ label: 'Expires', value: 'never' })
  })

  it('describes plain transfers and unknown calls without asking', async () => {
    const send = await inspectTransaction({ to: DRAINER_EOA, value: 10n ** 18n }, ctx({ nativeSymbol: 'POL' }))
    expect(send.level).toBe('info')
    expect(send.summary).toBe('Send 1 POL to 0x0000…dEaD')

    const token = await inspectTransaction(
      { to: USDC, data: encodeFunctionData({ abi, functionName: 'transfer', args: [DRAINER_EOA, 1_500_000n] }) },
      ctx(),
    )
    expect(token.summary).toBe('Send 1.5 USDC to 0x0000…dEaD')
    expect(codes(token)).toEqual(['TRANSFER_OUT'])

    const call = await inspectTransaction({ to: MARKET, data: '0xdeadbeef' }, ctx())
    expect(call.summary).toBe('Call OmniMarket')
    expect(call.level).toBe('info')
  })

  it('inspects every call of an EIP-5792 batch', async () => {
    const report = await inspectCalls(
      [
        { to: USDC, data: encodeFunctionData({ abi, functionName: 'transfer', args: [ROUTER, 1n] }) },
        { to: USDC, data: encodeFunctionData({ abi, functionName: 'approve', args: [DRAINER_EOA, maxUint256] }) },
      ],
      ctx(),
    )
    expect(report.method).toBe('wallet_sendCalls')
    expect(report.level).toBe('danger')
    expect(report.summary).toMatch(/^2 calls: Send .*; Approve unlimited USDC/)
    expect(report.details[0]!.label).toBe('#1 Token')
  })
})

const permitTypes = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
}

describe('typed data', () => {
  it('explains an EIP-2612 permit: gasless, unlimited, never expires, to a personal address', async () => {
    const report = await inspectTypedData(
      {
        domain: { name: 'USD Coin', version: '2', chainId: 1, verifyingContract: USDC },
        types: permitTypes,
        primaryType: 'Permit',
        // As it arrives over JSON-RPC: numbers as strings.
        message: { owner: ACCOUNT, spender: DRAINER_EOA, value: maxUint256.toString(), nonce: '0', deadline: maxUint256.toString() },
      },
      ctx(),
    )
    expect(report.level).toBe('danger')
    expect(report.intent).toMatchObject({ kind: 'permit', standard: 'eip2612', transfer: false })
    expect(codes(report)).toEqual(['SPENDER_EOA', 'OFFCHAIN_APPROVAL', 'UNLIMITED_ALLOWANCE', 'NO_EXPIRY'])
  })

  it('flags a long-lived bounded permit to an unknown contract as a warning', async () => {
    const report = await inspectTypedData(
      {
        domain: { name: 'USD Coin', version: '2', chainId: '0x1', verifyingContract: USDC },
        types: permitTypes,
        primaryType: 'Permit',
        message: { owner: ACCOUNT, spender: ROUTER, value: '1000000', nonce: '0', deadline: String(nowSeconds + 90n * day) },
      },
      ctx(),
    )
    expect(report.level).toBe('warning')
    expect(codes(report)).toEqual(['OFFCHAIN_APPROVAL', 'LONG_EXPIRY', 'SPENDER_UNVERIFIED'])
    expect(report.summary).toBe('Sign a permit: 0x3fC9…7FAD may spend 1 USDC')
  })

  it('blocks a signature for another chain', async () => {
    const report = await inspectTypedData(
      { domain: { chainId: 137, verifyingContract: MARKET }, types: { Order: [] }, primaryType: 'Order', message: {} },
      ctx(),
    )
    expect(report.level).toBe('blocked')
    expect(codes(report)[0]).toBe('CHAIN_MISMATCH')
  })

  it('reads DAI permits, which are all or nothing', async () => {
    const report = await inspectTypedData(
      {
        domain: { name: 'Dai Stablecoin', chainId: 1, verifyingContract: USDC },
        types: {
          Permit: [
            { name: 'holder', type: 'address' },
            { name: 'spender', type: 'address' },
            { name: 'nonce', type: 'uint256' },
            { name: 'expiry', type: 'uint256' },
            { name: 'allowed', type: 'bool' },
          ],
        },
        primaryType: 'Permit',
        message: { holder: ACCOUNT, spender: ROUTER, nonce: 0, expiry: 0, allowed: true },
      },
      ctx(),
    )
    expect(report.intent).toMatchObject({ kind: 'permit', standard: 'dai' })
    expect(codes(report)).toEqual(['OFFCHAIN_APPROVAL', 'UNLIMITED_ALLOWANCE', 'NO_EXPIRY', 'SPENDER_UNVERIFIED'])
  })

  const permitSingle = (verifyingContract: Address) => ({
    domain: { name: 'Permit2', chainId: 1, verifyingContract },
    types: {
      PermitSingle: [
        { name: 'details', type: 'PermitDetails' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
      ],
      PermitDetails: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint160' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' },
      ],
    },
    primaryType: 'PermitSingle',
    message: {
      details: { token: USDC, amount: (2n ** 160n - 1n).toString(), expiration: String(nowSeconds + 7n * day), nonce: '0' },
      spender: ROUTER,
      sigDeadline: String(nowSeconds + 1800n),
    },
  })

  it('reads Permit2 allowance signatures and catches impostors', async () => {
    const real = await inspectTypedData(permitSingle(PERMIT2_ADDRESS), ctx())
    expect(real.intent).toMatchObject({ kind: 'permit', standard: 'permit2', transfer: false, deadline: nowSeconds + 7n * day })
    expect(real.level).toBe('warning')
    expect(codes(real)).toEqual(['OFFCHAIN_APPROVAL', 'UNLIMITED_ALLOWANCE', 'SPENDER_UNVERIFIED'])

    const fake = await inspectTypedData(permitSingle(ROUTER), ctx())
    expect(fake.level).toBe('danger')
    expect(codes(fake)[0]).toBe('PERMIT2_IMPOSTOR')
  })

  it('reads Permit2 one-time transfer signatures', async () => {
    const report = await inspectTypedData(
      {
        domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2_ADDRESS },
        types: { PermitBatchTransferFrom: [] },
        primaryType: 'PermitBatchTransferFrom',
        message: {
          permitted: [
            { token: USDC, amount: '2500000' },
            { token: NFT, amount: '1' },
          ],
          spender: MARKET,
          nonce: '7',
          deadline: String(nowSeconds + 600n),
        },
      },
      ctx(),
    )
    expect(report.intent).toMatchObject({ kind: 'permit', transfer: true })
    expect(report.summary).toBe('Permit2: let OmniMarket transfer 2.5 USDC, 1 BAYC base units once')
    expect(codes(report)).toEqual(['OFFCHAIN_APPROVAL', 'SPENDER_KNOWN'])
  })

  it('passes the app’s own typed data and warns about unknown or chainless ones', async () => {
    const order = await inspectTypedData(
      { domain: { name: 'OmniMarket', chainId: 1, verifyingContract: MARKET }, types: { Order: [] }, primaryType: 'Order', message: {} },
      ctx(),
    )
    expect(order.level).toBe('info')
    expect(order.summary).toBe('Sign “Order” for OmniMarket')

    const unknown = await inspectTypedData({ domain: { name: 'Seaport' }, types: { OrderComponents: [] }, primaryType: 'OrderComponents', message: {} }, ctx())
    expect(codes(unknown)).toEqual(['MISSING_CHAIN_ID', 'UNKNOWN_TYPED_DATA'])
  })

  it('blocks malformed permits instead of guessing', async () => {
    const report = await inspectTypedData(
      { domain: { chainId: 1, verifyingContract: USDC }, types: permitTypes, primaryType: 'Permit', message: { spender: 'nope', value: '1' } },
      ctx(),
    )
    expect(report.level).toBe('blocked')
  })
})

describe('messages', () => {
  const siwe = (domain: string, chainId = 1) =>
    `${domain} wants you to sign in with your Ethereum account:\n${ACCOUNT}\n\nSign in.\n\nURI: https://${domain}\nVersion: 1\nChain ID: ${chainId}\nNonce: abcdefgh12\nIssued At: 2026-10-22T00:00:00Z`

  it('recognizes a sign-in for this site', () => {
    const report = inspectMessage(siwe('omnimarket.app'), ctx())
    expect(report.level).toBe('info')
    expect(report.summary).toBe('Sign in to omnimarket.app')
  })

  it('flags a sign-in for another site, or another chain', () => {
    const phishing = inspectMessage(siwe('evil.example'), ctx())
    expect(phishing.level).toBe('danger')
    expect(codes(phishing)).toEqual(['SIGN_IN_DOMAIN_MISMATCH'])
    expect(codes(inspectMessage(siwe('omnimarket.app', 137), ctx()))).toEqual(['SIGN_IN_CHAIN_MISMATCH', 'SIGN_IN'])
  })

  it('decodes hex-encoded text and flags a bare hash', () => {
    const hello = inspectMessage('0x68656c6c6f', ctx())
    expect(hello.intent).toEqual({ kind: 'message', text: 'hello' })
    expect(hello.level).toBe('info')

    const hash = inspectMessage(`0x${'ab'.repeat(32)}`, ctx())
    expect(hash.level).toBe('danger')
    expect(codes(hash)).toEqual(['BLIND_SIGNATURE'])
  })

  it('warns about invisible characters that change how the text reads', () => {
    const report = inspectMessage('Transfer to ‮evil‬', ctx())
    expect(codes(report)).toEqual(['HIDDEN_CHARACTERS'])
  })
})
