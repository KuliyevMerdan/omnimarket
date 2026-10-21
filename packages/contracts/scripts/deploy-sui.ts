/**
 * Publishes the omni_nft Move package and records ids in deployments/sui.json.
 *
 *   pnpm deploy:sui                                              # localnet (`pnpm dev:sui`), faucet-funded key
 *   SUI_NETWORK=testnet SUI_PRIVATE_KEY=suiprivkey… pnpm deploy:sui   # your own funded key
 */
import { requestSuiFromFaucetV2 } from '@mysten/sui/faucet'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publishOmniNft } from './sui-publish'

const network = (process.env.SUI_NETWORK ?? 'localnet') as 'localnet' | 'testnet' | 'devnet' | 'mainnet'
const baseUrl = process.env.SUI_RPC_URL ?? (network === 'localnet' ? 'http://127.0.0.1:9000' : `https://fullnode.${network}.sui.io:443`)
const client = new SuiGrpcClient({ baseUrl, network })

let signer: Ed25519Keypair
if (process.env.SUI_PRIVATE_KEY) {
  signer = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY)
} else if (network === 'localnet') {
  signer = new Ed25519Keypair()
  await requestSuiFromFaucetV2({ host: process.env.SUI_FAUCET_URL ?? 'http://127.0.0.1:9123', recipient: signer.toSuiAddress() })
} else {
  throw new Error(`SUI_PRIVATE_KEY is required for ${network}`)
}

const deployment = await publishOmniNft(client, signer)
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'deployments', 'sui.json')
const all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
all[network] = deployment
writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`)
console.log(`omni_nft on ${network}:`, deployment)
