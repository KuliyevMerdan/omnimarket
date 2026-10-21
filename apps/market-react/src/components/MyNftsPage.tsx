import { omniMarketAbi, omniNftAbi } from '@omnimarket/contracts'
import { useTxEngine } from '@omnimarket/react'
import { useEffect, useMemo, useState } from 'react'
import { formatEther, isAddressEqual } from 'viem'
import { describeError } from '../errors'
import { fetchOwnedTokens } from '../lib/nft'
import { fetchOrders, type ListedOrder } from '../lib/orders'
import { useLoader } from '../lib/useLoader'
import { useMarket } from '../lib/useMarket'
import { ListForm } from './ListForm'
import { NftCard } from './TokenCard'
import { TxButton } from './TxButton'
import { VirtualGrid } from './VirtualGrid'

export function MyNftsPage() {
  const engine = useTxEngine()
  const { chainId, chain, deployment, client, signer, address } = useMarket()
  const [amount, setAmount] = useState(1)
  const [txIds, setTxIds] = useState<Record<string, string>>({})
  const [listing, setListing] = useState<bigint | null>(null)

  const owned = useLoader(async () => {
    if (!client || !deployment || !address) return []
    // Ids only: each card loads its own metadata when it scrolls into view.
    return fetchOwnedTokens(client, deployment.OmniNFT, address, BigInt(deployment.startBlock))
  }, [client, deployment?.OmniNFT, address])

  const approval = useLoader(async () => {
    if (!client || !deployment || !address) return false
    return client.readContract({
      address: deployment.OmniNFT,
      abi: omniNftAbi,
      functionName: 'isApprovedForAll',
      args: [address, deployment.OmniMarket],
    })
  }, [client, deployment?.OmniNFT, address])

  const myOrders = useLoader(async (signal) => {
    if (!chainId || !address) return []
    return (await fetchOrders(chainId, signal)).filter((o) => isAddressEqual(o.order.seller, address))
  }, [chainId, address])

  const ordersByToken = useMemo(
    () => new Map((myOrders.data ?? []).map((o) => [o.order.tokenId.toString(), o] as const)),
    [myOrders.data],
  )

  // Transfers in or out of this account (mint, sale, gift) refresh the list without polling the UI.
  const reloadOwned = owned.reload
  const reloadOrders = myOrders.reload
  const reloadApproval = approval.reload
  useEffect(() => {
    if (!client || !deployment || !address) return
    const unwatchNft = client.watchContractEvent({
      address: deployment.OmniNFT,
      abi: omniNftAbi,
      onLogs: (logs) => {
        if (logs.some((l) => l.eventName === 'ApprovalForAll')) reloadApproval()
        if (
          logs.some(
            (l) => l.eventName === 'Transfer' && (isAddressEqual(l.args.from!, address) || isAddressEqual(l.args.to!, address)),
          )
        ) {
          reloadOwned()
          reloadOrders()
        }
      },
    })
    const unwatchMarket = client.watchContractEvent({ address: deployment.OmniMarket, abi: omniMarketAbi, onLogs: reloadOrders })
    return () => {
      unwatchNft()
      unwatchMarket()
    }
  }, [client, deployment, address, reloadOwned, reloadOrders, reloadApproval])

  if (!signer || !address || !chainId || !deployment) return null

  const run = (key: string, request: Omit<Parameters<typeof engine.writeContract>[0], 'id' | 'signer' | 'account' | 'chainId'>) => {
    const id = crypto.randomUUID()
    setTxIds((m) => ({ ...m, [key]: id }))
    return engine.writeContract({ ...request, id, signer, account: address, chainId } as Parameters<typeof engine.writeContract>[0])
  }

  const mint = () =>
    run('mint', {
      label: `Mint ${amount} Omni Genesis`,
      address: deployment.OmniNFT,
      abi: omniNftAbi,
      functionName: 'mint',
      args: [BigInt(amount)],
    })

  const revoke = () =>
    run('revoke', {
      label: 'Revoke OmniMarket approval',
      address: deployment.OmniNFT,
      abi: omniNftAbi,
      functionName: 'setApprovalForAll',
      args: [deployment.OmniMarket, false],
    })

  const cancelAll = () =>
    run('cancel-all', {
      label: 'Cancel all listings',
      address: deployment.OmniMarket,
      abi: omniMarketAbi,
      functionName: 'incrementNonce',
    })

  const cancelListing = (listed: ListedOrder) =>
    run(`cancel-${listed.hash}`, {
      label: `Cancel listing of Omni #${listed.order.tokenId}`,
      address: deployment.OmniMarket,
      abi: omniMarketAbi,
      functionName: 'cancelOrder',
      args: [listed.order],
    })

  const tokens = owned.data ?? []
  return (
    <section className="stack">
      <div className="section-head">
        <h2>My NFTs</h2>
        <div className="row wrap">
          <select value={amount} onChange={(e) => setAmount(Number(e.target.value))} aria-label="Amount to mint">
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <TxButton txId={txIds.mint} onClick={mint}>
            Mint
          </TxButton>
        </div>
      </div>

      {approval.data && (
        <div className="notice">
          <span>
            OmniMarket can transfer your Omni Genesis NFTs (needed for listings).{' '}
            {ordersByToken.size > 0 && 'Revoking makes your listings unfillable.'}
          </span>
          <TxButton className="secondary small-button" txId={txIds.revoke} onClick={revoke}>
            Revoke
          </TxButton>
        </div>
      )}
      {ordersByToken.size > 1 && (
        <div className="notice">
          <span>{ordersByToken.size} open listings. One transaction voids every signature you have given.</span>
          <TxButton className="secondary small-button" txId={txIds['cancel-all']} onClick={cancelAll}>
            Cancel all
          </TxButton>
        </div>
      )}

      {listing !== null && (
        <ListForm
          tokenId={listing}
          approved={approval.data === true}
          previous={ordersByToken.get(listing.toString())}
          onClose={() => setListing(null)}
          onListed={() => {
            setListing(null)
            approval.reload()
            myOrders.reload()
          }}
        />
      )}

      {Boolean(owned.error) && <p className="error">{describeError(owned.error)}</p>}
      {!owned.loading && tokens.length === 0 && <p className="muted">You don’t own any Omni Genesis tokens yet. Mint one.</p>}
      <VirtualGrid
        items={tokens}
        getKey={(tokenId) => tokenId.toString()}
        renderItem={(tokenId) => {
          const listed = ordersByToken.get(tokenId.toString())
          return (
            <NftCard tokenId={tokenId}>
              {listed ? (
                <>
                  <div className="price">
                    Listed · {formatEther(listed.order.price)} {chain?.nativeCurrency.symbol}
                  </div>
                  <div className="row">
                    <button className="secondary small-button" onClick={() => setListing(tokenId)}>
                      Change price
                    </button>
                    <TxButton className="secondary small-button" txId={txIds[`cancel-${listed.hash}`]} onClick={() => cancelListing(listed)}>
                      Cancel
                    </TxButton>
                  </div>
                </>
              ) : (
                <button onClick={() => setListing(tokenId)}>List for sale</button>
              )}
            </NftCard>
          )
        }}
      />
    </section>
  )
}
