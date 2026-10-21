import { defineTxStore, defineWalletStore } from '@omnimarket/vue/pinia'
import { core } from './core'

export const useWalletStore = defineWalletStore(core.manager)
export const useTxStore = defineTxStore(core.txStore)
