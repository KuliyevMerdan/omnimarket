import type { ClientWithCoreApi } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'
import { verifyPersonalMessageSignature, verifyTransactionSignature } from '@mysten/sui/verify'
import {
  appendTransactionMessageInstruction,
  createTransactionMessage,
  getBase58Encoder,
  getPublicKeyFromAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  verifySignature,
  type Address,
  type Blockhash,
  type SignatureBytes,
} from '@solana/kit'
import { custom, verifyMessage, verifyTypedData, type Address as EvmAddress } from 'viem'
import { mainnet, sepolia } from 'viem/chains'
import { describe, expect, it, vi } from 'vitest'
import { parseAccountId } from '../../caip'
import { WalletManager } from '../../manager'
import { createMemoryStorage, type KeyValueStorage } from '../../storage'
import { createMockWalletConnect, type MockWalletConnect } from '../../testing'
import { isEvmConnector } from '../evm'
import { isSolanaConnector, SOLANA_LOCALNET } from '../solana'
import { isSuiConnector, SUI_LOCALNET } from '../sui'
import { createWalletConnect, pairingLink, parseApprovedNamespaces, safeDeepLink, MOBILE_WALLETS, type WalletConnectOptions } from '.'

const METADATA = { name: 'OmniMarket', description: 'test', url: 'https://omni.example', icons: [] }
const EVM = 'eip155:walletconnect'
const SOLANA = 'solana:walletconnect'
const SUI = 'sui:walletconnect'

async function setup({
  wallet,
  storage = createMemoryStorage(),
  ...overrides
}: { wallet?: MockWalletConnect; storage?: KeyValueStorage } & Partial<WalletConnectOptions> = {}) {
  wallet ??= await createMockWalletConnect({
    evm: { chainIds: [1, 11155111] },
    solana: { chains: [SOLANA_LOCALNET.caip] },
    sui: { chains: [SUI_LOCALNET.caip] },
    storage,
  })
  const reads: string[] = []
  const wc = createWalletConnect({
    projectId: 'test',
    metadata: METADATA,
    createClient: wallet.createClient,
    openWallet: 'never',
    eip155: {
      chains: [mainnet, sepolia],
      transport: () =>
        custom({
          request: async ({ method }) => {
            reads.push(method)
            return '0x10'
          },
        }),
    },
    solana: { chains: [SOLANA_LOCALNET] },
    sui: { chains: [SUI_LOCALNET], getClient: () => ({}) as ClientWithCoreApi },
    ...overrides,
  })
  const manager = new WalletManager({ adapters: wc.adapters, storage, reconnectTimeoutMs: 1000 })
  manager.start()

  /** Connects a namespace, playing the user who scans the QR code and approves. */
  const connect = async (walletId: string, approve: Parameters<MockWalletConnect['approve']>[0] = undefined) => {
    const connecting = manager.connect(walletId)
    if (!wc.session.getState().namespaces[walletId.split(':')[0] as 'eip155']) {
      await vi.waitFor(() => expect(wallet.pendingUri).toBeTruthy())
      wallet.approve(approve)
    }
    return connecting
  }
  return { wallet, wc, manager, reads, storage, connect }
}

