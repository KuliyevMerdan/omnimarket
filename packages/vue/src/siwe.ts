import type { SiweSession } from '@omnimarket/auth'
import type { SiweClient } from '@omnimarket/auth/client'
import { readonly, ref, shallowRef, watch, type Ref } from 'vue'
import { useOmni } from './plugin'
import { useAccount, useWalletManager } from './wallet'

export type SiweStatus = 'loading' | 'signed-out' | 'signing' | 'signed-in'

export interface UseSiwe {
  readonly status: Readonly<Ref<SiweStatus>>
  readonly session: Readonly<Ref<SiweSession | null>>
  readonly error: Readonly<Ref<Error | null>>
  signIn(): Promise<void>
  signOut(): Promise<void>
}

/** Port of `useSiwe` from @omnimarket/react: same states, same account-switch rule. */
export function useSiwe(client: SiweClient | undefined = useOmni().siwe): UseSiwe {
  if (!client) throw new Error('createOmniVue({ siwe }) is not configured')
  const manager = useWalletManager()
  const account = useAccount()
  const session = shallowRef<SiweSession | null>(null)
  const status = ref<SiweStatus>('loading')
  const error = shallowRef<Error | null>(null)

  client
    .getSession()
    .then((s) => {
      session.value = s
      status.value = s ? 'signed-in' : 'signed-out'
    })
    .catch(() => (status.value = 'signed-out'))

  const signOut = async () => {
    session.value = null
    status.value = 'signed-out'
    await client.signOut().catch(() => {})
  }

  // A session belongs to one address: switching accounts in the wallet must not keep the old identity.
  watch([session, account], ([current, { status: walletStatus, namespace, address }]) => {
    if (current && walletStatus === 'connected' && address && !sameAccount(current, namespace, address)) void signOut()
  })

  const signIn = async () => {
    error.value = null
    status.value = 'signing'
    try {
      session.value = await client.signIn(manager)
      status.value = 'signed-in'
    } catch (e) {
      error.value = e instanceof Error ? e : new Error(String(e))
      status.value = 'signed-out'
    }
  }

  return { status: readonly(status), session: readonly(session), error: readonly(error), signIn, signOut }
}

function sameAccount(session: SiweSession, namespace: string | undefined, address: string): boolean {
  if (session.namespace !== namespace) return false
  return namespace === 'eip155' ? session.address.toLowerCase() === address.toLowerCase() : session.address === address
}
