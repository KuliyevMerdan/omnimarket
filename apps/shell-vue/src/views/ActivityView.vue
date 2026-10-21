<script setup lang="ts">
import { explorerUrl, networkName } from '@omnimarket/app-core'
import { isEvmRecord, TERMINAL_STATUSES, type AnyTxRecord } from '@omnimarket/tx-engine'
import { computed } from 'vue'
import { useTxStore } from '../stores'

/** The shared history (EVM, Solana, Sui) rendered natively by the shell. */
const txs = useTxStore()
const finished = computed(() => txs.transactions.some((tx) => TERMINAL_STATUSES.has(tx.status)))

function where(tx: AnyTxRecord): string {
  return isEvmRecord(tx) ? networkName(`eip155:${tx.chainId}`) : networkName(tx.chain)
}

function link(tx: AnyTxRecord): { id: string; url: string | undefined } | null {
  if (isEvmRecord(tx)) {
    const hash = tx.replacement?.hash ?? tx.attempts.at(-1)?.hash
    return hash ? { id: hash, url: explorerUrl({ namespace: 'eip155', chainId: tx.chainId }, hash) } : null
  }
  const id = tx.namespace === 'solana' ? tx.signature : tx.digest
  return id ? { id, url: explorerUrl({ namespace: tx.namespace, chain: tx.chain }, id) } : null
}

function clearFinished() {
  for (const tx of txs.transactions) if (TERMINAL_STATUSES.has(tx.status)) txs.remove(tx.id)
}
</script>

<template>
  <section class="card">
    <div class="row between">
      <h2>Activity</h2>
      <omni-button v-if="finished" variant="ghost" size="sm" @click="clearFinished">Clear finished</omni-button>
    </div>
    <p v-if="txs.transactions.length === 0" class="muted">No transactions yet.</p>
    <ul class="activity">
      <li v-for="tx in txs.transactions" :key="tx.id">
        <div class="row between">
          <strong>{{ tx.label }}</strong>
          <omni-tx-status :status="tx.status" />
        </div>
        <div class="muted small">
          {{ where(tx) }} · {{ new Date(tx.createdAt).toLocaleTimeString() }}
          <template v-if="link(tx)">
            ·
            <a v-if="link(tx)!.url" :href="link(tx)!.url" target="_blank" rel="noopener noreferrer"><omni-address :value="link(tx)!.id" /></a>
            <omni-address v-else :value="link(tx)!.id" />
          </template>
        </div>
        <p v-if="tx.error" class="error small">{{ tx.error.message }}</p>
      </li>
    </ul>
  </section>
</template>