describe('WalletConnect session', () => {
  it('shows the pairing URI, then connects with the approved account', async () => {
    const { wallet, wc, manager } = await setup()
    const connecting = manager.connect(EVM)

    await vi.waitFor(() => expect(wc.session.getState()).toMatchObject({ status: 'pairing', uri: expect.stringMatching(/^wc:/) }))
    expect(manager.getState().status).toBe('connecting')
    wallet.approve()
    const connection = await connecting

    expect(connection).toEqual({ chainId: 'eip155:1', accounts: [`eip155:1:${wallet.evm!.account.address}`] })
    expect(manager.getState().wallets.find((w) => w.id === EVM)).toMatchObject({ source: 'walletconnect', name: 'WalletConnect' })
    expect(wc.session.getState()).toMatchObject({ status: 'connected', uri: null, peer: { name: 'Mock Mobile Wallet' } })
  })

  it('serves every namespace from one session, and ends it on the last disconnect', async () => {
    const { wallet, wc, manager, connect } = await setup()
    await connect(EVM)

    // Same session, no second QR code: switching ecosystems is instant.
    const solana = await manager.connect(SOLANA)
    expect(solana.accounts).toEqual([`solana:localnet:${wallet.solana!.address}`])
    expect(isSolanaConnector(manager.getActiveConnector())).toBe(true)
    await manager.connect(SUI)
    expect(isSuiConnector(manager.getActiveConnector())).toBe(true)
    expect(wallet.proposals).toBe(1)
    // The previous connectors were detached, the session stayed.
    expect(wallet.sessions).toHaveLength(1)

    await manager.disconnect()
    expect(wallet.sessions).toHaveLength(0)
    expect(wc.session.getState()).toMatchObject({ status: 'idle', namespaces: {} })
  })

  it('shares one proposal between concurrent connects', async () => {
    const { wallet, wc } = await setup()
    const a = wc.session.pair()
    const b = wc.session.pair()
    await vi.waitFor(() => expect(wallet.pendingUri).toBeTruthy())
    wallet.approve()
    expect(await a).toBe(await b)
    expect(wallet.proposals).toBe(1)
  })

  it('refuses a namespace the wallet did not approve', async () => {
    const { wallet, manager, connect } = await setup()
    await connect(EVM, {
      namespaces: {
        eip155: { accounts: [`eip155:1:${wallet.evm!.account.address}`], methods: ['personal_sign', 'eth_sendTransaction'], events: [] },
      },
    })
    await expect(manager.connect(SOLANA)).rejects.toMatchObject({ code: 'UNRECOGNIZED_CHAIN' })
    // A failed switch keeps the working session.
    expect(manager.getState()).toMatchObject({ status: 'connected', activeWalletId: EVM })
  })

  it('closes a session that grants nothing usable', async () => {
    const { wallet, manager } = await setup()
    const connecting = manager.connect(EVM)
    await vi.waitFor(() => expect(wallet.pendingUri).toBeTruthy())
    wallet.approve({ namespaces: { eip155: { accounts: ['eip155:56:0x0000000000000000000000000000000000000001'], methods: ['personal_sign', 'eth_sendTransaction'], events: [] } } })
    await expect(connecting).rejects.toMatchObject({ code: 'UNSUPPORTED_METHOD' })
    expect(wallet.sessions).toHaveLength(0)
  })

  it('ends when the wallet deletes the session', async () => {
    const { wallet, wc, manager, connect } = await setup()
    await connect(SOLANA)
    wallet.deleteSession()
    expect(manager.getState()).toMatchObject({ status: 'disconnected', activeWalletId: null })
    expect(wc.session.getState().status).toBe('idle')
  })

  it('restores the session after a reload without pairing again', async () => {
    const storage = createMemoryStorage()
    const first = await setup({ storage })
    await first.connect(SUI)

    const reloaded = await setup({ storage, wallet: first.wallet })
    await vi.waitFor(() => expect(reloaded.manager.getState().status).toBe('connected'))
    expect(reloaded.manager.getState().activeWalletId).toBe(SUI)
    expect(first.wallet.proposals).toBe(1)
  })

  it('does not restore a session about to expire, and closes it', async () => {
    const storage = createMemoryStorage()
    const first = await setup({ storage })
    await first.connect(EVM, { expiry: Math.floor(Date.now() / 1000) + 30 })

    const reloaded = await setup({ storage, wallet: first.wallet })
    await vi.waitFor(() => expect(reloaded.manager.getState().status).toBe('disconnected'))
    expect(first.wallet.sessions).toHaveLength(0)
  })

  it('treats a wallet rejection and a closed QR dialog as user rejections', async () => {
    const { wallet, wc, manager } = await setup()
    const rejected = manager.connect(EVM)
    await vi.waitFor(() => expect(wallet.pendingUri).toBeTruthy())
    wallet.reject()
    await expect(rejected).rejects.toMatchObject({ code: 'USER_REJECTED' })

    const cancelled = manager.connect(EVM)
    await vi.waitFor(() => expect(wallet.pendingUri).toBeTruthy())
    wc.session.cancelPairing()
    await expect(cancelled).rejects.toMatchObject({ code: 'USER_REJECTED' })
    expect(wc.session.getState()).toMatchObject({ status: 'idle', error: null })

    // The wallet approves after all: that session is closed, not silently kept.
    wallet.approve()
    await vi.waitFor(() => expect(wallet.sessions).toHaveLength(0))
    expect(manager.getState().status).toBe('disconnected')
  })

  it('opens the wallet app after a request, only through a safe link', async () => {
    for (const [native, opened] of [
      ['mockwallet://wc', ['mockwallet://wc']],
      ['javascript:alert(1)', []],
    ] as const) {
      const storage = createMemoryStorage()
      const wallet = await createMockWalletConnect({ evm: { chainIds: [1] }, redirect: { native }, storage })
      const openWallet = vi.fn()
      const { manager, connect } = await setup({ wallet, storage, openWallet })
      await connect(EVM)
      await manager.signMessage('hi')
      expect(openWallet.mock.calls.map(([link]) => link)).toEqual(opened)
    }
  })
})

