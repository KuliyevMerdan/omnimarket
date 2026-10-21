import { useTransaction } from '@omnimarket/react'
import type { AnyTxRecord } from '@omnimarket/tx-engine'
import type { ReactNode } from 'react'

const BUSY: Partial<Record<AnyTxRecord['status'], (tx: AnyTxRecord) => string>> = {
  preparing: () => 'Checking…',
  awaiting_signature: () => 'Confirm in wallet…',
  pending: (tx) => (tx.stuck ? 'Still pending…' : 'Pending…'),
  confirming: (tx) => (tx.namespace === 'sui' ? 'Finalizing…' : `Confirming ${tx.confirmations}/${tx.requiredConfirmations}`),
}

/** A button that reflects the lifecycle of the transaction it started. */
export function TxButton({
  txId,
  onClick,
  disabled,
  className,
  children,
}: {
  txId: string | undefined
  onClick: () => void
  disabled?: boolean
  className?: string
  children: ReactNode
}) {
  const tx = useTransaction(txId)
  const busy = tx ? BUSY[tx.status]?.(tx) : undefined
  return (
    <button className={className} onClick={onClick} disabled={disabled || !!busy} aria-busy={!!busy}>
      {busy ?? children}
    </button>
  )
}
