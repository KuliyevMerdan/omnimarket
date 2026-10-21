import {
  getBase58Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type Address,
  type SignatureBytes,
  type Transaction,
  type TransactionModifyingSigner,
  type TransactionWithLifetime,
  type TransactionWithinSizeLimit,
} from '@solana/kit'
import {
  SolanaSignAndSendTransaction,
  SolanaSignMessage,
  SolanaSignTransaction,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignMessageFeature,
  type SolanaSignTransactionFeature,
} from '@solana/wallet-standard-features'
import type { Wallet } from '@wallet-standard/base'
import { parseAccountId } from '../../caip'
import { WalletError, toWalletError } from '../../errors'
import type { CaipAccountId } from '../../types'
import { WalletStandardConnector, type StandardChainList } from '../wallet-standard/connector'

export class SolanaConnector extends WalletStandardConnector {
  constructor(wallet: Wallet, chains: StandardChainList) {
    super(wallet, { namespace: 'solana', chains })
  }

  /** Signature as base58, the encoding Solana tooling and SIWS verifiers expect. */
  async signMessage({ account, message }: { account: CaipAccountId; message: string }): Promise<string> {
    const walletAccount = this.walletAccount(account)
    const feature = this.feature<SolanaSignMessageFeature[typeof SolanaSignMessage]>(SolanaSignMessage)
    const bytes = new TextEncoder().encode(message)
    try {
      const [output] = await feature.signMessage({ account: walletAccount, message: bytes })
      if (!output) throw new WalletError('UNKNOWN', 'Wallet returned no signature')
      // Some wallets prefix or rewrite messages. A signature over different bytes than the user saw
      // in our UI is not something we forward to a verifier.
      if (!equalBytes(output.signedMessage, bytes)) {
        throw new WalletError('UNSUPPORTED_METHOD', `${this.wallet.name} signed a different message than requested`)
      }
      return getBase58Decoder().decode(output.signature)
    } catch (error) {
      throw toWalletError(error)
    }
  }

  /** The wallet signs the transaction itself and we broadcast: we control retries and rebroadcasts. */
  get canSignTransaction(): boolean {
    return this.hasFeature(SolanaSignTransaction)
  }

  /**
   * A kit signer backed by the wallet. As a *modifying* signer it runs before any partial signer,
   * because wallets may add instructions (priority fees, guards) and that invalidates earlier signatures.
   */
  transactionSigner(account: CaipAccountId): TransactionModifyingSigner {
    const walletAccount = this.walletAccount(account)
    const chain = this.chain.standard
    const feature = this.feature<SolanaSignTransactionFeature[typeof SolanaSignTransaction]>(SolanaSignTransaction)
    const encoder = getTransactionEncoder()
    const decoder = getTransactionDecoder()
    return {
      address: parseAccountId(account).address as Address,
      modifyAndSignTransactions: async (transactions) => {
        try {
          const outputs = await feature.signTransaction(
            ...transactions.map((tx) => ({ account: walletAccount, chain, transaction: new Uint8Array(encoder.encode(tx)) })),
          )
          return outputs.map((output, i) => {
            const signed = decoder.decode(output.signedTransaction) as Transaction
            // Wire bytes don't carry the lifetime; the wallet keeps the blockhash, so carry it over.
            const lifetime = (transactions[i] as Partial<TransactionWithLifetime>).lifetimeConstraint
            return { ...signed, ...(lifetime ? { lifetimeConstraint: lifetime } : {}) } as Transaction &
              TransactionWithinSizeLimit &
              TransactionWithLifetime
          })
        } catch (error) {
          throw toWalletError(error)
        }
      },
    }
  }

  /** Fallback for wallets that only broadcast themselves (no app-side rebroadcast possible). */
  async signAndSendTransaction(account: CaipAccountId, wireTransaction: Uint8Array): Promise<string> {
    const walletAccount = this.walletAccount(account)
    const feature = this.feature<SolanaSignAndSendTransactionFeature[typeof SolanaSignAndSendTransaction]>(
      SolanaSignAndSendTransaction,
    )
    try {
      const [output] = await feature.signAndSendTransaction({
        account: walletAccount,
        chain: this.chain.standard,
        transaction: wireTransaction,
      })
      return getBase58Decoder().decode(output!.signature as SignatureBytes)
    } catch (error) {
      throw toWalletError(error)
    }
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}
