<script setup lang="ts">
import { useOmni, useWalletConnect } from '@omnimarket/vue'
import { MOBILE_WALLETS, isMobileBrowser, pairingLink } from '@omnimarket/wallet-core/walletconnect'
import { computed, ref, watch } from 'vue'

/** Same behavior as the React dialog; a native `<dialog>` handles focus, Escape and the backdrop. */
const session = useOmni().walletConnect
const wc = useWalletConnect()
const dialog = ref<HTMLDialogElement>()
const copied = ref(false)
const mobile = isMobileBrowser()
const open = computed(() => wc.value.status === 'pairing')

watch(open, (isOpen) => {
  const element = dialog.value
  if (!element) return
  if (isOpen && !element.open) element.showModal()
  if (!isOpen && element.open) element.close()
})
watch(
  () => wc.value.uri,
  () => (copied.value = false),
)

function onClose() {
  // Fires for Escape and "Cancel" too: closing cancels the proposal.
  if (open.value) session?.cancelPairing()
}

async function copy() {
  if (!wc.value.uri) return
  await navigator.clipboard.writeText(wc.value.uri).catch(() => {})
  copied.value = true
}
</script>

<template>
  <dialog ref="dialog" class="wc-dialog" aria-labelledby="wc-title" @close="onClose">
    <h2 id="wc-title">{{ mobile ? 'Open your wallet' : 'Scan with your phone' }}</h2>
    <p v-if="!wc.uri" class="muted">Contacting the WalletConnect relay…</p>
    <template v-else>
      <ul v-if="mobile" class="links">
        <li v-for="item in MOBILE_WALLETS" :key="item.id">
          <a class="link" :href="pairingLink(item, wc.uri)" target="_blank" rel="noopener noreferrer">{{ item.name }}</a>
        </li>
        <li><a class="link" :href="wc.uri">Other wallet <span class="muted small">wc: link</span></a></li>
      </ul>
      <details :open="!mobile">
        <summary class="muted small">{{ mobile ? 'Show QR code for another device' : 'QR code' }}</summary>
        <omni-qr :value="wc.uri" label="WalletConnect pairing QR code" />
      </details>
      <p class="muted small">One approval connects every chain your wallet supports here: Ethereum, Solana and Sui.</p>
      <omni-button variant="secondary" @click="copy">{{ copied ? 'Copied' : 'Copy link' }}</omni-button>
    </template>
    <form method="dialog" class="actions">
      <button class="secondary">Cancel</button>
    </form>
  </dialog>
</template>
