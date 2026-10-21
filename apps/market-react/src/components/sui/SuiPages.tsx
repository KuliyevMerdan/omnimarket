import {
  delistTransaction,
  fetchListings,
  fetchOwnedNfts,
  listTransaction,
  mintAndListTransaction,
  mintTransaction,
  purchaseTransaction,
  type SuiListing,
} from '@omnimarket/contracts/sui'
import type { Transaction } from '@mysten/sui/transactions'
import { useSuiTxEngine } from '@omnimarket/react'
import { useState, type ReactNode } from 'react'
import { formatUnits, parseUnits } from 'viem'
import { describeError, describeTxError } from '../../errors'
import { useLoader } from '../../lib/useLoader'
import { useSui, type SuiContext } from '../../lib/useChain'
import { networkName } from '@omnimarket/app-core'
import { TokenCard } from '../TokenCard'
import { TxButton } from '../TxButton'

const PRICE = /^(0|[1-9]\d{0,8})(\.\d{1,9})?$/
const toMist = (sui: string) => (PRICE.test(sui) ? parseUnits(sui, 9) : 0n)
const formatSui = (mist: bigint) => `${formatUnits(mist, 9)} SUI`

/** Shared plumbing: run a Sui transaction through the engine and remember its id per action. */
function useSuiActions(sui: SuiContext | null, onConfirmed: () => void) {
  const engine = useSuiTxEngine()
  const [txIds, setTxIds] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const run = async (key: string, label: string, build: () => Transaction | Promise<Transaction>) => {
    if (!sui) return
    const id = crypto.randomUUID()
    setTxIds((m) => ({ ...m, [key]: id }))
    setError(null)
    try {
      const transaction = await build()
      const result = await engine.send({ id, label, connector: sui.connector, account: sui.account, transaction })
      if (result.status === 'confirmed' || result.status === 'confirming') onConfirmed()
      else if (result.error) setError(describeTxError(result.error))
    } catch (e) {
      setError(describeError(e))
    }
  }
  return { run, txIds, error }
}

function SuiGate({ sui, children }: { sui: SuiContext | null; children: ReactNode }) {
  if (!sui) return null
  if (!sui.deployment) {
    return (
      <section className="card">
        <h2>OmniMarket is not deployed on {networkName(sui.chain)}</h2>
        <p className="muted">
          Locally, run <code>pnpm dev:sui</code> and <code>pnpm deploy:sui</code>.
        </p>
      </section>
    )
  }
  return children
}

