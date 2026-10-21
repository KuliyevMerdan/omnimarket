/// <reference lib="webworker" />
/**
 * Decodes and sanitizes token URIs off the main thread. On-chain metadata is base64 JSON, often with a
 * base64 SVG inside: a few KB per token, tens of MB for a large wallet, all of it decode + JSON.parse.
 */
import { parseTokenUri, type TokenMetadata } from '@omnimarket/contracts'

export interface MetadataRequest {
  readonly id: number
  readonly uris: readonly (string | null)[]
}

export interface MetadataResponse {
  readonly id: number
  readonly results: readonly (TokenMetadata | null)[]
}

self.onmessage = ({ data }: MessageEvent<MetadataRequest>) => {
  const results = data.uris.map((uri) => (uri === null ? null : parseTokenUri(uri)))
  self.postMessage({ id: data.id, results } satisfies MetadataResponse)
}
