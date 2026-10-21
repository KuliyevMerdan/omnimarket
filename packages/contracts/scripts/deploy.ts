/**
 * Deploys OmniMarket + OmniNFT and records addresses in deployments/index.json.
 *
 *   pnpm deploy:local                                   # anvil on :8545, well-known anvil key #0
 *   RPC_URL=… DEPLOYER_PRIVATE_KEY=… pnpm deploy        # Sepolia / Amoy, your own funded key
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, getAddress, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { omniMarketAbi, omniNftAbi } from '../ts/generated/abis'
import { omniMarketBytecode, omniNftBytecode } from '../ts/generated/bytecode'

// Anvil/Hardhat default account #0 — public test key, only valid on local chains.
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const rpcUrl = process.env.RPC_URL ?? 'http://127.0.0.1:8545'
const transport = http(rpcUrl)
const publicClient = createPublicClient({ transport })
const chainId = await publicClient.getChainId()

const key = (process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined) ?? (chainId === 31337 ? ANVIL_KEY : undefined)
if (!key) throw new Error(`DEPLOYER_PRIVATE_KEY is required for chain ${chainId}`)

const account = privateKeyToAccount(key)
const wallet = createWalletClient({ account, transport })
const chain = { id: chainId } as Parameters<typeof wallet.deployContract>[0]['chain']

async function deploy(name: string, abi: typeof omniMarketAbi | typeof omniNftAbi, bytecode: Hex) {
  const hash = await wallet.deployContract({ abi, bytecode, chain })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (!receipt.contractAddress) throw new Error(`${name} deployment failed`)
  console.log(`${name.padEnd(10)} ${receipt.contractAddress} (block ${receipt.blockNumber})`)
  return receipt
}

const market = await deploy('OmniMarket', omniMarketAbi, omniMarketBytecode)
const nft = await deploy('OmniNFT', omniNftAbi, omniNftBytecode)

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'deployments', 'index.json')
const all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
all[chainId] = {
  OmniMarket: getAddress(market.contractAddress!),
  OmniNFT: getAddress(nft.contractAddress!),
  // Event scans start here instead of genesis.
  startBlock: Number(market.blockNumber),
}
writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`)
console.log(`saved deployments/index.json [${chainId}]`)
