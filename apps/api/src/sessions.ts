import type { SiweSession } from '@omnimarket/auth'

export interface StoredSession extends Omit<SiweSession, 'expiresAt'> {
  readonly id: string
  readonly expiresAt: number
}

export interface SessionStore {
  create(data: Omit<StoredSession, 'id'>): StoredSession
  get(id: string): StoredSession | undefined
  delete(id: string): void
}

/** Opaque random ids in an HttpOnly cookie: revocable server-side, unlike a bare JWT. */
export function createMemorySessionStore(now: () => number = Date.now): SessionStore {
  const sessions = new Map<string, StoredSession>()
  return {
    create(data) {
      const id = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
      const session = { ...data, id }
      sessions.set(id, session)
      return session
    },
    get(id) {
      const session = sessions.get(id)
      if (session && session.expiresAt <= now()) {
        sessions.delete(id)
        return undefined
      }
      return session
    },
    delete(id) {
      sessions.delete(id)
    },
  }
}

export function toPublicSession({ did, namespace, address, chainId, expiresAt }: StoredSession): SiweSession {
  return { did, namespace, address, chainId, expiresAt: new Date(expiresAt).toISOString() }
}
