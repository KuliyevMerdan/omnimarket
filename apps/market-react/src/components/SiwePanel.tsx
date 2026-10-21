import { useAccount, type UseSiwe } from '@omnimarket/react'
import { describeError } from '../errors'

export function SiwePanel({ auth }: { auth: UseSiwe }) {
  const { status, session, error, signIn, signOut } = auth
  const { namespace } = useAccount()
  const label = namespace === 'solana' ? 'Solana' : namespace === 'sui' ? 'Sui' : 'Ethereum'

  return (
    <section className="card">
      <h2>Sign-In with {label}</h2>
      <p className="muted small">
        {namespace === 'eip155' ? 'EIP-4361' : 'CAIP-122'} message with a single-use server nonce, bound to this origin and
        chain. The session lives in an HttpOnly cookie.
      </p>

      {status === 'loading' && <p className="muted">Checking session…</p>}

      {session ? (
        <>
          <dl className="kv">
            <dt>DID</dt>
            <dd>
              <code className="small">{session.did}</code>
            </dd>
            <dt>Expires</dt>
            <dd>{new Date(session.expiresAt).toLocaleString()}</dd>
          </dl>
          <button className="secondary" onClick={signOut}>
            Sign out
          </button>
        </>
      ) : (
        status !== 'loading' && (
          <button onClick={signIn} disabled={status === 'signing'}>
            {status === 'signing' ? 'Confirm in your wallet…' : 'Sign in'}
          </button>
        )
      )}

      {error && <p className="error">{describeError(error)}</p>}
    </section>
  )
}
