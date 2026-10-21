import type { ClientWithCoreApi } from '@mysten/sui/client'
import {
  getAddressEncoder,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Decoder,
  getBase64Encoder,
  getPublicKeyFromAddress,
  verifySignature,
  type Address,
  type SignatureBytes,
} from '@solana/kit'
import type { IdentifierString, Wallet, WalletAccount } from '@wallet-standard/base'
import type { StandardEventsChangeProperties } from '@wallet-standard/features'
import { WalletError } from '../../errors'
import type { CaipChainId } from '../../types'
import type { StandardChain, StandardChainList } from '../wallet-standard/connector'
import { addressesOn } from './namespaces'
import type { WalletConnectSession } from './session'

export const WALLETCONNECT_ICON = `data:image/svg+xml;base64,${btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#3b99fc"/>' +
    '<path d="M9.6 12.4c3.5-3.4 9.3-3.4 12.8 0l.4.4-1.5 1.4-.6-.6c-2.5-2.4-6.5-2.4-9 0l-.6.6-1.5-1.4.4-.4zm15.8 2.9 1.3 1.3-5.9 5.8-3.9-3.8-1.8 1.8-3.9 3.8-5.9-5.8 1.3-1.3 4.6 4.5 3.9-3.8 3.9 3.8 4.6-4.5z" fill="#fff"/></svg>',
)}` as const satisfies `data:image/svg+xml;base64,${string}`

interface Base {
  readonly session: WalletConnectSession
  readonly chains: StandardChainList
}

/**
 * The relay-backed wallet presents itself through Wallet Standard, so the existing `SolanaConnector` /
 * `SuiConnector` (and the tx engines on top) work unchanged. Features follow what the wallet approved:
 * a wallet that only granted sign-and-send makes `canSignTransaction` false, and the engine adapts.
 */
function createWalletShell(
  namespace: 'solana' | 'sui',
  { session, chains }: Base,
  features: Record<string, { readonly method: string; readonly feature: unknown }>,
  publicKey: (address: string) => Uint8Array,
): Wallet {
  const listeners = new Set<(properties: StandardEventsChangeProperties) => void>()
  const approved = () => session.getState().namespaces[namespace]
  const standardChains = (): IdentifierString[] => {
    const ns = approved()
    return chains.filter((c) => !ns || ns.chains.includes(c.caip)).map((c) => c.standard)
  }
  const accounts = (): WalletAccount[] => {
    const ns = approved()
    if (!ns) return []
    const own = standardChains()
    return addressesOn(ns).map((address) => ({
      address,
      publicKey: publicKey(address),
      chains: own,
      features: Object.keys(features) as IdentifierString[],
    }))
  }

  session.onEvent((event) => {
    if (event.type === 'event' && event.name !== 'accountsChanged') return
    if (event.type === 'event' && event.namespace !== namespace) return
    const properties = { accounts: accounts() }
    for (const listener of [...listeners]) listener(properties)
  })

  return {
    version: '1.0.0',
    name: 'WalletConnect',
    icon: WALLETCONNECT_ICON,
    get chains() {
      return standardChains()
    },
    get accounts() {
      return accounts()
    },
    get features() {
      const ns = approved()
      const granted = Object.fromEntries(
        Object.entries(features)
          .filter(([, f]) => !ns || ns.methods.has(f.method))
          .map(([name, f]) => [name, f.feature]),
      )
      return {
        'standard:connect': {
          version: '1.0.0',
          connect: async ({ silent = false }: { silent?: boolean } = {}) => {
            if (silent) {
              await session.init()
              if (!approved()) return { accounts: [] }
            } else {
              await session.pair()
            }
            session.attach(namespace)
            return { accounts: accounts() }
          },
        },
        'standard:disconnect': { version: '1.0.0', disconnect: () => session.detach(namespace) },
        'standard:events': {
          version: '1.0.0',
          on: (_event: 'change', listener: (properties: StandardEventsChangeProperties) => void) => {
            listeners.add(listener)
            return () => {
              listeners.delete(listener)
            }
          },
        },
        ...granted,
      } as Wallet['features']
    },
  }
}

function caipOf(chains: StandardChainList, standard: string | undefined): CaipChainId {
  const chain: StandardChain | undefined = chains.find((c) => c.standard === standard)
  if (!chain) throw new WalletError('UNRECOGNIZED_CHAIN', `Chain ${standard} is not configured in this dApp`)
  return chain.caip
}

