import { checkOrders, omniMarketAbi } from '@omnimarket/contracts'
import { useTxEngine } from '@omnimarket/react'
import { useEffect, useState } from 'react'
import { formatEther, isAddressEqual } from 'viem'
import { describeError } from '../errors'
import { fetchMetadata } from '../lib/nft'
import { fetchOrders, type ListedOrder } from '../lib/orders'
import { useLoader } from '../lib/useLoader'
import { useMarket } from '../lib/useMarket'
import { TokenCard } from './TokenCard'
import { TxButton } from './TxButton'

export function MarketPage() {
  const engine = useTxEngine()
  const { chainId, chain, deployment, client, signer, address } = useMarket()
  const [txByOrder, setTxByOrder] = useState<Record<string, string>>({})

  const listings = useLoader(
    async (signal) => {
      if (!chainId || !deployment || !client) return []
      const listed = await fetchOrders(chainId, signal)
      // Never trust the order book: re-check every order against the chain before showing "Buy".
      const statuses = await checkOrders(client, chainId, deployment.OmniMarket, listed.map((l) => l.order))
      const active = listed.filter((_, i) => statuses[i] === 'active')
      const metadata = await fetchMetadata(client, deployment.OmniNFT, active.map((l) => l.order.tokenId))
      return active.map((listing) => ({ listing, metadata: metadata.get(listing.order.tokenId.toString()) }))
    },
    [chainId, deployment?.OmniMarket],
  )

  // Live updates: any fill/cancel/nonce bump may hide a listing.
  const { reload } = listings
  useEffect(() => {
    if (!client || !deployment) return
    return client.watchContractEvent({ address: deployment.OmniMarket, abi: omniMarketAbi, onLogs: reload })
  }, [client, deployment, reload])

  const buy = async ({ hash, order, signature }: ListedOrder) => {
    if (!signer || !address || !chainId || !deployment) return
    const id = crypto.randomUUID()
    setTxByOrder((m) => ({ ...m, [hash]: id }))
    const done = engine.writeContract({
      id,
      signer,
      account: address,
      chainId,
      label: `Buy Omni #${order.tokenId} for ${formatEther(order.price)} ${chain?.nativeCurrency.symbol ?? 'ETH'}`,
      address: deployment.OmniMarket,
      abi: omniMarketAbi,
      functionName: 'fillOrder',
      args: [order, signature],
      value: order.price,
    })
    if ((await done).status === 'confirmed') reload()
  }

  const items = listings.data ?? []
  return (
    <section className="stack">
      <div className="section-head">
        <h2>Listings on {chain?.name}</h2>
        <button className="secondary small-button" onClick={reload} disabled={listings.loading}>
          {listings.loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {Boolean(listings.error) && <p className="error">{describeError(listings.error)}</p>}
      {!listings.loading && items.length === 0 && (
        <p className="muted">No active listings. List one of your NFTs from “My NFTs”.</p>
      )}
      <div className="tokens">
        {items.map(({ listing, metadata }) => {
          const mine = !!address && isAddressEqual(listing.order.seller, address)
          return (
            <TokenCard key={listing.hash} tokenId={listing.order.tokenId} metadata={metadata}>
              <div className="price">
                {formatEther(listing.order.price)} {chain?.nativeCurrency.symbol}
              </div>
              <div className="muted small">
                {mine ? 'Your listing' : `Seller ${listing.order.seller.slice(0, 6)}…${listing.order.seller.slice(-4)}`} · until{' '}
                {new Date(Number(listing.order.deadline) * 1000).toLocaleDateString()}
              </div>
              {!mine && (
                <TxButton txId={txByOrder[listing.hash]} onClick={() => buy(listing)}>
                  Buy
                </TxButton>
              )}
            </TokenCard>
          )
        })}
      </div>
    </section>
  )
}