describe('WalletConnect EVM provider', () => {
  it('signs through the wallet and reads through the RPC', async () => {
    const { wallet, manager, reads, connect } = await setup()
    await connect(EVM)
    const connector = manager.getActiveConnector()
    if (!isEvmConnector(connector)) throw new Error('expected EVM connector')
    const address = wallet.evm!.account.address

    const signature = await manager.signMessage('Sign in to OmniMarket')
    expect(await verifyMessage({ address, message: 'Sign in to OmniMarket', signature: signature as `0x${string}` })).toBe(true)

    const typedData = {
      domain: { name: 'OmniMarket', version: '1', chainId: 1 },
      types: { Order: [{ name: 'price', type: 'uint256' }] },
      primaryType: 'Order',
      message: { price: 1n },
    } as const
    const typed = await connector.signTypedData(`eip155:1:${address}`, typedData)
    expect(await verifyTypedData({ address, signature: typed, ...typedData })).toBe(true)

    await connector.provider.request({ method: 'eth_blockNumber' })
    expect(reads).toEqual(['eth_blockNumber'])
    expect(wallet.requests.map((r) => [r.chainId, r.method])).toEqual([
      ['eip155:1', 'personal_sign'],
      ['eip155:1', 'eth_signTypedData_v4'],
    ])
  })

  it('switches between approved chains locally', async () => {
    const { wallet, manager, connect } = await setup()
    await connect(EVM)
    await manager.switchChain('eip155:11155111')
    expect(manager.getState().connection?.chainId).toBe('eip155:11155111')
    expect(wallet.requests).toEqual([])

    await manager.signMessage('hi')
    expect(wallet.requests.at(-1)).toMatchObject({ chainId: 'eip155:11155111', method: 'personal_sign' })
  })

  it('asks the wallet for a chain outside the session and follows its session_update', async () => {
    const { wallet, manager, connect } = await setup()
    const address = wallet.evm!.account.address
    await connect(EVM, {
      namespaces: {
        eip155: { accounts: [`eip155:1:${address}`], methods: ['personal_sign', 'eth_sendTransaction', 'wallet_switchEthereumChain'], events: ['chainChanged'] },
      },
    })
    await manager.switchChain('eip155:11155111')
    expect(wallet.requests.map((r) => [r.chainId, r.method])).toEqual([['eip155:1', 'wallet_switchEthereumChain']])
    expect(manager.getState().connection).toEqual({ chainId: 'eip155:11155111', accounts: [`eip155:11155111:${address}`] })
  })

  it('follows chainChanged events from the wallet', async () => {
    const { wallet, manager, connect } = await setup()
    await connect(EVM)
    wallet.emitEvent('eip155:1', 'chainChanged', 11155111)
    expect(manager.getState().connection?.chainId).toBe('eip155:11155111')
  })

  it('maps a rejection in the wallet to USER_REJECTED', async () => {
    const { wallet, manager, connect } = await setup()
    await connect(EVM)
    wallet.rejectNextRequest()
    await expect(manager.signMessage('hi')).rejects.toMatchObject({ code: 'USER_REJECTED' })
  })
})

