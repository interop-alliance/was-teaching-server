/**
 * Tests for the `start.ts` entry point, run as a child process with piped
 * stdio: a startup failure reaches stderr and exits 1, a loopback `SERVER_URL`
 * on another port warns, and `SIGTERM` closes the server and exits 0.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

/**
 * Starts `src/start.ts` under tsx with `env` added to the environment.
 */
function startProcess(env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/start.ts'], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', chunk => (output.stdout += chunk))
  child.stderr.on('data', chunk => (output.stderr += chunk))
  const exited = new Promise<number | null>(resolve =>
    child.on('exit', code => resolve(code))
  )
  return { child, output, exited }
}

/**
 * A TCP port the OS reports free.
 */
async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, 'localhost', resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise(resolve => server.close(resolve))
  return port
}

describe('start.ts entry point', () => {
  let dataDir: string

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-start-'))
  })
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('a startup failure writes its message to a piped stderr and exits 1', async () => {
    const { output, exited } = startProcess({
      SERVER_URL: 'http://localhost:3002',
      PORT: '0x10',
      WAS_DATA_DIR: dataDir
    })
    assert.equal(await exited, 1)
    assert.match(output.stderr, /Server startup failed/)
    assert.match(output.stderr, /PORT must be an integer/)
  })

  it('SIGTERM closes the server and exits 0; a loopback port mismatch warns', async () => {
    const port = await freePort()
    const { child, output, exited } = startProcess({
      SERVER_URL: 'http://localhost:1',
      PORT: String(port),
      HOST: 'localhost',
      WAS_DATA_DIR: dataDir,
      STORAGE_LIMIT_PER_SPACE: 'unlimited'
    })
    const deadline = Date.now() + 15_000
    while (!output.stdout.includes('Server listening')) {
      assert.ok(
        Date.now() < deadline,
        `server never listened: ${output.stderr}`
      )
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.match(output.stdout, /SERVER_URL is a loopback URL on port 1/)
    const health = await fetch(`http://localhost:${port}/health`)
    assert.equal(health.status, 200)
    child.kill('SIGTERM')
    assert.equal(await exited, 0)
    assert.match(output.stdout, /Shutdown signal received/)
    assert.match(output.stdout, /Server closed/)
  }, 30_000)
})
