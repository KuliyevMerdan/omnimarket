<script setup lang="ts">
import { describeError } from '@omnimarket/app-core'
import type { UseSiwe } from '@omnimarket/vue'
import { computed } from 'vue'
import { useWalletStore } from '../stores'

const props = defineProps<{ auth: UseSiwe }>()
const wallet = useWalletStore()
const title = computed(() => (wallet.account.namespace === 'eip155' ? 'Sign-In with Ethereum' : 'Sign in (CAIP-122)'))
const { status, session, error } = props.auth
</script>

<template>
  <section class="card">
    <h2>{{ title }}</h2>
    <template v-if="status === 'signed-in' && session">
      <p class="small">Signed in as <omni-address :value="session.address" /></p>
      <omni-button variant="secondary" @click="auth.signOut()">Sign out</omni-button>
    </template>
    <template v-else>
      <p class="muted small">A signed message with a single-use server nonce, bound to this origin and chain.</p>
      <omni-button :busy="status === 'signing'" :disabled="status === 'loading'" @click="auth.signIn()">Sign in</omni-button>
    </template>
    <p v-if="error" class="error">{{ describeError(error) }}</p>
  </section>
</template>
