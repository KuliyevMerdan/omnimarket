import {
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  signBytes,
  type KeyPairSigner,
} from '@solana/kit'
import type { IdentifierString, WalletAccount } from '@wallet-standard/base'
import { createStandardWalletShell } from './standard-wallet'

export interface MockSolanaWalletOptions {
  readonly name?: string
  /** 32-byte ed25519 seed; random when omitted. */
  readonly privateKey?: Uint8Array
  readonly chains?: readonly IdentifierString[]
  /** Needed for `solana:signAndSendTransaction`. */
  readonly rpcUrl?: string
  readonly authorized?: boolean
}

const FEATURES = ['solana:signMessage', 'solana:signTransaction', 'solana:signAndSendTransaction'] as const

/** A Wallet Standard Solana wallet with a real ed25519 key, signing exactly what it is given. */
export async function createMockSolanaWallet(options: MockSolanaWalletOptions = {}) {
  const signer: KeyPairSigner = options.privateKey
    ? await createKeyPairSignerFromPrivateKeyBytes(options.privateKey)
    : await generateKeyPairSigner()
  const chains = options.chains ?? ['solana:localnet', 'solana:devnet']
  const account: WalletAccount = {
    address: signer.address,
    publicKey: new Uint8Array(getAddressEncoder().encode(signer.address)),
    chains,
    features: FEATURES,
  }
  const encoder = getTransactionEncoder()
  const decoder = getTransactionDecoder()
  const sign = async (wire: Uint8Array) => {
    const tx = await partiallySignTransaction([signer.keyPair], decoder.decode(wire))
    return { tx, bytes: new Uint8Array(encoder.encode(tx)) }
  }

  const { wallet, controls } = createStandardWalletShell({
    name: options.name ?? 'Mock Solana',
    chains,
    account,
    authorized: options.authorized,
    features: (guard) => ({
      'solana:signMessage': {
        version: '1.1.0',
        signMessage: async (...inputs: { message: Uint8Array }[]) => {
          guard('solana:signMessage')
          return Promise.all(
            inputs.map(async ({ message }) => ({ signedMessage: message, signature: await signBytes(signer.keyPair.privateKey, message) })),
          )
        },
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
          guard('solana:signTransaction')
          return Promise.all(inputs.map(async ({ transaction }) => ({ signedTransaction: (await sign(transaction)).bytes })))
        },
      },
      'solana:signAndSendTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signAndSendTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
          guard('solana:signAndSendTransaction')
          if (!options.rpcUrl) throw new Error('signAndSendTransaction needs rpcUrl')
          const rpc = createSolanaRpc(options.rpcUrl)
          return Promise.all(
            inputs.map(async ({ transaction }) => {
              const { tx } = await sign(transaction)
              const signature = await rpc
                .sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64' })
                .send()
              return { signature: new Uint8Array(getBase58Encoder().encode(signature)) }
            }),
          )
        },
      },
    }),
  })

  return { wallet, signer, ...controls }
}
