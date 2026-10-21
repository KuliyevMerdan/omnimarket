import type { ClientWithCoreApi } from '@mysten/sui/client'
import type { Keypair } from '@mysten/sui/cryptography'
import { Transaction } from '@mysten/sui/transactions'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SuiDeployment } from '../ts/sui/omni'

export const OMNI_NFT_PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'move', 'omni_nft')

/** Compiles the Move package to base64 modules (no `sui client` setup or active env needed for publishing). */
export function buildMovePackage(path = OMNI_NFT_PACKAGE): { modules: string[]; dependencies: string[] } {
  const output = execFileSync('sui', ['move', 'build', '--dump-bytecode-as-base64', '--path', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // The JSON is the last line; warnings may precede it.
  return JSON.parse(output.trim().split('\n').at(-1)!)
}

/** Publishes omni_nft and returns the ids the dApp needs (package, shared Registry, TransferPolicy). */
export async function publishOmniNft(client: ClientWithCoreApi, signer: Keypair): Promise<SuiDeployment> {
  const { modules, dependencies } = buildMovePackage()
  const tx = new Transaction()
  const upgradeCap = tx.publish({ modules, dependencies })
  tx.transferObjects([upgradeCap], signer.toSuiAddress())

  const result = await client.core.signAndExecuteTransaction({
    transaction: tx,
    signer,
    include: { effects: true, objectTypes: true },
  })
  if (result.$kind !== 'Transaction') throw new Error(`Publish failed: ${result.FailedTransaction.status.error?.message}`)
  const { effects, objectTypes, digest } = result.Transaction
  await client.core.waitForTransaction({ digest })

  const created = effects.changedObjects.filter((o) => o.idOperation === 'Created')
  const packageId = created.find((o) => o.outputState === 'PackageWrite')?.objectId
  const byType = (suffix: string) => created.find((o) => objectTypes[o.objectId]?.includes(suffix))?.objectId
  const registryId = byType('::omni_nft::Registry')
  const policyId = byType('::transfer_policy::TransferPolicy<')
  if (!packageId || !registryId || !policyId) throw new Error('Publish succeeded but expected objects were not created')
  return { packageId, registryId, policyId }
}