/** The first approved chain: Wallet Standard message signing carries no chain, WalletConnect needs one. */
function anyApprovedChain(session: WalletConnectSession, namespace: 'solana' | 'sui'): CaipChainId {
  const chain = session.getState().namespaces[namespace]?.chains[0]
  if (!chain) throw new WalletError('NOT_CONNECTED', `No WalletConnect session for ${namespace}`)
  return chain
}

export function createWalletConnectSolanaWallet(options: Base): Wallet {
  const { session, chains } = options
  const base58 = { encode: getBase58Encoder(), decode: getBase58Decoder() }
  const base64 = { encode: getBase64Encoder(), decode: getBase64Decoder() }

  /** Every signature that comes back over the relay is checked against the key it claims to be from. */
  const assertSignature = async (address: string, signature: Uint8Array, data: Uint8Array) => {
    const valid =
      signature.length === 64 &&
      (await verifySignature(await getPublicKeyFromAddress(address as Address), signature as SignatureBytes, data))
    if (!valid) throw new WalletError('UNKNOWN', 'The wallet returned a signature that does not match the request')
  }

  return createWalletShell(
    'solana',
    options,
    {
      'solana:signMessage': {
        method: 'solana_signMessage',
        feature: {
          version: '1.1.0',
          signMessage: async (...inputs: { account: WalletAccount; message: Uint8Array }[]) => {
            const outputs = []
            for (const { account, message } of inputs) {
              const { signature } = await session.request<{ signature: string }>('solana', anyApprovedChain(session, 'solana'), 'solana_signMessage', {
                message: base58.decode.decode(message),
                pubkey: account.address,
              })
              const bytes = new Uint8Array(base58.encode.encode(signature))
              // The relay protocol returns only a signature; verifying it is how we know the wallet
              // signed these bytes (and not a prefixed or rewritten message).
              await assertSignature(account.address, bytes, message)
              outputs.push({ signedMessage: message, signature: bytes })
            }
            return outputs
          },
        },
      },
      'solana:signTransaction': {
        method: 'solana_signTransaction',
        feature: {
          version: '1.0.0',
          supportedTransactionVersions: ['legacy', 0],
          signTransaction: async (...inputs: { account: WalletAccount; chain?: string; transaction: Uint8Array }[]) => {
            const { getTransactionDecoder, getTransactionEncoder } = await import('../solana/codecs')
            const txDecoder = getTransactionDecoder()
            const txEncoder = getTransactionEncoder()
            const outputs = []
            for (const { account, chain, transaction } of inputs) {
              const result = await session.request<{ signature: string; transaction?: string }>(
                'solana',
                caipOf(chains, chain),
                'solana_signTransaction',
                { transaction: base64.decode.decode(transaction) },
              )
              // Wallets may return the whole (possibly modified) transaction, or only their signature.
              const tx = txDecoder.decode(result.transaction ? new Uint8Array(base64.encode.encode(result.transaction)) : transaction)
              const signature = result.transaction
                ? tx.signatures[account.address as Address]
                : new Uint8Array(base58.encode.encode(result.signature))
              if (!signature) throw new WalletError('UNKNOWN', 'The wallet returned a transaction without its signature')
              await assertSignature(account.address, signature, new Uint8Array(tx.messageBytes))
              const signed = { ...tx, signatures: { ...tx.signatures, [account.address]: signature } }
              outputs.push({ signedTransaction: new Uint8Array(txEncoder.encode(signed)) })
            }
            return outputs
          },
        },
      },
      'solana:signAndSendTransaction': {
        method: 'solana_signAndSendTransaction',
        feature: {
          version: '1.0.0',
          supportedTransactionVersions: ['legacy', 0],
          signAndSendTransaction: async (...inputs: { account: WalletAccount; chain: string; transaction: Uint8Array }[]) => {
            const outputs = []
            for (const { chain, transaction } of inputs) {
              const { signature } = await session.request<{ signature: string }>('solana', caipOf(chains, chain), 'solana_signAndSendTransaction', {
                transaction: base64.decode.decode(transaction),
                sendOptions: {},
              })
              outputs.push({ signature: new Uint8Array(base58.encode.encode(signature)) })
            }
            return outputs
          },
        },
      },
    },
    (address) => new Uint8Array(getAddressEncoder().encode(address as Address)),
  )
}

