import { omniNftAbi, parseTokenUri, type TokenMetadata } from '@omnimarket/contracts'
import { useEffect, useState } from 'react'
import type { Address, PublicClient } from 'viem'
import workerUrl from '../workers/metadata.worker?worker&url'
import type { MetadataRequest, MetadataResponse } from '../workers/metadata.worker'
import { useMarket } from './useMarket'

/** Fewer URIs than this parse faster on the main thread than the round trip to a worker. */
const WORKER_FROM = 24
const MAX_BATCH = 200
const BATCH_WINDOW_MS = 16
const CACHE_LIMIT = 5000

let worker: Worker | null | undefined
let nextRequest = 0
const waiting = new Map<number, (results: readonly (TokenMetadata | null)[]) => void>()

/**
 * Workers must be same-origin with the page. Standalone they are; as a micro-frontend our chunks come
 * from the remote's origin while the page is the shell's, so `new Worker(url)` throws. A same-origin
 * blob that `import`s the real script works (the remote serves it with CORS).
 */
function spawnWorker(): Worker | null {
  if (worker !== undefined) return worker
  try {
    const url = new URL(workerUrl, import.meta.url)
    worker =
      url.origin === location.origin
        ? new Worker(url, { type: 'module' })
        : new Worker(URL.createObjectURL(new Blob([`import ${JSON.stringify(url.href)}`], { type: 'text/javascript' })), { type: 'module' })
    worker.onmessage = ({ data }: MessageEvent<MetadataResponse>) => {
      waiting.get(data.id)?.(data.results)
      waiting.delete(data.id)
    }
    worker.onerror = () => {
      // Fall back to the main thread for good; pending requests are re-parsed there.
      worker = null
      for (const [, resolve] of waiting) resolve([])
      waiting.clear()
    }
  } catch {
    worker = null
  }
  return worker
}

/** `parseTokenUri` for many URIs, in a worker when it pays off. Same results either way. */
export async function parseTokenUris(uris: readonly (string | null)[]): Promise<(TokenMetadata | null)[]> {
  const parseHere = () => uris.map((uri) => (uri === null ? null : parseTokenUri(uri)))
  const target = uris.length >= WORKER_FROM ? spawnWorker() : null
  if (!target) return parseHere()
  const id = ++nextRequest
  const results = await new Promise<readonly (TokenMetadata | null)[]>((resolve) => {
    waiting.set(id, resolve)
    target.postMessage({ id, uris } satisfies MetadataRequest)
  })
  return results.length === uris.length ? [...results] : parseHere()
}

interface Loader {
  peek(tokenId: bigint): TokenMetadata | null | undefined
  load(tokenId: bigint): Promise<TokenMetadata | null>
}

const loaders = new Map<string, Loader>()

/**
 * Metadata on demand, for the cards actually on screen (the grid is windowed). Requests made within
 * one frame are batched into one multicall; results are cached. A 10 000-token wallet fetches a few
 * dozen URIs to show its first screen, not 10 000.
 */
function loaderFor(client: PublicClient, nft: Address): Loader {
  const key = `${client.chain?.id}:${nft}`
  let loader = loaders.get(key)
  if (loader) return loader

  const cache = new Map<string, TokenMetadata | null>()
  const inFlight = new Map<string, Promise<TokenMetadata | null>>()
  let queue: { id: bigint; resolve: (value: TokenMetadata | null) => void }[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = async () => {
    timer = null
    const batch = queue.splice(0, MAX_BATCH)
    if (queue.length) timer = setTimeout(flush, 0)
    try {
      const uris = await client.multicall({
        contracts: batch.map(({ id }) => ({ address: nft, abi: omniNftAbi, functionName: 'tokenURI', args: [id] }) as const),
        allowFailure: true,
        deployless: !client.chain?.contracts?.multicall3,
      })
      const parsed = await parseTokenUris(uris.map((u) => (u.status === 'success' ? (u.result as string) : null)))
      batch.forEach(({ id, resolve }, i) => {
        const value = parsed[i] ?? null
        cache.set(id.toString(), value)
        if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
        resolve(value)
      })
    } catch {
      // Not cached: the card shows its placeholder now and retries when it mounts again.
      for (const { resolve } of batch) resolve(null)
    } finally {
      for (const { id } of batch) inFlight.delete(id.toString())
    }
  }

  loader = {
    peek: (tokenId) => cache.get(tokenId.toString()),
    load(tokenId) {
      const id = tokenId.toString()
      if (cache.has(id)) return Promise.resolve(cache.get(id)!)
      let promise = inFlight.get(id)
      if (!promise) {
        promise = new Promise((resolve) => queue.push({ id: tokenId, resolve }))
        inFlight.set(id, promise)
        timer ??= setTimeout(flush, BATCH_WINDOW_MS)
      }
      return promise
    },
  }
  loaders.set(key, loader)
  return loader
}

/** `undefined` while loading, `null` when the token has no usable metadata. */
export function useTokenMetadata(tokenId: bigint): TokenMetadata | null | undefined {
  const { client, deployment } = useMarket()
  const loader = client && deployment ? loaderFor(client, deployment.OmniNFT) : undefined
  const [state, setState] = useState(() => ({ tokenId, value: loader?.peek(tokenId) }))
  const value = state.tokenId === tokenId ? state.value : loader?.peek(tokenId)

  useEffect(() => {
    if (!loader || loader.peek(tokenId) !== undefined) return
    let live = true
    void loader.load(tokenId).then((metadata) => live && setState({ tokenId, value: metadata }))
    return () => {
      live = false
    }
  }, [loader, tokenId])
  return value
}