describe('WalletConnect Solana wallet', () => {
  it('verifies message signatures and refuses one over different bytes', async () => {
    const { wallet, manager, connect } = await setup()
    await connect(SOLANA)
    const message = 'Sign in to OmniMarket'
    const signature = await manager.signMessage(message)
    const key = await getPublicKeyFromAddress(wallet.solana!.address)
    const bytes = new Uint8Array(getBase58Encoder().encode(signature)) as unknown as SignatureBytes
    expect(await verifySignature(key, bytes, new TextEncoder().encode(message))).toBe(true)
    expect(wallet.requests[0]).toMatchObject({ chainId: SOLANA_LOCALNET.caip, method: 'solana_signMessage' })

    wallet.misbehave('solana-foreign-signature')
    await expect(manager.signMessage(message)).rejects.toThrow(/does not match/)
  })

  it('returns wallet-signed transactions as a kit signer', async () => {
    const { wallet, manager, connect } = await setup()
    const { accounts } = await connect(SOLANA)
    const connector = manager.getActiveConnector()
    if (!isSolanaConnector(connector)) throw new Error('expected Solana connector')
    expect(connector.canSignTransaction).toBe(true)

    const signer = connector.transactionSigner(accounts[0]!)
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 10n }, m),
      (m) => appendTransactionMessageInstruction({ programAddress: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' as Address, data: new TextEncoder().encode('hi') }, m),
    )
    const signed = await signTransactionMessageWithSigners(message)
    const key = await getPublicKeyFromAddress(wallet.solana!.address)
    expect(await verifySignature(key, signed.signatures[wallet.solana!.address]!, signed.messageBytes)).toBe(true)
    expect(signed.lifetimeConstraint).toMatchObject({ lastValidBlockHeight: 10n })
  })

  it('reflects only the methods the wallet approved', async () => {
    const { wallet, manager, connect } = await setup()
    await connect(SOLANA, {
      namespaces: {
        solana: {
          accounts: [`${SOLANA_LOCALNET.caip}:${wallet.solana!.address}`],
          methods: ['solana_signMessage', 'solana_signAndSendTransaction'],
          events: [],
        },
      },
    })
    const connector = manager.getActiveConnector()
    expect(isSolanaConnector(connector) && connector.canSignTransaction).toBe(false)
    expect(wallet.proposals).toBe(1)
  })
})

describe('WalletConnect Sui wallet', () => {
  it('verifies personal messages and refuses a transaction it did not ask for', async () => {
    const { wallet, manager, connect } = await setup()
    const { accounts } = await connect(SUI)
    const address = wallet.sui!.address
    const signature = await manager.signMessage('Sign in to OmniMarket')
    await expect(verifyPersonalMessageSignature(new TextEncoder().encode('Sign in to OmniMarket'), signature, { address })).resolves.toBeTruthy()

    const connector = manager.getActiveConnector()
    if (!isSuiConnector(connector)) throw new Error('expected Sui connector')
    const tx = offlineTransaction(address)
    const signed = await connector.signTransaction(accounts[0]!, tx)
    await expect(verifyTransactionSignature(Uint8Array.from(atob(signed.bytes), (c) => c.charCodeAt(0)), signed.signature, { address })).resolves.toBeTruthy()

    wallet.misbehave('sui-foreign-bytes')
    await expect(connector.signTransaction(accounts[0]!, offlineTransaction(address))).rejects.toThrow(/different transaction/)
  })
})

