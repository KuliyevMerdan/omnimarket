<script setup lang="ts">
import { DEFAULT_CHAINS, describeError } from '@omnimarket/app-core'
import { useOmni, useWalletConnect } from '@omnimarket/vue'
import type { ChainNamespace, WalletInfo } from '@omnimarket/wallet-core'
import { WALLETCONNECT_ICON, walletConnectId } from '@omnimarket/wallet-core/walletconnect'
import { computed, ref } from 'vue'
import { useWalletStore } from '../stores'

const wallet = useWalletStore()
const session = useOmni().walletConnect
const wc = useWalletConnect()
const pendingId = ref<string | null>(null)

const GROUPS: { namespace: ChainNamespace; title: string }[] = [
  { namespace: 'eip155', title: 'Ethereum & EVM · EIP-6963' },
  { namespace: 'solana', title: 'Solana · Wallet Standard' },
  { namespace: 'sui', title: 'Sui · Wallet Standard' },
]
const PREFERENCE: readonly ChainNamespace[] = ['eip155', 'solana', 'sui']

const groups = computed(() =>
  GROUPS.map((g) => ({ ...g, wallets: wallet.wallets.filter((w) => w.source !== 'walletconnect' && w.namespace === g.namespace) })).filter(
    (g) => g.wallets.length > 0,
  ),
)
const busy = computed(() => wallet.status === 'connecting' || wc.value.status === 'pairing')
const error = computed(() => wallet.error ?? wc.value.error)

async function connect(info: WalletInfo) {
  pendingId.value = info.id
  // Errors land in the manager's state (`wallet.error`).
  await wallet.connect(info.id, { chainId: DEFAULT_CHAINS[info.namespace] }).catch(() => {})
  pendingId.value = null
}

/** One QR scan for all ecosystems; then connect the first namespace the wallet approved. */
async function connectWalletConnect() {
  if (!session) return
  pendingId.value = 'walletconnect'
  try {
    const approved = await session.pair()
    const namespace = PREFERENCE.find((ns) => approved[ns])
    if (namespace) await wallet.connect(walletConnectId(namespace), { chainId: DEFAULT_CHAINS[namespace] })
  } catch {
    // Shown through `error`.
  } finally {
    pendingId.value = null
  }
}
</script>

<template>
  <section class="card card-wide">
    <h2>Connect a wallet</h2>
    <p v-if="wallet.status === 'reconnecting'" class="muted">Restoring your previous session…</p>

    <div v-if="session" class="group">
      <h3 class="muted small">Mobile wallet · WalletConnect v2</h3>
      <omni-wallet-option
        name="WalletConnect"
        :icon="WALLETCONNECT_ICON"
        detail="EVM · Solana · Sui"
        :busy="pendingId === 'walletconnect'"
        :disabled="busy"
        @omni-select="connectWalletConnect"
      />
    </div>

    <div v-for="group in groups" :key="group.namespace" class="group">
      <h3 class="muted small">{{ group.title }}</h3>
      <omni-wallet-option
        v-for="info in group.wallets"
        :key="info.id"
        :name="info.name"
        :icon="info.icon"
        :detail="info.source"
        :busy="pendingId === info.id"
        :disabled="busy"
        @omni-select="connect(info)"
      />
    </div>
    <p v-if="groups.length === 0" class="muted">
      No browser wallets detected. Install an EIP-6963 wallet (MetaMask, Rabby) or a Wallet Standard wallet for Solana or Sui{{
        session ? ', or use a mobile wallet through WalletConnect.' : '.'
      }}
    </p>

    <p v-if="error" class="error">{{ describeError(error) }}</p>
  </section>
</template>
