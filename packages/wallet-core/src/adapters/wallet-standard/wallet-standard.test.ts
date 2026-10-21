import { verifyPersonalMessageSignature } from '@mysten/sui/verify'
import {
  appendTransactionMessageInstruction,
  createTransactionMessage,
  getBase58Encoder,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  verifySignature,
  type Address,
  type Blockhash,
  type SignatureBytes,
} from '@solana/kit'
import type { Wallet } from '@wallet-standard/base'
import { describe, expect, it } from 'vitest'
import { WalletManager } from '../../manager'
import { createMemoryStorage } from '../../storage'
import { createMockSolanaWallet, createMockSuiWallet } from '../../testing'
import type { WalletConnector } from '../../types'
import { createSolanaAdapter, isSolanaConnector, SOLANA_LOCALNET } from '../solana'
import { createSuiAdapter, isSuiConnector, SUI_LOCALNET } from '../sui'
import { createMemoryRegistry } from './registry'

function discover(adapter: ReturnType<typeof createSolanaAdapter>) {
  let list: readonly WalletConnector[] = []
  const stop = adapter.discover((next) => (list = next))
  return { get: () => list, stop }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('Wallet Standard discovery', () => {
  it('lists only wallets with the namespace and required features, including late registrations', async () => {
    const registry = createMemoryRegistry()
    const solana = await createMockSolanaWallet({ name: 'Phantom Mock' })
    const sui = createMockSuiWallet({ name: 'Slush Mock' })
    const evmOnly = { ...solana.wallet, name: 'EVM only', chains: ['eip155:1'] } as Wallet
    const noSigning = { ...solana.wallet, name: 'Watch only', features: { 'standard:connect': solana.wallet.features['standard:connect'] } } as Wallet

    registry.register(evmOnly)
    registry.register(noSigning)
    const found = discover(createSolanaAdapter({ registry }))
    await tick()
    expect(found.get()).toEqual([])

    const unregister = registry.register(solana.wallet)
    registry.register(sui.wallet)
    expect(found.get().map((c) => c.info.id)).toEqual(['solana:phantom-mock'])

    unregister()
    expect(found.get()).toEqual([])
  })

  it('keeps connector identity per wallet', async () => {
    const registry = createMemoryRegistry()
    const a = createMockSuiWallet({ name: 'A' })
    const b = createMockSuiWallet({ name: 'B' })
    const found = discover(createSuiAdapter({ registry }))
    await tick()
    registry.register(a.wallet)
    const first = found.get()[0]
    registry.register(b.wallet)
    expect(found.get()[0]).toBe(first)
  })
})

describe('SolanaConnector', () => {
  async function setup() {
    const registry = createMemoryRegistry()
    const mock = await createMockSolanaWallet()
    registry.register(mock.wallet)
    const found = discover(createSolanaAdapter({ registry }))
    await tick()
    const connector = found.get()[0]!
    if (!isSolanaConnector(connector)) throw new Error('expected a Solana connector')
    return { mock, connector }
  }

  it('connects with CAIP-10 accounts on the selected chain', async () => {
    const { mock, connector } = await setup()
    const connection = await connector.connect({ chainId: SOLANA_LOCALNET.caip })
    expect(connection).toEqual({ chainId: 'solana:localnet', accounts: [`solana:localnet:${mock.signer.address}`] })
  })

  it('signs messages with a verifiable ed25519 signature (base58)', async () => {
    const { mock, connector } = await setup()
    const { accounts } = await connector.connect()
    const signature = await connector.signMessage({ account: accounts[0]!, message: 'hello solana' })

    const publicKey = await getPublicKeyFromAddress(mock.signer.address)
    const bytes = new Uint8Array(getBase58Encoder().encode(signature)) as SignatureBytes
    expect(await verifySignature(publicKey, bytes, new TextEncoder().encode('hello solana'))).toBe(true)
  })

  it('refuses a signature over bytes the wallet rewrote', async () => {
    const { mock, connector } = await setup()
    const { accounts } = await connector.connect()
    const feature = mock.wallet.features['solana:signMessage'] as { signMessage: (...i: unknown[]) => Promise<unknown[]> }
    const original = feature.signMessage
    feature.signMessage = async (...inputs: unknown[]) => {
      const [out] = (await original(...inputs)) as { signature: Uint8Array }[]
      return [{ signedMessage: new TextEncoder().encode('prefix: hello'), signature: out!.signature }]
    }
    await expect(connector.signMessage({ account: accounts[0]!, message: 'hello' })).rejects.toThrow(/different message/)
  })

  it('normalizes rejection and unknown chains', async () => {
    const { mock, connector } = await setup()
    mock.rejectNextRequest()
    await expect(connector.connect()).rejects.toMatchObject({ code: 'USER_REJECTED' })
    await connector.connect()
    await expect(connector.switchChain('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).rejects.toMatchObject({
      code: 'UNRECOGNIZED_CHAIN',
    })
  })

  it('acts as a kit modifying signer for transaction messages', async () => {
    const { mock, connector } = await setup()
    const { accounts } = await connector.connect()
    const signer = connector.transactionSigner(accounts[0]!)
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 10n },
          m,
        ),
      (m) =>
        appendTransactionMessageInstruction(
          { programAddress: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' as Address, data: new TextEncoder().encode('hi') },
          m,
        ),
    )
    const signed = await signTransactionMessageWithSigners(message)
    expect(getSignatureFromTransaction(signed)).toBeTypeOf('string')
    expect(signed.signatures[mock.signer.address]).toBeInstanceOf(Uint8Array)
    expect(signed.lifetimeConstraint).toMatchObject({ lastValidBlockHeight: 10n })
  })
})

