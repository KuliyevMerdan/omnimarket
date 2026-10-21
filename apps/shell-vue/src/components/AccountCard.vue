<script setup lang="ts">
import { DEFAULT_CHAINS, describeError, networksFor } from '@omnimarket/app-core'
import { useWalletConnect } from '@omnimarket/vue'
import type { CaipChainId, ChainNamespace } from '@omnimarket/wallet-core'
import { walletConnectId } from '@omnimarket/wallet-core/walletconnect'
import { computed, ref, shallowRef } from 'vue'
import { useWalletStore } from '../stores'

defineEmits<{ disconnect: [] }>()

const ECOSYSTEMS: Record<ChainNamespace, string> = { eip155: 'EVM', solana: 'Solana', sui: 'Sui' }

const wallet = useWalletStore()
const wc = useWalletConnect()
const switching = ref(false)
const error = shallowRef<unknown>(null)

const info = computed(() => wallet.wallets.find((w) => w.id === wallet.account.walletId))
const viaWalletConnect = computed(() => info.value?.source === 'walletconnect')
const networks = computed(() => networksFor(wallet.account.namespace as ChainNamespace))
const supported = computed(() => networks.value.some((n) => n.caip === wallet.account.chainId))
const otherEcosystems = computed(() =>
  viaWalletConnect.value ? (Object.keys(wc.value.namespaces) as ChainNamespace[]).filter((ns) => ns !== wallet.account.namespace) : [],
)

async function run(action: () => Promise<unknown>) {
  error.value = null
  switching.value = true
  try {
    await action()
  } catch (e) {
    error.value = e
  } finally {
    switching.value = false
  }
}

const switchChain = (event: Event) => run(() => wallet.switchChain((event.target as HTMLSelectElement).value as CaipChainId))
/** Another namespace of the same WalletConnect session: no QR code, no wallet prompt. */
const switchEcosystem = (ns: ChainNamespace) => run(() => wallet.connect(walletConnectId(ns), { chainId: DEFAULT_CHAINS[ns] }))
</script>

<template>
  <section class="card">
    <h2>Wallet</h2>
    <div>{{ viaWalletConnect && wc.peer ? `${wc.peer.name} · WalletConnect` : info?.name }}</div>
    <omni-address :value="wallet.account.address" :chars="6" />

    <label class="field">
      <span class="muted small">Network</span>
      <select :value="supported ? wallet.account.chainId : ''" :disabled="switching" @change="switchChain">
        <option v-if="!supported" value="">Unsupported ({{ wallet.account.chainId }})</option>
        <option v-for="n in networks" :key="n.caip" :value="n.caip">{{ n.name }}</option>
      </select>
    </label>
    <p v-if="!supported" class="warning">Your wallet is on a network this app does not support.</p>

    <div v-if="otherEcosystems.length" class="row">
      <span class="muted small">Same session:</span>
      <omni-button v-for="ns in otherEcosystems" :key="ns" variant="secondary" size="sm" @click="switchEcosystem(ns)">
        Use {{ ECOSYSTEMS[ns] }}
      </omni-button>
    </div>
    <p v-if="viaWalletConnect && wc.expiresAt" class="muted small">
      Session valid until {{ new Date(wc.expiresAt).toLocaleString() }}
    </p>
    <p v-if="error" class="error">{{ describeError(error) }}</p>

    <omni-button variant="secondary" @click="$emit('disconnect')">Disconnect</omni-button>
  </section>
</template>
