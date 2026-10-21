import { deployedChainIds } from '@omnimarket/contracts'
import { useWalletManager } from '@omnimarket/react'
import { evmChainId } from '@omnimarket/wallet-core'
import { useState, type ReactNode } from 'react'
import { findChain } from '../chains'
import { describeError } from '../errors'
import { useMarket } from '../lib/useMarket'

/** Renders children only on a chain with a deployed market; otherwise offers a switch. */
export function NetworkGate({ children }: { children: ReactNode }) {
  const manager = useWalletManager()
  const { deployment, chain } = useMarket()
  const [error, setError] = useState<unknown>(null)
  if (deployment) return children

  const available = deployedChainIds().map(findChain).filter((c) => c !== undefined)
  return (
    <section className="card">
      <h2>OmniMarket is not deployed on {chain?.name ?? 'this network'}</h2>
      {available.length === 0 ? (
        <p className="muted">
          No deployments yet. Locally, run <code>pnpm dev:chain</code> and <code>pnpm deploy:local</code>.
        </p>
      ) : (
        <div className="row wrap">
          {available.map((c) => (
            <button key={c.id} className="secondary" onClick={() => manager.switchChain(evmChainId(c.id)).catch(setError)}>
              Switch to {c.name}
            </button>
          ))}
        </div>
      )}
      {Boolean(error) && <p className="error">{describeError(error)}</p>}
    </section>
  )
}
