import type { SiweSession } from '@omnimarket/auth'
import type { SiweClient } from '@omnimarket/auth/client'
import { useCallback, useEffect, useState } from 'react'
import { useAccount, useWalletManager } from './wallet'

export type SiweStatus = 'loading' | 'signed-out' | 'signing' | 'signed-in'

export interface UseSiwe {
  readonly status: SiweStatus
  readonly session: SiweSession | null
  readonly error: Error | null
  signIn(): Promise<void>
  signOut(): Promise<void>
}

export function useSiwe(client: SiweClient): UseSiwe {
  const manager = useWalletManager()
  const { address, namespace, status: walletStatus } = useAccount()
  const [session, setSession] = useState<SiweSession | null>(null)
  const [status, setStatus] = useState<SiweStatus>('loading')
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    let cancelled = false
    client
      .getSession()
      .then((s) => {
        if (cancelled) return
        setSession(s)
        setStatus(s ? 'signed-in' : 'signed-out')
      })
      .catch(() => !cancelled && setStatus('signed-out'))
    return () => {
      cancelled = true
    }
  }, [client])

  const signOut = useCallback(async () => {
    setSession(null)
    setStatus('signed-out')
    await client.signOut().catch(() => {})
  }, [client])

  // A session belongs to one address. If the user switches accounts in the wallet, the UI
  // must not keep acting as the old identity.
  useEffect(() => {
    if (session && walletStatus === 'connected' && address && !sameAccount(session, namespace, address)) {
      void signOut()
    }
  }, [session, walletStatus, namespace, address, signOut])

  const signIn = useCallback(async () => {
    setError(null)
    setStatus('signing')
    try {
      const next = await client.signIn(manager)
      setSession(next)
      setStatus('signed-in')
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
      setStatus('signed-out')
    }
  }, [client, manager])

  return { status, session, error, signIn, signOut }
}

/** EVM addresses are case-insensitive (EIP-55 is only a checksum); Solana base58 and Sui hex are exact. */
function sameAccount(session: SiweSession, namespace: string | undefined, address: string): boolean {
  if (session.namespace !== namespace) return false
  return namespace === 'eip155' ? session.address.toLowerCase() === address.toLowerCase() : session.address === address
}
