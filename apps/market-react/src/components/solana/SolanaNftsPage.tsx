import { parseTokenUri } from '@omnimarket/contracts'
import {
  coreErrorName,
  createAssetInstruction,
  fetchAssetsByOwner,
  transferAssetInstruction,
  type CoreAsset,
} from '@omnimarket/contracts/solana'
import { useSolanaTxEngine } from '@omnimarket/react'
import { SOLANA_LOCALNET } from '@omnimarket/wallet-core/solana'
import { generateKeyPairSigner, isAddress, lamports, type Address, type Instruction, type TransactionSigner } from '@solana/kit'
import { useState } from 'react'
import { formatUnits } from 'viem'
import { networkName, registerProgramErrors } from '@omnimarket/app-core'
import { describeError, describeTxError } from '../../errors'
import { useLoader } from '../../lib/useLoader'
import { useSolana } from '../../lib/useChain'
import { TokenCard } from '../TokenCard'
import { TxButton } from '../TxButton'

registerProgramErrors(coreErrorName)

/** On-chain JSON metadata (no IPFS for the demo); the same sanitizing parser as on EVM reads it back. */
function metadataUri(n: number): string {
  const hue = (n * 47) % 360
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="hsl(${hue},70%,55%)"/><text x="50" y="58" font-size="16" text-anchor="middle" fill="#fff" font-family="monospace">SOL #${n}</text></svg>`
  const json = JSON.stringify({
    name: `Omni Solana #${n}`,
    description: 'OmniMarket demo asset (Metaplex Core)',
    image: `data:image/svg+xml;base64,${btoa(svg)}`,
  })
  return `data:application/json;base64,${btoa(json)}`
}

export function SolanaNftsPage() {
  const solana = useSolana()
  const engine = useSolanaTxEngine()
  const [txIds, setTxIds] = useState<Record<string, string>>({})
  const [recipients, setRecipients] = useState<Record<string, string>>({})
  const [error, setError] = useState<unknown>(null)

  const assets = useLoader(async () => (solana ? fetchAssetsByOwner(solana.rpc, solana.address) : []), [solana?.rpc, solana?.address])
  const balance = useLoader(async () => (solana ? (await solana.rpc.getBalance(solana.address).send()).value : 0n), [solana?.rpc, solana?.address])

  if (!solana) return null

  const run = async (key: string, label: string, instructions: Instruction[], signers: TransactionSigner[] = []) => {
    const id = crypto.randomUUID()
    setTxIds((m) => ({ ...m, [key]: id }))
    setError(null)
    const result = await engine.send({ id, label, connector: solana.connector, account: solana.account, instructions, signers })
    if (result.status === 'confirmed') {
      assets.reload()
      balance.reload()
    } else if (result.error) {
      setError(describeTxError(result.error))
    }
  }

  const mint = async () => {
    // The new asset account signs its own creation; the key is used once and discarded.
    const asset = await generateKeyPairSigner()
    const n = (assets.data?.length ?? 0) + 1
    await run(
      'mint',
      `Mint Omni Solana #${n}`,
      [createAssetInstruction({ payer: solana.address, owner: solana.address, asset: asset.address, name: `Omni Solana #${n}`, uri: metadataUri(n) })],
      [asset],
    )
  }

  const transfer = (asset: CoreAsset) => {
    const to = recipients[asset.address]?.trim() ?? ''
    if (!isAddress(to)) return setError('Enter a valid Solana address.')
    if (to === solana.address) return setError('That is your own address.')
    return run(`transfer-${asset.address}`, `Transfer ${asset.name}`, [
      transferAssetInstruction({ payer: solana.address, asset: asset.address, newOwner: to as Address }),
    ])
  }

  const airdrop = async () => {
    setError(null)
    try {
      await solana.rpc.requestAirdrop(solana.address, lamports(1_000_000_000n)).send()
      setTimeout(balance.reload, 1500)
    } catch (e) {
      setError(describeError(e))
    }
  }

  const list = assets.data ?? []
  return (
    <section className="stack">
      <div className="section-head">
        <h2>My Solana NFTs</h2>
        <div className="row wrap">
          <span className="muted small">
            {balance.data !== undefined ? `${formatUnits(balance.data, 9)} SOL` : '…'} · {networkName(solana.chain)}
          </span>
          {solana.chain === SOLANA_LOCALNET.caip && (
            <button className="secondary small-button" onClick={airdrop}>
              Airdrop 1 SOL
            </button>
          )}
          <TxButton txId={txIds.mint} onClick={mint}>
            Mint (Metaplex Core)
          </TxButton>
        </div>
      </div>
      <p className="muted small">
        Assets are read straight from the Core program (getProgramAccounts by owner), no indexer needed. Listing on Solana needs an
        escrow program and is out of scope for this phase.
      </p>
      {error !== null && <p className="error">{typeof error === 'string' ? error : describeError(error)}</p>}
      {!assets.loading && list.length === 0 && <p className="muted">No Core assets yet. Mint one.</p>}
      <div className="tokens">
        {list.map((asset) => (
          <TokenCard key={asset.address} metadata={parseTokenUri(asset.uri) ?? { name: asset.name, description: '', image: '' }}>
            <code className="small" title={asset.address}>
              {asset.address.slice(0, 6)}…{asset.address.slice(-4)}
            </code>
            <input
              placeholder="Recipient address"
              value={recipients[asset.address] ?? ''}
              onChange={(e) => setRecipients((m) => ({ ...m, [asset.address]: e.target.value }))}
            />
            <TxButton className="secondary" txId={txIds[`transfer-${asset.address}`]} onClick={() => transfer(asset)}>
              Transfer
            </TxButton>
          </TokenCard>
        ))}
      </div>
    </section>
  )
}
