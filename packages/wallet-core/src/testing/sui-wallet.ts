import type { ClientWithCoreApi } from '@mysten/sui/client'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction } from '@mysten/sui/transactions'
import { toBase64 } from '@mysten/sui/utils'
import type { IdentifierString, WalletAccount } from '@wallet-standard/base'
import { createStandardWalletShell } from './standard-wallet'

export interface MockSuiWalletOptions {
  readonly name?: string
  readonly keypair?: Ed25519Keypair
  readonly chains?: readonly IdentifierString[]
  /** Needed to build transactions (resolves gas and object versions). */
  readonly client?: ClientWithCoreApi
  readonly authorized?: boolean
}

const FEATURES = ['sui:signPersonalMessage', 'sui:signTransaction', 'sui:signAndExecuteTransaction'] as const

/** A Wallet Standard Sui wallet with a real ed25519 keypair. */
export function createMockSuiWallet(options: MockSuiWalletOptions = {}) {
  const keypair = options.keypair ?? new Ed25519Keypair()
  const address = keypair.toSuiAddress()
  const chains = options.chains ?? ['sui:localnet']
  const account: WalletAccount = {
    address,
    publicKey: keypair.getPublicKey().toRawBytes(),
    chains,
    features: FEATURES,
  }

  // Like a real wallet: deserialize the dApp's transaction, set the sender, build, sign.
  const buildAndSign = async (transaction: { toJSON(): Promise<string> }) => {
    if (!options.client) throw new Error('Mock Sui wallet needs a client to build transactions')
    const tx = Transaction.from(await transaction.toJSON())
    tx.setSenderIfNotSet(address)
    const bytes = await tx.build({ client: options.client })
    const { signature } = await keypair.signTransaction(bytes)
    return { bytes, signature }
  }

  const { wallet, controls } = createStandardWalletShell({
    name: options.name ?? 'Mock Sui',
    chains,
    account,
    authorized: options.authorized,
    features: (guard) => ({
      'sui:signPersonalMessage': {
        version: '1.1.0',
        signPersonalMessage: async ({ message }: { message: Uint8Array }) => {
          guard('sui:signPersonalMessage')
          return keypair.signPersonalMessage(message)
        },
      },
      'sui:signTransaction': {
        version: '2.0.0',
        signTransaction: async ({ transaction }: { transaction: { toJSON(): Promise<string> } }) => {
          guard('sui:signTransaction')
          const { bytes, signature } = await buildAndSign(transaction)
          return { bytes: toBase64(bytes), signature }
        },
      },
      'sui:signAndExecuteTransaction': {
        version: '2.0.0',
        signAndExecuteTransaction: async ({ transaction }: { transaction: { toJSON(): Promise<string> } }) => {
          guard('sui:signAndExecuteTransaction')
          const { bytes, signature } = await buildAndSign(transaction)
          const result = await options.client!.core.executeTransaction({ transaction: bytes, signatures: [signature] })
          const executed = result.Transaction ?? result.FailedTransaction
          return { bytes: toBase64(bytes), signature, digest: executed.digest, effects: '' }
        },
      },
    }),
  })

  return { wallet, keypair, address, ...controls }
}