describe('session validation', () => {
  it('keeps valid accounts on requested chains and only requested methods', () => {
    const lower = '0x52908400098527886e0f7030069857d2e4169ee7'
    const approved = parseApprovedNamespaces(
      {
        eip155: {
          accounts: [`eip155:1:${lower}`, `eip155:1:${lower}`, 'eip155:999:0x52908400098527886E0F7030069857D2E4169EE7', 'eip155:1:not-an-address'],
          methods: ['personal_sign', 'eth_sendTransaction', 'eth_sign'],
          events: ['chainChanged'],
        },
        'solana:localnet': { accounts: ['solana:localnet:11111111111111111111111111111111'], methods: ['solana_signTransaction'], events: [] },
        sui: { accounts: ['sui:mainnet:0x2'], methods: ['sui_signPersonalMessage', 'sui_signTransaction'], events: [] },
      },
      { eip155: ['eip155:1', 'eip155:11155111'], solana: ['solana:localnet'], sui: ['sui:localnet'] },
    )
    expect(Object.keys(approved)).toEqual(['eip155'])
    expect(approved.eip155).toMatchObject({ chains: ['eip155:1'], accounts: ['eip155:1:0x52908400098527886E0F7030069857D2E4169EE7'] })
    expect([...approved.eip155!.methods]).toEqual(['personal_sign', 'eth_sendTransaction'])
    expect(parseAccountId(approved.eip155!.accounts[0]!).address).toBe('0x52908400098527886E0F7030069857D2E4169EE7' as EvmAddress)
  })
})

describe('deep links', () => {
  it('accepts app schemes and https, rejects script and downgrade schemes', () => {
    expect(safeDeepLink('metamask://')).toBe('metamask://')
    expect(safeDeepLink('https://wallet.example/wc')).toBe('https://wallet.example/wc')
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'http://wallet.example', 'not a url', 42]) {
      expect(safeDeepLink(bad)).toBeNull()
    }
  })

  it('passes the pairing URI as one encoded parameter', () => {
    const link = pairingLink(MOBILE_WALLETS[0]!, 'wc:abc@2?relay-protocol=irn&symKey=xyz')
    expect(new URL(link).searchParams.get('uri')).toBe('wc:abc@2?relay-protocol=irn&symKey=xyz')
  })
})

/** A Sui transaction that builds without a network: gas fully specified, only pure inputs. */
function offlineTransaction(sender: string): Transaction {
  const tx = new Transaction()
  tx.setSender(sender)
  tx.setGasPrice(1000)
  tx.setGasBudget(10_000_000)
  tx.setGasPayment([{ objectId: `0x${'1'.repeat(64)}`, version: '1', digest: '11111111111111111111111111111111' }])
  tx.transferObjects([tx.gas], '0x2')
  return tx
}

describe('cross-bundle instanceof', () => {
  it('recognizes connectors and errors made by another copy of the package', async () => {
    const { isEvmConnector } = await import('../evm')
    const { isSolanaConnector } = await import('../solana')
    const { WalletError } = await import('../../errors')
    // What another bundle's instances look like to this copy: same registry symbols, other classes.
    const foreign = (name: string) => ({ [Symbol.for(`omnimarket.${name}`)]: true })
    expect(isEvmConnector(foreign('Eip1193Connector') as never)).toBe(true)
    expect(isSolanaConnector(foreign('Eip1193Connector') as never)).toBe(false)
    expect(foreign('WalletError') instanceof WalletError).toBe(true)
    expect(new Error('x') instanceof WalletError).toBe(false)
  })
})
