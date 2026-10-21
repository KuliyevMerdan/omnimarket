<script setup lang="ts">
import { MARKET_PAGES } from '@omnimarket/app-core'
import { useSiwe } from '@omnimarket/vue'
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AccountCard from './components/AccountCard.vue'
import ConnectCard from './components/ConnectCard.vue'
import SiweCard from './components/SiweCard.vue'
import WalletConnectDialog from './components/WalletConnectDialog.vue'
import { useTxStore, useWalletStore } from './stores'

const wallet = useWalletStore()
const txs = useTxStore()
// One instance for the page; the card only renders it.
const auth = useSiwe()
const route = useRoute()
const router = useRouter()

const PAGE_TABS = { market: { to: '/market', label: 'Market' }, mine: { to: '/nfts', label: 'My NFTs' } } as const

/** Navigation comes from MARKET_PAGES: the shell knows the remote's pages without loading it. */
const tabs = computed(() => [
  ...(MARKET_PAGES[wallet.account.namespace ?? ''] ?? []).map((page) => PAGE_TABS[page]),
  { to: '/activity', label: 'Activity' },
])
const inFlight = computed(() => txs.inFlight.length)

// Switching ecosystems can remove the current page (Solana has no market): fall back to the first one.
watch([tabs, () => route.path], ([list, path]) => {
  if (wallet.isConnected && !list.some((tab) => tab.to === path)) void router.replace(list[0]!.to)
})

async function disconnect() {
  await auth.signOut()
  await wallet.disconnect()
}
</script>

<template>
  <div class="shell">
    <header class="header">
      <span class="brand">Omni<b>Market</b> <small class="muted">Vue shell</small></span>
      <nav v-if="wallet.isConnected" class="tabs" aria-label="Sections">
        <RouterLink v-for="tab in tabs" :key="tab.to" :to="tab.to" class="tab" active-class="tab-active">
          {{ tab.label }}<span v-if="tab.to === '/activity' && inFlight" class="count">{{ inFlight }}</span>
        </RouterLink>
      </nav>
      <span :class="['pill', `pill-${wallet.status}`]">{{ wallet.status }}</span>
    </header>

    <div v-if="wallet.isConnected" class="layout">
      <main class="main"><RouterView /></main>
      <aside class="aside">
        <AccountCard @disconnect="disconnect" />
        <SiweCard :auth="auth" />
      </aside>
    </div>
    <main v-else class="center"><ConnectCard /></main>

    <WalletConnectDialog />
  </div>
</template>
