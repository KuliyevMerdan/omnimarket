import { KioskClient, KioskTransaction } from '@mysten/kiosk'
import type { ClientWithCoreApi, SuiClientTypes } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'
import { normalizeStructTag } from '@mysten/sui/utils'
import { sanitizeImageUrl } from '../metadata'
import deploymentsJson from '../../deployments/sui.json'

export interface SuiDeployment {
  readonly packageId: string
  readonly registryId: string
  readonly policyId: string
}

const deployments = deploymentsJson as Readonly<Record<string, SuiDeployment>>

/** Keyed by Sui network name: `localnet`, `testnet`, … */
export function getSuiDeployment(network: string): SuiDeployment | undefined {
  return deployments[network]
}

export const nftType = (packageId: string) => `${packageId}::omni_nft::OmniNft`

export function createKioskClient(client: ClientWithCoreApi, network: SuiClientTypes.Network): KioskClient {
  return new KioskClient({ client, network })
}

export function mintTransaction(deployment: SuiDeployment, amount: number): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${deployment.packageId}::omni_nft::mint`,
    arguments: [tx.object(deployment.registryId), tx.pure.u64(amount)],
  })
  return tx
}

/** Kiosk of `owner`, or a new one created inside `tx` (shared and its cap sent to `owner` on finalize). */
async function ownerKiosk(kioskClient: KioskClient, tx: Transaction, owner: string): Promise<{ kioskTx: KioskTransaction; created: boolean }> {
  const { kioskOwnerCaps } = await kioskClient.getOwnedKiosks({ address: owner })
  const cap = kioskOwnerCaps.find((c) => !c.isPersonal)
  if (cap) return { kioskTx: new KioskTransaction({ transaction: tx, kioskClient, cap }), created: false }
  return { kioskTx: new KioskTransaction({ transaction: tx, kioskClient }).create(), created: true }
}

/**
 * Mint and list in ONE programmable transaction: `mint_one` returns the object and its result
 * feeds `kiosk::place_and_list` directly. Composability is why `mint_one` returns instead of
 * transferring to the sender.
 */
export async function mintAndListTransaction(
  kioskClient: KioskClient,
  deployment: SuiDeployment,
  owner: string,
  priceMist: bigint,
): Promise<Transaction> {
  const tx = new Transaction()
  const nft = tx.moveCall({ target: `${deployment.packageId}::omni_nft::mint_one`, arguments: [tx.object(deployment.registryId)] })
  const { kioskTx, created } = await ownerKiosk(kioskClient, tx, owner)
  kioskTx.placeAndList({ itemType: nftType(deployment.packageId), item: nft, price: priceMist })
  if (created) kioskTx.shareAndTransferCap(owner)
  kioskTx.finalize()
  return tx
}

export async function listTransaction(
  kioskClient: KioskClient,
  deployment: SuiDeployment,
  owner: string,
  itemId: string,
  priceMist: bigint,
): Promise<Transaction> {
  const tx = new Transaction()
  const { kioskTx, created } = await ownerKiosk(kioskClient, tx, owner)
  kioskTx.placeAndList({ itemType: nftType(deployment.packageId), item: itemId, price: priceMist })
  if (created) kioskTx.shareAndTransferCap(owner)
  kioskTx.finalize()
  return tx
}

/** Delist and take the item back to the wallet. */
export async function delistTransaction(kioskClient: KioskClient, deployment: SuiDeployment, owner: string, itemId: string) {
  const tx = new Transaction()
  const { kioskTx } = await ownerKiosk(kioskClient, tx, owner)
  const itemType = nftType(deployment.packageId)
  kioskTx.delist({ itemType, itemId })
  const item = kioskTx.take({ itemType, itemId })
  tx.transferObjects([item], owner)
  kioskTx.finalize()
  return tx
}

/**
 * `kiosk::purchase` returns the item plus a hot-potato `TransferRequest` that MUST be confirmed
 * against the type's `TransferPolicy` in the same transaction. Our policy has no rules, so we
 * confirm it and send the item straight to the buyer's wallet (no buyer kiosk needed).
 */
export function purchaseTransaction(
  deployment: SuiDeployment,
  buyer: string,
  listing: Pick<SuiListing, 'kioskId' | 'objectId' | 'priceMist'>,
): Transaction {
  const tx = new Transaction()
  const itemType = nftType(deployment.packageId)
  // Plain move calls: the SDK's KioskTransaction insists on a buyer kiosk we don't need.
  const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(listing.priceMist)])
  const [item, request] = tx.moveCall({
    target: '0x2::kiosk::purchase',
    typeArguments: [itemType],
    arguments: [tx.object(listing.kioskId), tx.pure.id(listing.objectId), payment!],
  })
  tx.moveCall({
    target: '0x2::transfer_policy::confirm_request',
    typeArguments: [itemType],
    arguments: [tx.object(deployment.policyId), request!],
  })
  tx.transferObjects([item!], buyer)
  return tx
}

export interface SuiNft {
  readonly objectId: string
  readonly name: string
  readonly image: string
}

export interface SuiListing extends SuiNft {
  readonly kioskId: string
  readonly priceMist: bigint
  readonly seller?: string
}

/**
 * Metadata via the type's Display template; nodes that don't render Display (e.g. a local network)
 * fall back to the object's own fields, which our type names the same way.
 */
function fromDisplay(
  objectId: string,
  display: Record<string, unknown> | null | undefined,
  json?: Record<string, unknown> | null,
): SuiNft {
  // Per field: a Display template can render some fields and fail on others.
  const output = { ...(json ?? {}), ...Object.fromEntries(Object.entries(display ?? {}).filter(([, v]) => typeof v === 'string' && v)) }
  const name = typeof output?.name === 'string' ? output.name.slice(0, 200) : ''
  const image = typeof output?.image_url === 'string' ? sanitizeImageUrl(output.image_url) : ''
  return { objectId, name, image }
}

/** NFTs held directly in the wallet (not in a kiosk), rendered through the type's Display. */
export async function fetchOwnedNfts(client: ClientWithCoreApi, owner: string, deployment: SuiDeployment): Promise<SuiNft[]> {
  const { objects } = await client.core.listOwnedObjects({
    owner,
    type: nftType(deployment.packageId),
    include: { display: true, json: true },
  })
  return objects.map((o) => fromDisplay(o.objectId, o.display?.output, o.json))
}

/**
 * Listings discovered from `ItemListed<OmniNft>` events, then confirmed against the current kiosk
 * state: an event says "was listed", not "is still listed" (it may have been sold or delisted).
 */
export async function fetchListings(
  client: ClientWithCoreApi,
  kioskClient: KioskClient,
  deployment: SuiDeployment,
  limit = 50,
): Promise<SuiListing[]> {
  const type = nftType(deployment.packageId)
  const { events } = await client.core.listEvents({
    // gRPC filters want fully-normalized addresses (`0x000…02`, not `0x2`).
    filter: { eventType: normalizeStructTag(`0x2::kiosk::ItemListed<${type}>`) },
    limit,
    order: 'descending',
  })
  // Newest event per item wins: relisting at a new price emits a new ItemListed.
  const latest = new Map<string, { kioskId: string; priceMist: bigint }>()
  for (const event of events) {
    const json = event.json as { id?: unknown; kiosk?: unknown; price?: unknown } | null
    if (typeof json?.id !== 'string' || typeof json.kiosk !== 'string' || latest.has(json.id)) continue
    latest.set(json.id, { kioskId: json.kiosk, priceMist: BigInt(String(json.price ?? 0)) })
  }
  const kioskIds = [...new Set([...latest.values()].map((l) => l.kioskId))]

  // The kiosk state answers "is it still listed?"; the price comes from the event (the SDK's
  // listing-price decoding is unreliable on the gRPC transport).
  const kiosks = await Promise.all(
    kioskIds.map((id) =>
      kioskClient
        .getKiosk({ id, options: { withListingPrices: true, withKioskFields: true } })
        .then((data) => ({ id, data }))
        .catch(() => null),
    ),
  )
  const listed = kiosks.flatMap((entry) =>
    entry
      ? entry.data.items
          .filter((item) => item.type === type && item.listing !== undefined && !item.isLocked && latest.get(item.objectId)?.kioskId === entry.id)
          .map((item) => ({ objectId: item.objectId, kioskId: entry.id, priceMist: latest.get(item.objectId)!.priceMist, seller: entry.data.kiosk?.owner }))
      : [],
  )
  if (listed.length === 0) return []
  // One batched read for metadata of every listed item.
  const { objects } = await client.core.getObjects({ objectIds: listed.map((l) => l.objectId), include: { display: true, json: true } })
  return listed.map((l, i) => {
    const object = objects[i]
    const meta = object && !(object instanceof Error) ? fromDisplay(l.objectId, object.display?.output, object.json) : fromDisplay(l.objectId, null)
    return { ...meta, ...l }
  })
}
