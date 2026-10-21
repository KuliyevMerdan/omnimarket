import type { RpcTransport } from '@solana/kit'
import { describe, expect, it, vi } from 'vitest'
import { failover } from './solana'

const ok = (name: string) => vi.fn(async () => ({ jsonrpc: '2.0', id: 1, result: name })) as unknown as RpcTransport & ReturnType<typeof vi.fn>
const down = () => vi.fn(async () => Promise.reject(new Error('HTTP 429'))) as unknown as RpcTransport & ReturnType<typeof vi.fn>

describe('failover', () => {
  it('moves to the next endpoint on a transport error and sticks with it', async () => {
    const primary = down()
    const backup = ok('backup')
    const transport = failover([primary, backup])
    expect(await transport({ payload: {} })).toMatchObject({ result: 'backup' })
    expect(await transport({ payload: {} })).toMatchObject({ result: 'backup' })
    // The second call went straight to the endpoint that answered.
    expect(primary).toHaveBeenCalledTimes(1)
    expect(backup).toHaveBeenCalledTimes(2)
  })

  it('throws the last error when every endpoint fails, and does not retry an aborted request', async () => {
    await expect(failover([down(), down()])({ payload: {} })).rejects.toThrow('HTTP 429')
    const second = ok('second')
    const controller = new AbortController()
    controller.abort()
    await expect(failover([down(), second])({ payload: {}, signal: controller.signal })).rejects.toThrow()
    expect(second).not.toHaveBeenCalled()
  })
})
