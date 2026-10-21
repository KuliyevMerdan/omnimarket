import { useAccount, useTransactions, useTxEngine } from '@omnimarket/react'
import { TERMINAL_STATUSES, isEvmRecord, namespaceOf, type AnyTxRecord, type DecodedEvent } from '@omnimarket/tx-engine'
import { useState } from 'react'
import { formatEther, formatUnits } from 'viem'
import { findChain } from '../chains'
import { describeError, describeTxError } from '../errors'
import { useMarket } from '../lib/useMarket'
import { explorerUrl, networkName } from '../networks'

const STATUS_LABEL: Record<AnyTxRecord['status'], string> = {
  preparing: 'Simulating',
  awaiting_signature: 'Waiting for wallet',
  pending: 'Pending',
  confirming: 'Confirming',
  confirmed: 'Confirmed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  replaced: 'Replaced',
}

/** EVM addresses compare case-insensitively; base58 (Solana) and Sui hex exactly. */
const sameAddress = (tx: AnyTxRecord, address: string) =>
  isEvmRecord(tx) ? tx.from.toLowerCase() === address.toLowerCase() : tx.from === address

export function ActivityPanel() {
  const engine = useTxEngine()
  const { address } = useAccount()
  const all = useTransactions()
  // History is stored per browser across chains; show only the connected account's transactions.
  const txs = address ? all.filter((tx) => sameAddress(tx, address)) : []
  const finished = txs.some((tx) => TERMINAL_STATUSES.has(tx.status))

  return (
    <section className="stack">
      <div className="section-head">
        <h2>Activity</h2>
        {finished && (
          <button className="secondary small-button" onClick={() => engine.clearFinished()}>
            Clear finished
          </button>
        )}
      </div>
      {txs.length === 0 && <p className="muted">Transactions you send from OmniMarket appear here, also after a reload.</p>}
      <ul className="activity">
        {txs.map((tx) => (
          <ActivityItem key={tx.id} tx={tx} />
        ))}
      </ul>
    </section>
  )
}

function describe(tx: AnyTxRecord) {
  if (isEvmRecord(tx)) {
    const hash = tx.minedHash ?? tx.attempts.at(-1)?.hash
    return {
      network: findChain(tx.chainId)?.name ?? `Chain ${tx.chainId}`,
      id: hash,
      url: hash ? explorerUrl({ namespace: 'eip155', chainId: tx.chainId }, hash) : undefined,
      fee: tx.gasUsed && tx.effectiveGasPrice ? `${formatEther(BigInt(tx.gasUsed) * BigInt(tx.effectiveGasPrice)).slice(0, 10)} ETH` : undefined,
      detail: tx.attempts.length > 1 ? `${tx.attempts.length} attempts` : undefined,
    }
  }
  if (tx.namespace === 'solana') {
    return {
      network: networkName(tx.chain),
      id: tx.signature,
      url: tx.signature ? explorerUrl({ namespace: 'solana', chain: tx.chain }, tx.signature) : undefined,
      fee: tx.fee ? `${formatUnits(BigInt(tx.fee), 9)} SOL` : undefined,
      detail: tx.commitment,
    }
  }
  return {
    network: networkName(tx.chain),
    id: tx.digest,
    url: tx.digest ? explorerUrl({ namespace: 'sui', chain: tx.chain }, tx.digest) : undefined,
    // Net gas can be negative: deleting objects (e.g. a kiosk listing) refunds their storage deposit.
    fee: tx.gasUsed ? suiGas(BigInt(tx.gasUsed)) : undefined,
    detail: tx.checkpoint ? `checkpoint ${tx.checkpoint}` : tx.status === 'confirming' ? 'executed, awaiting checkpoint' : undefined,
  }
}