export function SuiMarketPage() {
  const sui = useSui()
  const listings = useLoader(
    async () => (sui?.deployment ? fetchListings(sui.client, sui.kiosk, sui.deployment) : []),
    [sui?.client, sui?.deployment?.packageId],
  )
  const { run, txIds, error } = useSuiActions(sui, listings.reload)

  const buy = (listing: SuiListing) =>
    run(listing.objectId, `Buy ${listing.name} for ${formatSui(listing.priceMist)}`, () =>
      purchaseTransaction(sui!.deployment!, sui!.address, listing),
    )

  return (
    <SuiGate sui={sui}>
      <section className="stack">
        <div className="section-head">
          <h2>Kiosk listings on {sui && networkName(sui.chain)}</h2>
          <button className="secondary small-button" onClick={listings.reload} disabled={listings.loading}>
            {listings.loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <p className="muted small">
          Found through <code>ItemListed</code> events, confirmed against current kiosk state. Buying resolves the type’s
          TransferPolicy in the same transaction and sends the NFT to your wallet.
        </p>
        {error && <p className="error">{error}</p>}
        {Boolean(listings.error) && <p className="error">{describeError(listings.error)}</p>}
        {!listings.loading && (listings.data ?? []).length === 0 && <p className="muted">No active listings.</p>}
        <div className="tokens">
          {(listings.data ?? []).map((listing) => {
            const mine = listing.seller === sui?.address
            return (
              <TokenCard key={listing.objectId} metadata={{ name: listing.name, description: '', image: listing.image }}>
                <div className="price">{formatSui(listing.priceMist)}</div>
                <div className="muted small">{mine ? 'Your listing' : `Kiosk ${listing.kioskId.slice(0, 8)}…`}</div>
                {!mine && (
                  <TxButton txId={txIds[listing.objectId]} onClick={() => buy(listing)}>
                    Buy
                  </TxButton>
                )}
              </TokenCard>
            )
          })}
        </div>
      </section>
    </SuiGate>
  )
}

export function SuiNftsPage() {
  const sui = useSui()
  const [amount, setAmount] = useState(1)
  const [prices, setPrices] = useState<Record<string, string>>({})
  const [mintListPrice, setMintListPrice] = useState('0.5')

  const data = useLoader(async () => {
    if (!sui?.deployment) return { owned: [], listed: [] }
    const [owned, all] = await Promise.all([
      fetchOwnedNfts(sui.client, sui.address, sui.deployment),
      fetchListings(sui.client, sui.kiosk, sui.deployment),
    ])
    return { owned, listed: all.filter((l) => l.seller === sui.address) }
  }, [sui?.client, sui?.address, sui?.deployment?.packageId])
  const { run, txIds, error } = useSuiActions(sui, data.reload)
  if (!sui?.deployment) return <SuiGate sui={sui}>{null}</SuiGate>
  const deployment = sui.deployment

  return (
    <section className="stack">
      <div className="section-head">
        <h2>My Sui NFTs</h2>
        <div className="row wrap">
          <select value={amount} onChange={(e) => setAmount(Number(e.target.value))} aria-label="Amount to mint">
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <TxButton txId={txIds.mint} onClick={() => run('mint', `Mint ${amount} Omni Sui`, () => mintTransaction(deployment, amount))}>
            Mint
          </TxButton>
        </div>
      </div>

      <div className="notice">
        <span>Programmable transaction: mint a new NFT and list it in your kiosk, in one signature.</span>
        <div className="row">
          <input className="price-input" inputMode="decimal" value={mintListPrice} onChange={(e) => setMintListPrice(e.target.value.trim())} aria-label="Price in SUI" />
          <TxButton
            className="small-button"
            txId={txIds['mint-list']}
            disabled={toMist(mintListPrice) <= 0n}
            onClick={() =>
              run('mint-list', `Mint & list for ${mintListPrice} SUI`, () =>
                mintAndListTransaction(sui.kiosk, deployment, sui.address, toMist(mintListPrice)),
              )
            }
          >
            Mint & list
          </TxButton>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {Boolean(data.error) && <p className="error">{describeError(data.error)}</p>}
      <div className="tokens">
        {(data.data?.listed ?? []).map((listing) => (
          <TokenCard key={listing.objectId} metadata={{ name: listing.name, description: '', image: listing.image }}>
            <div className="price">Listed · {formatSui(listing.priceMist)}</div>
            <TxButton
              className="secondary"
              txId={txIds[`delist-${listing.objectId}`]}
              onClick={() =>
                run(`delist-${listing.objectId}`, `Delist ${listing.name}`, () =>
                  delistTransaction(sui.kiosk, deployment, sui.address, listing.objectId),
                )
              }
            >
              Delist
            </TxButton>
          </TokenCard>
        ))}
        {(data.data?.owned ?? []).map((nft) => {
          const price = prices[nft.objectId] ?? ''
          return (
            <TokenCard key={nft.objectId} metadata={{ name: nft.name, description: '', image: nft.image }}>
              <input inputMode="decimal" placeholder="Price in SUI" value={price} onChange={(e) => setPrices((m) => ({ ...m, [nft.objectId]: e.target.value.trim() }))} />
              <TxButton
                txId={txIds[`list-${nft.objectId}`]}
                disabled={toMist(price) <= 0n}
                onClick={() =>
                  run(`list-${nft.objectId}`, `List ${nft.name} for ${price} SUI`, () =>
                    listTransaction(sui.kiosk, deployment, sui.address, nft.objectId, toMist(price)),
                  )
                }
              >
                List in kiosk
              </TxButton>
            </TokenCard>
          )
        })}
      </div>
      {!data.loading && (data.data?.owned.length ?? 0) + (data.data?.listed.length ?? 0) === 0 && (
        <p className="muted">No Omni Sui NFTs yet. Mint one.</p>
      )}
    </section>
  )
}
