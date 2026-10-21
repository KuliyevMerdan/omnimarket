import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'

export const hasAnvil = spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status === 0

/** Anvil's default dev accounts — public keys, local chain only. */
export const ANVIL_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
] as const

export interface Anvil {
  readonly url: string
  stop(): void
}

export async function startAnvil(): Promise<Anvil> {
  const port = await freePort()
  const child: ChildProcess = spawn('anvil', ['--port', String(port), '--silent'], { stdio: 'ignore' })
  const url = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      })
      if (response.ok) return { url, stop: () => child.kill() }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  child.kill()
  throw new Error('anvil did not start')
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))))
    })
  })
}
