import { publishOmniNft } from '@omnimarket/contracts/sui-publish'
import {
  createKioskClient,
  fetchListings,
  fetchOwnedNfts,
  listTransaction,
  mintAndListTransaction,
  mintTransaction,
  purchaseTransaction,
  type SuiDeployment,
} from '@omnimarket/contracts/sui'
import { requestSuiFromFaucetV2 } from '@mysten/sui/faucet'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { createMemoryStorage } from '@omnimarket/wallet-core'
import { SUI_CHAINS, SuiConnector } from '@omnimarket/wallet-core/sui'
import { createMockSuiWallet } from '@omnimarket/wallet-core/testing'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SuiTxEngine, TxStore } from '../src'

const hasSui = spawnSync('sui', ['--version'], { stdio: 'ignore' }).status === 0
const RPC = 'http://127.0.0.1:19000'
const FAUCET = 'http://127.0.0.1:19123'

describe.skipIf(!hasSui)('SuiTxEngine on a Sui localnet with Kiosk', { timeout: 120_000 }, () => {
  let node: ChildProcess
  let deployment: SuiDeployment
  const client = new SuiGrpcClient({ baseUrl: RPC, network: 'localnet' })
  const kioskClient = createKioskClient(client, 'localnet')

  const fund = async (address: string) => {
    for (let i = 0; i < 20; i++) {
      try {
        await requestSuiFromFaucetV2({ host: FAUCET, recipient: address })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    for (let i = 0; i < 80; i++) {
      const { balance } = await client.core.getBalance({ owner: address }).catch(() => ({ balance: { balance: '0' } }))
      if (BigInt(balance.balance) > 0n) return
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error(`faucet did not fund ${address}`)
  }

  beforeAll(async () => {
    // --force-regenesis keeps the network in a temp dir that is removed on exit.
    node = spawn('sui', ['start', '--force-regenesis', '--with-faucet=127.0.0.1:19123', '--fullnode-rpc-port', '19000'], {
      stdio: 'ignore',
      env: { ...process.env, RUST_LOG: 'off' },
    })
    for (let i = 0; i < 240; i++) {
      if (await client.core.getChainIdentifier().catch(() => null)) break
      await new Promise((r) => setTimeout(r, 250))
    }
    const publisher = new Ed25519Keypair()
    await fund(publisher.toSuiAddress())
    deployment = await publishOmniNft(client, publisher)
  }, 120_000)

  afterAll(() => {
    node?.kill('SIGINT')
  })

  async function wallet() {
    const mock = createMockSuiWallet({ client })
    await fund(mock.address)
    const connector = new SuiConnector(mock.wallet, SUI_CHAINS)
    const { accounts } = await connector.connect({ chainId: 'sui:localnet' })
    return { mock, connector, account: accounts[0]!, address: mock.address }
  }

  const engine = () =>
    new SuiTxEngine({
      store: new TxStore({ storage: createMemoryStorage() }),
      getClient: () => client,
      pollingIntervalMs: 250,
      resubmitIntervalMs: 200,
    })

  it('mints through the engine, waits for the checkpoint and renders Display', async () => {
    const txs = engine()
    const w = await wallet()
    const result = await txs.send({ label: 'Mint', connector: w.connector, account: w.account, transaction: mintTransaction(deployment, 2) })

    expect(result).toMatchObject({ status: 'confirmed', checkpoint: expect.any(String) })
    expect(result.events?.map((e) => e.eventName)).toEqual(['Minted', 'Minted'])
    const owned = await fetchOwnedNfts(client, w.address, deployment)
    expect(owned).toHaveLength(2)
    expect(owned[0]!.name).toMatch(/^Omni Sui #\d+$/)
    expect(owned[0]!.image).toMatch(/^data:image\/svg\+xml,/)
  })

  it('stops at simulation with the clever error, before any wallet prompt', async () => {
    const txs = engine()
    const w = await wallet()
    const result = await txs.send({ label: 'Mint 6', connector: w.connector, account: w.account, transaction: mintTransaction(deployment, 6) })
    expect(result.error).toMatchObject({ kind: 'simulation_reverted', errorName: 'EInvalidAmount', message: 'Mint 1 to 5 at a time' })
    expect(w.mock.calls).not.toContain('sui:signTransaction')
  })

  it('lists in a kiosk, finds the listing from events, and sells it to another wallet', async () => {
    const txs = engine()
    const seller = await wallet()
    const buyer = await wallet()
    await txs.send({ label: 'Mint', connector: seller.connector, account: seller.account, transaction: mintTransaction(deployment, 1) })
    const [nft] = await fetchOwnedNfts(client, seller.address, deployment)

    const listed = await txs.send({
      label: 'List',
      connector: seller.connector,
      account: seller.account,
      transaction: await listTransaction(kioskClient, deployment, seller.address, nft!.objectId, 1_000_000n),
    })
    expect(listed.events?.map((e) => e.eventName)).toContain('ItemListed')

    const listing = (await fetchListings(client, kioskClient, deployment)).find((l) => l.objectId === nft!.objectId)
    expect(listing).toMatchObject({ priceMist: 1_000_000n, name: nft!.name })

    const bought = await txs.send({
      label: 'Buy',
      connector: buyer.connector,
      account: buyer.account,
      transaction: purchaseTransaction(deployment, buyer.address, listing!),
    })
    expect(bought.status).toBe('confirmed')
    expect((await fetchOwnedNfts(client, buyer.address, deployment)).map((n) => n.objectId)).toContain(nft!.objectId)
    expect((await fetchListings(client, kioskClient, deployment)).find((l) => l.objectId === nft!.objectId)).toBeUndefined()
  })

  it('mints and lists in one programmable transaction', async () => {
    const txs = engine()
    const seller = await wallet()
    const result = await txs.send({
      label: 'Mint & list',
      connector: seller.connector,
      account: seller.account,
      transaction: await mintAndListTransaction(kioskClient, deployment, seller.address, 2_000_000n),
    })
    expect(result.events?.map((e) => e.eventName)).toEqual(expect.arrayContaining(['Minted', 'ItemListed']))
    expect((await fetchListings(client, kioskClient, deployment)).some((l) => l.priceMist === 2_000_000n)).toBe(true)
  })

  it('reports a framework abort when paying less than the listing price', async () => {
    const txs = engine()
    const seller = await wallet()
    const buyer = await wallet()
    await txs.send({
      label: 'Mint & list',
      connector: seller.connector,
      account: seller.account,
      transaction: await mintAndListTransaction(kioskClient, deployment, seller.address, 5_000_000n),
    })
    const listing = (await fetchListings(client, kioskClient, deployment)).find((l) => l.priceMist === 5_000_000n)!
    const cheap = await txs.send({
      label: 'Buy cheap',
      connector: buyer.connector,
      account: buyer.account,
      transaction: purchaseTransaction(deployment, buyer.address, { ...listing, priceMist: 1n }),
    })
    expect(cheap.error).toMatchObject({ kind: 'simulation_reverted' })
    expect(cheap.error?.message).toMatch(/kiosk/)
  })

  it('survives a lost execute response: same digest, resubmitted, confirmed once', async () => {
    const txs = engine()
    const w = await wallet()
    const core = client.core as unknown as { executeTransaction: (...args: unknown[]) => Promise<unknown> }
    const original = core.executeTransaction
    core.executeTransaction = async () => {
      core.executeTransaction = original // only the first call "times out"
      throw new Error('fetch failed: socket hang up')
    }
    const result = await txs.send({ label: 'Mint', connector: w.connector, account: w.account, transaction: mintTransaction(deployment, 1) })
    expect(result.status).toBe('confirmed')
    expect(result.events?.filter((e) => e.eventName === 'Minted')).toHaveLength(1)
    expect(await fetchOwnedNfts(client, w.address, deployment)).toHaveLength(1)
  })
})