export interface WalletConnectSuiOptions extends Base {
  /**
   * The relay protocol carries BCS bytes, not the dApp's transaction JSON, so the dApp builds them.
   * (Wallet Standard wallets build themselves; here we are the wallet's front end.)
   */
  /** May load the SDK lazily. */
  readonly getClient: (chain: CaipChainId) => ClientWithCoreApi | Promise<ClientWithCoreApi>
}

export function createWalletConnectSuiWallet(options: WalletConnectSuiOptions): Wallet {
  const { session, chains, getClient } = options

  // Transaction building and multi-scheme verification (ed25519, secp256k1/r1, passkey, zkLogin) are
  // heavy; they load on the first Sui signature, not with the app.
  const verify = () => import('@mysten/sui/verify')

  const build = async (transaction: { toJSON(): Promise<string> }, sender: string, chain: CaipChainId) => {
    const { Transaction } = await import('@mysten/sui/transactions')
    const tx = Transaction.from(await transaction.toJSON())
    tx.setSenderIfNotSet(sender)
    return tx.build({ client: await getClient(chain) })
  }

  // Sui public keys aren't derivable from addresses; wallets may publish them in `sessionProperties`.
  // Nothing here needs them (signatures embed the key), so accounts carry an empty one.
  return createWalletShell(
    'sui',
    options,
    {
      'sui:signPersonalMessage': {
        method: 'sui_signPersonalMessage',
        feature: {
          version: '1.1.0',
          signPersonalMessage: async ({ account, message }: { account: WalletAccount; message: Uint8Array }) => {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(message)
            const { signature } = await session.request<{ signature: string }>('sui', anyApprovedChain(session, 'sui'), 'sui_signPersonalMessage', {
              message: text,
              address: account.address,
            })
            const { verifyPersonalMessageSignature } = await verify()
            await verifyOrThrow(() => verifyPersonalMessageSignature(message, signature, { address: account.address }))
            return { bytes: toBase64(message), signature }
          },
        },
      },
      'sui:signTransaction': {
        method: 'sui_signTransaction',
        feature: {
          version: '2.0.0',
          signTransaction: async ({ account, chain, transaction }: { account: WalletAccount; chain: string; transaction: { toJSON(): Promise<string> } }) => {
            const caip = caipOf(chains, chain)
            const bytes = await build(transaction, account.address, caip)
            const result = await session.request<{ signature: string; transactionBytes: string }>('sui', caip, 'sui_signTransaction', {
              transaction: toBase64(bytes),
              address: account.address,
            })
            // We execute these bytes ourselves. A wallet that signed anything else (a different
            // recipient, a bigger gas budget) gets refused, not submitted.
            if (result.transactionBytes && !equalBytes(fromBase64(result.transactionBytes), bytes)) {
              throw new WalletError('UNKNOWN', 'The wallet signed a different transaction than requested')
            }
            const { verifyTransactionSignature } = await verify()
            await verifyOrThrow(() => verifyTransactionSignature(bytes, result.signature, { address: account.address }))
            return { bytes: toBase64(bytes), signature: result.signature }
          },
        },
      },
      'sui:signAndExecuteTransaction': {
        method: 'sui_signAndExecuteTransaction',
        feature: {
          version: '2.0.0',
          signAndExecuteTransaction: async ({ account, chain, transaction }: { account: WalletAccount; chain: string; transaction: { toJSON(): Promise<string> } }) => {
            const caip = caipOf(chains, chain)
            const bytes = await build(transaction, account.address, caip)
            const { digest } = await session.request<{ digest: string }>('sui', caip, 'sui_signAndExecuteTransaction', {
              transaction: toBase64(bytes),
              address: account.address,
            })
            return { bytes: toBase64(bytes), signature: '', digest, effects: '' }
          },
        },
      },
    },
    () => new Uint8Array(),
  )
}

async function verifyOrThrow(verify: () => Promise<unknown>): Promise<void> {
  try {
    await verify()
  } catch (cause) {
    throw new WalletError('UNKNOWN', 'The wallet returned a signature that does not match the request', { cause })
  }
}

const base64Codec = { encoder: getBase64Encoder(), decoder: getBase64Decoder() }
const toBase64 = (bytes: Uint8Array): string => base64Codec.decoder.decode(bytes)
const fromBase64 = (text: string): Uint8Array => new Uint8Array(base64Codec.encoder.encode(text))

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}
