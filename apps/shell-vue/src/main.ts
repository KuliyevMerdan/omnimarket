import '@omnimarket/ui/tokens.css'
import '@omnimarket/ui'
import { createOmniVue } from '@omnimarket/vue'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { core } from './core'
import { router } from './router'
import './styles.css'

createApp(App)
  .use(createPinia())
  .use(
    createOmniVue({
      manager: core.manager,
      txStore: core.txStore,
      siwe: core.siwe,
      walletConnect: core.walletConnect?.session ?? null,
      engines: [core.evm, core.solana, core.sui],
    }),
  )
  .use(router)
  .mount('#app')
