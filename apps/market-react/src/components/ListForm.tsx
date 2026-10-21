import { isTrustedOperator, omniMarketAbi, omniNftAbi, orderTypedData, type Order, type TokenMetadata } from '@omnimarket/contracts'
import { useTxEngine } from '@omnimarket/react'
import { useState } from 'react'
import { formatEther, parseEther } from 'viem'
import { describeError, describeTxError } from '../errors'
import { postOrder, type ListedOrder } from '../lib/orders'
import { useMarket } from '../lib/useMarket'
import { TxButton } from './TxButton'

const PRICE = /^(0|[1-9]\d{0,8})(\.\d{1,18})?$/
const DURATIONS = [
  { days: 1, label: '1 day' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
]

type Step = 'idle' | 'approving' | 'cancelling' | 'signing' | 'publishing'

export function ListForm({
  tokenId,
  metadata,
  approved,
  previous,
  onClose,
  onListed,
}: {
  tokenId: bigint
  metadata: TokenMetadata | null | undefined
  approved: boolean
  previous: ListedOrder | undefined
  onClose: () => void
  onListed: () => void
}) {
  const engine = useTxEngine()
  const { chainId, chain, deployment, client, signer, address, account } = useMarket()
  const [price, setPrice] = useState(previous ? formatEther(previous.order.price) : '')
  const [days, setDays] = useState(7)
  const [step, setStep] = useState<Step>('idle')
  const [txId, setTxId] = useState<string>()
  const [error, setError] = useState<string | null>(null)

  if (!chainId || !deployment || !client || !signer || !address || !account) return null
  const symbol = chain?.nativeCurrency.symbol ?? 'ETH'
  const validPrice = PRICE.test(price) && parseEther(price) > 0n
  const wei = validPrice ? parseEther(price) : 0n
  const trusted = isTrustedOperator(chainId, deployment.OmniMarket)
  // A gasless listing can't be "edited": the old signature stays fillable until cancelled on-chain.
  // Lowering the price is harmless (the cheaper one wins); raising it is not.
  const mustCancelPrevious = !!previous && validPrice && wei > previous.order.price

  const transact = async (request: Omit<Parameters<typeof engine.writeContract>[0], 'id' | 'signer' | 'account' | 'chainId'>) => {
    const id = crypto.randomUUID()
    setTxId(id)
    const result = await engine.writeContract({ ...request, id, signer, account: address, chainId } as Parameters<
      typeof engine.writeContract
    >[0])
    if (result.status !== 'confirmed') throw new Error(result.error ? describeTxError(result.error) : `Transaction ${result.status}`)
  }

  const submit = async () => {
    setError(null)
    try {
      if (mustCancelPrevious) {
        setStep('cancelling')
        await transact({
          label: `Cancel old listing of Omni #${tokenId}`,
          address: deployment.OmniMarket,
          abi: omniMarketAbi,
          functionName: 'cancelOrder',
          args: [previous!.order],
        })
      }
      if (!approved) {
        setStep('approving')
        await transact({
          label: 'Approve OmniMarket for Omni Genesis',
          address: deployment.OmniNFT,
          abi: omniNftAbi,
          functionName: 'setApprovalForAll',
          args: [deployment.OmniMarket, true],
        })
      }

      setStep('signing')
      const nonce = await client.readContract({
        address: deployment.OmniMarket,
        abi: omniMarketAbi,
        functionName: 'nonces',
        args: [address],
      })
      const order: Order = {
        seller: address,
        collection: deployment.OmniNFT,
        tokenId,
        price: wei,
        nonce,
        deadline: BigInt(Math.floor(Date.now() / 1000) + days * 86_400),
      }
      const signature = await signer.signTypedData(account, orderTypedData(chainId, deployment.OmniMarket, order))

      setStep('publishing')
      await postOrder(chainId, order, signature)
      onListed()
    } catch (e) {
      setError(describeError(e))
      setStep('idle')
    }
  }

  return (
    <section className="card list-form">
      <div className="section-head">
        <h2>List {metadata?.name || `#${tokenId}`}</h2>
        <button className="secondary small-button" onClick={onClose} disabled={step !== 'idle'}>
          Close
        </button>
      </div>

      <div className="row wrap">
        <label className="field grow">
          <span className="muted small">Price ({symbol})</span>
          <input inputMode="decimal" placeholder="0.05" value={price} onChange={(e) => setPrice(e.target.value.trim())} />
        </label>
        <label className="field">
          <span className="muted small">Duration</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {DURATIONS.map((d) => (
              <option key={d.days} value={d.days}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {price && !validPrice && <p className="error">Enter a positive amount, up to 18 decimals.</p>}

      {!approved && (
        <div className={trusted ? 'notice' : 'notice notice-danger'}>
          {trusted ? (
            <span>
              First time listing: you will approve <code className="small">{deployment.OmniMarket}</code> (OmniMarket, verified
              deployment) to transfer <b>any</b> of your Omni Genesis NFTs — but only when a buyer fills an order you signed. You
              can revoke this anytime.
            </span>
          ) : (
            <span>The operator is not a known OmniMarket deployment. Listing is blocked.</span>
          )}
        </div>
      )}
      {mustCancelPrevious && (
        <div className="notice">
          <span>
            Your current listing at {formatEther(previous!.order.price)} {symbol} stays valid on-chain until cancelled. It will be
            cancelled first (one transaction), then you sign the new price.
          </span>
        </div>
      )}

      <dl className="kv">
        <dt>You sign</dt>
        <dd>
          Sell #{tokenId.toString()} for {validPrice ? price : '—'} {symbol}
        </dd>
        <dt>Network</dt>
        <dd>{chain?.name}</dd>
        <dt>Gas</dt>
        <dd>{approved && !mustCancelPrevious ? 'None — signature only' : 'One-time transaction, then a free signature'}</dd>
      </dl>

      <TxButton txId={step === 'approving' || step === 'cancelling' ? txId : undefined} onClick={submit} disabled={!validPrice || !trusted || step !== 'idle'}>
        {step === 'signing' ? 'Sign in your wallet…' : step === 'publishing' ? 'Publishing…' : 'List for sale'}
      </TxButton>
      {error && <p className="error">{error}</p>}
    </section>
  )
}