function ActivityItem({ tx }: { tx: AnyTxRecord }) {
  const engine = useTxEngine()
  const { signer } = useMarket()
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const info = describe(tx)
  const evm = isEvmRecord(tx) ? tx : undefined
  const canReplace = !!evm && engine.canReplace(evm, signer)

  const replace = async (action: 'speedUp' | 'cancel') => {
    if (!signer || !evm) return
    setError(null)
    setBusy(true)
    try {
      await engine[action](evm.id, signer)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className={`activity-item status-${tx.status}`}>
      <div className="row between">
        <strong>{tx.label}</strong>
        <span className={`badge badge-${tx.status}`}>
          {STATUS_LABEL[tx.status]}
          {tx.status === 'confirming' && evm && ` ${tx.confirmations}/${tx.requiredConfirmations}`}
        </span>
      </div>
      <div className="muted small row wrap">
        <span className="chip">{namespaceOf(tx)}</span>
        <span>{info.network}</span>
        <span>{new Date(tx.createdAt).toLocaleTimeString()}</span>
        {info.id &&
          (info.url ? (
            <a href={info.url} target="_blank" rel="noreferrer noopener">
              {info.id.slice(0, 10)}…
            </a>
          ) : (
            <code>{info.id.slice(0, 10)}…</code>
          ))}
        {info.detail && <span>{info.detail}</span>}
        {info.fee && <span>{info.fee.startsWith('refund') ? info.fee : `fee ${info.fee}`}</span>}
      </div>

      {tx.syncError && <p className="warning small">Network issues while checking the status. Retrying…</p>}
      {tx.stuck && tx.status === 'pending' && (
        <div className="notice">
          {canReplace ? (
            <>
              <span>Taking longer than usual. Pay a higher fee to speed it up, or cancel it.</span>
              <div className="row">
                <button className="small-button" disabled={busy} onClick={() => replace('speedUp')}>
                  Speed up
                </button>
                <button className="secondary small-button" disabled={busy} onClick={() => replace('cancel')}>
                  Cancel
                </button>
              </div>
            </>
          ) : evm ? (
            <span>Taking longer than usual. Use “Speed up” in your wallet; this page will follow the replacement.</span>
          ) : (
            <span>Taking longer than usual. The app keeps resubmitting it while it is still valid.</span>
          )}
        </div>
      )}
      {evm?.replacement && tx.status === 'confirmed' && <p className="muted small">Confirmed via a faster replacement.</p>}
      {tx.status === 'replaced' && <p className="warning small">Another transaction from your wallet used the same nonce.</p>}
      {tx.error && <p className="error small">{describeTxError(tx.error)}</p>}
      {Boolean(error) && <p className="error small">{describeError(error)}</p>}
      {tx.events && tx.events.length > 0 && (
        <ul className="events">
          {tx.events.map((event, i) => (
            <li key={i}>{describeEvent(event)}</li>
          ))}
        </ul>
      )}
    </li>
  )
}

function describeEvent({ eventName, args }: DecodedEvent): string {
  switch (eventName) {
    case 'Transfer':
      return args.from === '0x0000000000000000000000000000000000000000'
        ? `Minted #${args.tokenId}`
        : `Transferred #${args.tokenId} to ${args.to?.slice(0, 8)}…`
    case 'OrderFilled':
      return `Sold #${args.tokenId} for ${formatEther(BigInt(args.price ?? '0'))}`
    case 'OrderCancelled':
      return 'Listing cancelled'
    case 'NonceIncremented':
      return 'All previous listings voided'
    case 'ApprovalForAll':
      return args.approved === 'true' ? 'Market approved' : 'Market approval revoked'
    // Sui
    case 'Minted':
      return `Minted #${args.number}`
    case 'ItemListed':
      return `Listed for ${formatUnits(BigInt(args.price ?? '0'), 9)} SUI`
    case 'ItemDelisted':
      return 'Delisted'
    case 'ItemPurchased':
      return `Bought for ${formatUnits(BigInt(args.price ?? '0'), 9)} SUI`
    default:
      return eventName
  }
}

function suiGas(net: bigint): string {
  return net < 0n ? `refund ${formatUnits(-net, 9)} SUI (storage rebate)` : `${formatUnits(net, 9)} SUI`
}
