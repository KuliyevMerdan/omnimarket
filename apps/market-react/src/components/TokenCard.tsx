import type { TokenMetadata } from '@omnimarket/contracts'
import type { ReactNode } from 'react'
import { useTokenMetadata } from '../lib/metadata'

/**
 * Metadata is attacker-controlled. Only `parseTokenUri`-sanitized image URLs reach `<img src>`;
 * names render as text. Nothing here uses innerHTML.
 */
export function TokenCard({
  tokenId,
  metadata,
  children,
}: {
  tokenId?: bigint
  metadata: TokenMetadata | null | undefined
  children?: ReactNode
}) {
  const label = tokenId !== undefined ? `#${tokenId}` : (metadata?.name.match(/#\d+$/)?.[0] ?? '?')
  return (
    <article className="token">
      {metadata?.image ? (
        <img className="token-image" src={metadata.image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
      ) : (
        <div className="token-image token-image-empty">{label}</div>
      )}
      <div className="token-body">
        <div className="token-name">{metadata?.name || `Token ${label}`}</div>
        {children}
      </div>
    </article>
  )
}

/** An Omni Genesis token whose metadata loads when the card is on screen (see `useTokenMetadata`). */
export function NftCard({ tokenId, children }: { tokenId: bigint; children?: ReactNode }) {
  return (
    <TokenCard tokenId={tokenId} metadata={useTokenMetadata(tokenId)}>
      {children}
    </TokenCard>
  )
}
