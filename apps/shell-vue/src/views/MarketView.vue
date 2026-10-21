<script setup lang="ts">
import { MARKET_REMOTE_VERSION, type MarketMountHandle, type MarketPage } from '@omnimarket/app-core'
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { core } from '../core'

/**
 * Hosts the React marketplace (Module Federation remote). The remote is loaded on first visit, gets
 * the shell's core, and is isolated from failures: if it can't be loaded or is an incompatible
 * version, the shell keeps working and offers a retry.
 */
const props = defineProps<{ page: MarketPage }>()
const container = ref<HTMLElement>()
const error = shallowRef<Error | null>(null)
const loading = ref(true)
let handle: MarketMountHandle | null = null
let disposed = false

async function load() {
  error.value = null
  loading.value = true
  try {
    const remote = await import('market/market')
    if (remote.version !== MARKET_REMOTE_VERSION) {
      throw new Error(`The marketplace (v${remote.version}) is not compatible with this shell (v${MARKET_REMOTE_VERSION}).`)
    }
    if (disposed || !container.value) return
    handle = remote.mount(container.value, { core, page: props.page })
  } catch (e) {
    error.value = e instanceof Error ? e : new Error(String(e))
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(
  () => props.page,
  (page) => handle?.update({ core, page }),
)
onBeforeUnmount(() => {
  disposed = true
  handle?.unmount()
  handle = null
})
</script>

<template>
  <div>
    <p v-if="loading" class="muted">Loading the marketplace…</p>
    <section v-if="error" class="card" role="alert">
      <h2>Marketplace unavailable</h2>
      <p class="muted">{{ error.message }}</p>
      <omni-button variant="secondary" @click="load">Retry</omni-button>
    </section>
    <!-- React owns everything inside this element. -->
    <div ref="container" />
  </div>
</template>