describe('SuiConnector', () => {
  it('signs personal messages that verify with intent domain separation', async () => {
    const registry = createMemoryRegistry()
    const mock = createMockSuiWallet()
    registry.register(mock.wallet)
    const found = discover(createSuiAdapter({ registry }))
    await tick()
    const connector = found.get()[0]!
    if (!isSuiConnector(connector)) throw new Error('expected a Sui connector')

    const { accounts, chainId } = await connector.connect({ chainId: SUI_LOCALNET.caip })
    expect(chainId).toBe('sui:localnet')
    const signature = await connector.signMessage({ account: accounts[0]!, message: 'hello sui' })
    const publicKey = await verifyPersonalMessageSignature(new TextEncoder().encode('hello sui'), signature, {
      address: mock.address,
    })
    expect(publicKey.toSuiAddress()).toBe(mock.address)
  })
})

describe('WalletManager across ecosystems', () => {
  it('aggregates EVM-less Wallet Standard wallets and reacts to wallet-side lock', async () => {
    const registry = createMemoryRegistry()
    const solana = await createMockSolanaWallet({ name: 'Sol' })
    const sui = createMockSuiWallet({ name: 'Sui' })
    registry.register(solana.wallet)
    registry.register(sui.wallet)
    const manager = new WalletManager({
      adapters: [createSolanaAdapter({ registry }), createSuiAdapter({ registry })],
      storage: createMemoryStorage(),
    })
    manager.start()
    await tick()
    expect(manager.getState().wallets.map((w) => w.id)).toEqual(['solana:sol', 'sui:sui'])

    await manager.connect('sui:sui')
    expect(manager.getState().connection?.accounts[0]).toBe(`sui:localnet:${sui.address}`)
    sui.lock()
    expect(manager.getState().status).toBe('disconnected')
  })

  it('restores a Wallet Standard session silently', async () => {
    const registry = createMemoryRegistry()
    const storage = createMemoryStorage()
    storage.setItem('omni:last-wallet', 'solana:sol')
    const solana = await createMockSolanaWallet({ name: 'Sol', authorized: true })
    const manager = new WalletManager({ adapters: [createSolanaAdapter({ registry })], storage })
    manager.start()
    expect(manager.getState().status).toBe('reconnecting')
    registry.register(solana.wallet)
    await expect.poll(() => manager.getState().status).toBe('connected')
    expect(solana.calls).not.toContain('standard:connect') // silent: no prompt
  })
})
