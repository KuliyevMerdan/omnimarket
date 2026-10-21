import { getPublicClient, knownContract } from '@omnimarket/app-core'
import { orderTypedData } from '@omnimarket/contracts'
import {
  PERMIT2_ADDRESS,
  inspectMessage,
  inspectTransaction,
  inspectTypedData,
  type GuardContext,
  type RiskLevel,
  type RiskReport,
  type TypedDataLike,
} from '@omnimarket/guard'
import { useState } from 'react'
import { encodeFunctionData, isAddress, isHex, maxUint256, parseAbi, parseEther, type Address, type Hex } from 'viem'
import { useMarket } from '../lib/useMarket'

type Mode = 'transaction' | 'typed' | 'message'

interface Input {
  readonly mode: Mode
  readonly to?: string
  readonly data?: string
  readonly value?: string
  readonly text?: string
}

const STRANGER = '0x000000000000000000000000000000000000dEaD'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const abi = parseAbi(['function approve(address, uint256)', 'function setApprovalForAll(address, bool)'])
const json = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)

/** Requests a phishing page would send, plus the app's own, to compare the verdicts. */
function presets(ctx: { chainId: number; account: Address; market?: Address; nft?: Address }): Record<string, Input> {
  const nft = ctx.nft ?? USDC
  return {
    'Unlimited token approval to a personal address': {
      mode: 'transaction',
      to: USDC,
      data: encodeFunctionData({ abi, functionName: 'approve', args: [STRANGER, maxUint256] }),
    },
    'Access to all your NFTs for an unknown address': {
      mode: 'transaction',
      to: nft,
      data: encodeFunctionData({ abi, functionName: 'setApprovalForAll', args: [STRANGER, true] }),
    },
    'Access to all your NFTs for OmniMarket (what listing asks)': {
      mode: 'transaction',
      to: nft,
      data: ctx.market ? encodeFunctionData({ abi, functionName: 'setApprovalForAll', args: [ctx.market, true] }) : '0x',
    },
    'Gasless permit: unlimited, never expires': {
      mode: 'typed',
      text: json({
        domain: { name: 'USD Coin', version: '2', chainId: ctx.chainId, verifyingContract: USDC },
        types: {
          Permit: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        },
        primaryType: 'Permit',
        message: { owner: ctx.account, spender: STRANGER, value: maxUint256, nonce: 0, deadline: maxUint256 },
      }),
    },
    'Permit2 allowance for 30 years': {
      mode: 'typed',
      text: json({
        domain: { name: 'Permit2', chainId: ctx.chainId, verifyingContract: PERMIT2_ADDRESS },
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
          details: { token: USDC, amount: 2n ** 160n - 1n, expiration: Math.floor(Date.now() / 1000) + 30 * 365 * 86_400, nonce: 0 },
          spender: STRANGER,
          sigDeadline: Math.floor(Date.now() / 1000) + 1800,
        },
      }),
    },
    'Signature for another network': {
      mode: 'typed',
      text: ctx.market
        ? json(orderTypedData(ctx.chainId === 1 ? 137 : 1, ctx.market, sampleOrder(ctx.account, nft)))
        : '{}',
    },
    'Your own listing (OmniMarket order)': {
      mode: 'typed',
      text: ctx.market ? json(orderTypedData(ctx.chainId, ctx.market, sampleOrder(ctx.account, nft))) : '{}',
    },
    'Sign-in for another website': {
      mode: 'message',
      text: `app.omnimarket-airdrop.example wants you to sign in with your Ethereum account:\n${ctx.account}\n\nClaim your airdrop.\n\nURI: https://app.omnimarket-airdrop.example\nVersion: 1\nChain ID: ${ctx.chainId}\nNonce: 8f2a1c9d4b\nIssued At: ${new Date().toISOString()}`,
    },
    'A bare 32-byte hash': { mode: 'message', text: `0x${'5c'.repeat(32)}` },
  }
}

function sampleOrder(seller: Address, collection: Address) {
  return { seller, collection, tokenId: 1n, price: parseEther('0.05'), nonce: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 7 * 86_400) }
}

/**
 * Runs the same checks the wallet middleware runs, on a request pasted here. Nothing is sent to the
 * wallet: it is a way to see what a site is really asking for before signing it elsewhere.
 */
