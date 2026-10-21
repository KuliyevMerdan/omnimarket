import { omniNftAbi } from '@omnimarket/contracts'
import { isAddressEqual, type Address, type PublicClient } from 'viem'

/**
 * `eth_getLogs` over a block range, split into chunks. Public RPCs cap the range (often 10k blocks)
 * or the result size; on any error the chunk is halved and retried, down to a single block.
 */
export async function getLogsChunked<T>(
  fetchRange: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  fromBlock: bigint,
  toBlock: bigint,
  initialChunk = 10_000n,
): Promise<T[]> {
  const out: T[] = []
  let from = fromBlock
  let chunk = initialChunk
  while (from <= toBlock) {
    const to = from + chunk - 1n < toBlock ? from + chunk - 1n : toBlock
    try {
      out.push(...(await fetchRange(from, to)))
      from = to + 1n
    } catch (error) {
      if (chunk <= 1n) throw error
      chunk /= 2n
    }
  }
  return out
}

/**
 * Tokens owned by `owner`, rebuilt from Transfer events (the collection is not ERC721Enumerable),
 * then confirmed with `ownerOf` — cheap insurance against reorged or missed logs.
 */
export async function fetchOwnedTokens(
  client: PublicClient,
  nft: Address,
  owner: Address,
  startBlock: bigint,
): Promise<bigint[]> {
  const head = await client.getBlockNumber()
  const range = (args: { to: Address } | { from: Address }) =>
    getLogsChunked(
      (fromBlock, toBlock) =>
        client.getContractEvents({ address: nft, abi: omniNftAbi, eventName: 'Transfer', args, fromBlock, toBlock }),
      startBlock,
      head,
    )
  const [received, sent] = await Promise.all([range({ to: owner }), range({ from: owner })])

  const seen = new Set<string>()
  const events = [...received, ...sent]
    .filter((log) => {
      const key = `${log.transactionHash}:${log.logIndex}`
      if (seen.has(key)) return false // self-transfers appear in both queries
      seen.add(key)
      return true
    })
    .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))

  const owned = new Set<bigint>()
  for (const { args } of events) {
    if (isAddressEqual(args.to!, owner)) owned.add(args.tokenId!)
    else owned.delete(args.tokenId!)
  }

  const ids = [...owned]
  if (ids.length === 0) return []
  const owners = await client.multicall({
    contracts: ids.map((id) => ({ address: nft, abi: omniNftAbi, functionName: 'ownerOf', args: [id] }) as const),
    allowFailure: true,
    deployless: !client.chain?.contracts?.multicall3,
  })
  return ids
    .filter((_, i) => owners[i]?.status === 'success' && isAddressEqual(owners[i].result as Address, owner))
    .sort((a, b) => (a < b ? -1 : 1))
}
