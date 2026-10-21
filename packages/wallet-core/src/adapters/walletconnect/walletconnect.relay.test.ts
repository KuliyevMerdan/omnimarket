import { SignClient } from '@walletconnect/sign-client'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { hexToString, verifyMessage, type Hex } from 'viem'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { WalletManager } from '../../manager'
import { createMemoryStorage } from '../../storage'
import { createWalletConnect, type WalletConnectClient } from '.'

const projectId = process.env.WC_PROJECT_ID

/** In-memory `IKeyValueStorage`: the SDK's Node default writes a database file into the cwd. */
function memoryStorage() {
  const map = new Map<string, unknown>()
  return {
    getKeys: async () => [...map.keys()],
    getEntries: async <T>() => [...map.entries()] as [string, T][],
    getItem: async <T>(key: string) => map.get(key) as T | undefined,
    setItem: async <T>(key: string, value: T) => void map.set(key, value),
    removeItem: async (key: string) => void map.delete(key),
  }
}

/**
 * Against the real WalletConnect relay: two real SignClients, the dApp side wrapped in our session.
 * Needs network and a project id from https://dashboard.reown.com:
 *
 *   WC_PROJECT_ID=… pnpm vitest run packages/wallet-core/src/adapters/walletconnect/walletconnect.relay.test.ts
 */
describe.skipIf(!projectId)('WalletConnect over the real relay', () => {
  const clients: { core: { relayer: { transportClose(): Promise<void> } } }[] = []
  afterAll(async () => {
    for (const client of clients) await client.core.relayer.transportClose().catch(() => {})
  })

  it('pairs, signs a SIWE-style message and disconnects', { timeout: 60_000 }, async () => {
    const account = privateKeyToAccount(generatePrivateKey())
    const wallet = await SignClient.init({
      projectId,
      storage: memoryStorage(),
      metadata: { name: 'Relay test wallet', description: 'test', url: 'https://wallet.example', icons: [] },
    })
    clients.push(wallet as never)
    wallet.on('session_proposal', async ({ id, params }) => {
      const chains = params.optionalNamespaces.eip155?.chains ?? []
      await wallet.approve({
        id,
        namespaces: {
          eip155: { chains, accounts: chains.map((c) => `${c}:${account.address}`), methods: params.optionalNamespaces.eip155!.methods, events: [] },
        },
      })
    })
    wallet.on('session_request', async ({ id, topic, params }) => {
      const [message] = params.request.params as [Hex, string]
      const result = await account.signMessage({ message: hexToString(message) })
      await wallet.respond({ topic, response: { id, jsonrpc: '2.0', result } })
    })

    const wc = createWalletConnect({
      projectId: projectId!,
      metadata: { name: 'OmniMarket relay test', description: 'test', url: 'https://omni.example', icons: [] },
      openWallet: 'never',
      createClient: async () => {
        const client = await SignClient.init({
          projectId,
          storage: memoryStorage(),
          metadata: { name: 'OmniMarket relay test', description: 'test', url: 'https://omni.example', icons: [] },
        })
        clients.push(client as never)
        return client as unknown as WalletConnectClient
      },
      eip155: { chains: [mainnet] },
    })
    const manager = new WalletManager({ adapters: wc.adapters, storage: createMemoryStorage() })
    manager.start()

    const connecting = manager.connect('eip155:walletconnect')
    const uri = await new Promise<string>((resolve) => {
      const stop = wc.session.subscribe(() => {
        const { uri } = wc.session.getState()
        if (uri) {
          stop()
          resolve(uri)
        }
      })
    })
    await wallet.pair({ uri }) // what scanning the QR code does
    const connection = await connecting
    expect(connection.accounts).toEqual([`eip155:1:${account.address}`])

    const signature = await manager.signMessage('Sign in to OmniMarket')
    expect(await verifyMessage({ address: account.address, message: 'Sign in to OmniMarket', signature: signature as Hex })).toBe(true)

    await manager.disconnect()
    await vi.waitFor(() => expect(wallet.session.getAll()).toHaveLength(0), { timeout: 10_000 })
  })
})
