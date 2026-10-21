import {
  SuiSignAndExecuteTransaction,
  SuiSignPersonalMessage,
  SuiSignTransaction,
  type SuiSignAndExecuteTransactionFeature,
  type SuiSignPersonalMessageFeature,
  type SuiSignTransactionFeature,
} from '@mysten/wallet-standard'
import type { Wallet } from '@wallet-standard/base'
import { toWalletError } from '../../errors'
import type { CaipAccountId, WalletInfo } from '../../types'
import type { StandardChain } from '../wallet-standard/connector'
import { WalletStandardConnector } from '../wallet-standard/connector'

/** Anything the wallet can serialize — a `Transaction` from `@mysten/sui/transactions` fits. */
export interface SerializableSuiTransaction {
  toJSON(): Promise<string>
}

export class SuiConnector extends WalletStandardConnector {
  constructor(wallet: Wallet, chains: readonly [StandardChain, ...StandardChain[]], options: { source?: WalletInfo['source'] } = {}) {
    super(wallet, { namespace: 'sui', chains, source: options.source })
  }

  /**
   * `sui:signPersonalMessage`. Returns Sui's serialized signature (base64: scheme flag ‖ sig ‖ pubkey),
   * which `verifyPersonalMessageSignature` checks, including intent-message domain separation —
   * a personal-message signature can never be replayed as a transaction signature.
   */
  async signMessage({ account, message }: { account: CaipAccountId; message: string }): Promise<string> {
    const feature = this.feature<SuiSignPersonalMessageFeature[typeof SuiSignPersonalMessage]>(SuiSignPersonalMessage)
    try {
      const { signature } = await feature.signPersonalMessage({
        account: this.walletAccount(account),
        chain: this.chain.standard,
        message: new TextEncoder().encode(message),
      })
      return signature
    } catch (error) {
      throw toWalletError(error)
    }
  }

  get canSignTransaction(): boolean {
    return this.hasFeature(SuiSignTransaction)
  }

  /** Wallet signs, we execute: the app owns submission, retries and effects parsing. */
  async signTransaction(account: CaipAccountId, transaction: SerializableSuiTransaction): Promise<{ bytes: string; signature: string }> {
    const feature = this.feature<SuiSignTransactionFeature[typeof SuiSignTransaction]>(SuiSignTransaction)
    try {
      return await feature.signTransaction({ account: this.walletAccount(account), chain: this.chain.standard, transaction })
    } catch (error) {
      throw toWalletError(error)
    }
  }

  async signAndExecuteTransaction(account: CaipAccountId, transaction: SerializableSuiTransaction) {
    const feature = this.feature<SuiSignAndExecuteTransactionFeature[typeof SuiSignAndExecuteTransaction]>(
      SuiSignAndExecuteTransaction,
    )
    try {
      return await feature.signAndExecuteTransaction({ account: this.walletAccount(account), chain: this.chain.standard, transaction })
    } catch (error) {
      throw toWalletError(error)
    }
  }
}