export function InspectPage() {
  const { chainId, address, deployment } = useMarket()
  const [input, setInput] = useState<Input>({ mode: 'transaction', to: '', data: '', value: '' })
  const [report, setReport] = useState<RiskReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!chainId || !address) return null
  const options = presets({ chainId, account: address, market: deployment?.OmniMarket, nft: deployment?.OmniNFT })

  const check = async (request: Input = input) => {
    setError(null)
    setReport(null)
    setBusy(true)
    const ctx: GuardContext = {
      chainId,
      account: address,
      client: getPublicClient(chainId),
      known: knownContract,
      domain: location.host,
    }
    try {
      if (request.mode === 'transaction') {
        if (request.to && !isAddress(request.to)) throw new Error('“To” is not an address.')
        if (request.data && !isHex(request.data)) throw new Error('Data must be hex (0x…).')
        setReport(
          await inspectTransaction(
            { to: (request.to || null) as Address | null, data: (request.data || undefined) as Hex | undefined, value: request.value ? parseEther(request.value) : 0n },
            ctx,
          ),
        )
      } else if (request.mode === 'typed') {
        setReport(await inspectTypedData(JSON.parse(request.text ?? '') as TypedDataLike, ctx))
      } else {
        setReport(inspectMessage(request.text ?? '', ctx))
      }
    } catch (e) {
      setError(e instanceof SyntaxError ? 'That is not valid JSON.' : e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const pick = (name: string) => {
    const preset = options[name]
    if (!preset) return
    setInput(preset)
    void check(preset)
  }

  return (
    <section className="stack">
      <div className="section-head">
        <h2>Check a request</h2>
      </div>
      <p className="muted">
        Every signature and transaction from this app passes these checks before your wallet opens. Paste what another site asks you
        to sign to see what it really does. Nothing here is sent to your wallet.
      </p>

      <div className="card">
        <label className="field">
          <span className="muted small">Example</span>
          <select value="" onChange={(e) => pick(e.target.value)}>
            <option value="" disabled>
              Pick an example…
            </option>
            {Object.keys(options).map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>

        <div className="tabs" role="tablist" aria-label="Request type">
          {(['transaction', 'typed', 'message'] as const).map((mode) => (
            <button
              key={mode}
              role="tab"
              aria-selected={input.mode === mode}
              className={input.mode === mode ? 'tab tab-active' : 'tab'}
              onClick={() => setInput({ mode })}
            >
              {mode === 'transaction' ? 'Transaction' : mode === 'typed' ? 'Typed data (EIP-712)' : 'Message'}
            </button>
          ))}
        </div>

        {input.mode === 'transaction' ? (
          <>
            <label className="field">
              <span className="muted small">To</span>
              <input value={input.to ?? ''} placeholder="0x…" spellCheck={false} onChange={(e) => setInput({ ...input, to: e.target.value.trim() })} />
            </label>
            <label className="field">
              <span className="muted small">Data</span>
              <textarea rows={3} value={input.data ?? ''} placeholder="0x095ea7b3…" spellCheck={false} onChange={(e) => setInput({ ...input, data: e.target.value.trim() })} />
            </label>
            <label className="field">
              <span className="muted small">Value (native currency)</span>
              <input inputMode="decimal" value={input.value ?? ''} placeholder="0" onChange={(e) => setInput({ ...input, value: e.target.value.trim() })} />
            </label>
          </>
        ) : (
          <label className="field">
            <span className="muted small">{input.mode === 'typed' ? 'Typed data JSON (eth_signTypedData_v4)' : 'Message text or hex (personal_sign)'}</span>
            <textarea rows={input.mode === 'typed' ? 12 : 6} value={input.text ?? ''} spellCheck={false} onChange={(e) => setInput({ ...input, text: e.target.value })} />
          </label>
        )}

        <button onClick={() => void check()} disabled={busy}>
          {busy ? 'Checking…' : 'Check'}
        </button>
        {error && <p className="error">{error}</p>}
      </div>

      {report && <ReportCard report={report} />}
    </section>
  )
}

const VERDICT: Record<RiskLevel, { label: string; text: string }> = {
  info: { label: 'Looks fine', text: 'Goes straight to your wallet.' },
  warning: { label: 'Review', text: 'You would see this review before your wallet opens.' },
  danger: { label: 'Danger', text: 'You would have to confirm that you understand the risk.' },
  blocked: { label: 'Blocked', text: 'This app would never send it to your wallet.' },
}

function ReportCard({ report }: { report: RiskReport }) {
  return (
    <article className={`card risk risk-${report.level}`} aria-live="polite">
      <span className="risk-chip">{VERDICT[report.level].label}</span>
      <h3 className="risk-summary">{report.summary}</h3>
      <p className="muted small">{VERDICT[report.level].text}</p>
      {report.findings.length > 0 && (
        <ul className="risk-findings">
          {report.findings.map((f) => (
            <li key={`${f.code}-${f.title}`} className={`risk-${f.level}`}>
              <b>{f.title}</b>
              {f.detail && <span>{f.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {report.details.length > 0 && (
        <dl className="kv">
          {report.details.map((d, i) => (
            <div key={i} style={{ display: 'contents' }}>
              <dt>{d.label}</dt>
              <dd>{d.address && d.value === d.address ? <omni-address value={d.address} chars={6} /> : d.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  )
}
