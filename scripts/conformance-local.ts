/**
 * One-shot local conformance runner.
 *
 * Spins up the WAS server on a fixed local URL, waits until it answers, runs the
 * standalone `conformance/` suite against it with a matching `TEST_SERVER_URL`,
 * then tears the server down (even if the suite fails). This guarantees the
 * `SERVER_URL` / `TEST_SERVER_URL` match that ZCap `invocationTarget`
 * verification requires — the two must be byte-identical host:port strings, or
 * the delegated-access tests 404.
 *
 * Override the port with `PORT=... pnpm conformance:local` if 3002 is taken; the
 * server URL and the test URL are both derived from it, so they stay in sync.
 *
 * Usage: pnpm conformance:local
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const port = process.env.PORT ?? '3002'
const serverUrl = `http://localhost:${port}`
const healthTimeoutMs = 15_000
const healthIntervalMs = 250

/**
 * Polls `GET <url>` until it responds OK or the timeout elapses.
 * @param url {string}
 * @returns {Promise<void>}
 */
async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + healthTimeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // server not accepting connections yet; keep polling
    }
    await new Promise(resolve => setTimeout(resolve, healthIntervalMs))
  }
  throw new Error(
    `Server did not become healthy at ${url} within ${healthTimeoutMs}ms`
  )
}

/**
 * The `conformance/*.test.ts` files, resolved here rather than via a shell glob
 * (this script spawns processes directly, without a shell to expand `*`).
 * @returns {string[]} repo-relative paths
 */
function conformanceTestFiles(): string[] {
  const dir = path.join(import.meta.dirname, '..', 'conformance')
  return readdirSync(dir)
    .filter(name => name.endsWith('.test.ts'))
    .map(name => path.join('conformance', name))
}

/**
 * Runs the conformance suite against `serverUrl`, inheriting stdio so its output
 * streams to the terminal.
 * @returns {Promise<number>} the suite's exit code
 */
function runConformance(): Promise<number> {
  return new Promise((resolve, reject) => {
    const suite = spawn('tsx', ['--test', ...conformanceTestFiles()], {
      env: { ...process.env, TEST_SERVER_URL: serverUrl },
      stdio: 'inherit'
    })
    suite.on('exit', code => resolve(code ?? 1))
    suite.on('error', reject)
  })
}

/**
 * Starts the server, captures its logs (only surfaced if startup fails so they
 * don't interleave with conformance output), runs the suite, and tears down.
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  const serverLogs: string[] = []
  const server: ChildProcess = spawn('tsx', ['src/start.ts'], {
    env: { ...process.env, SERVER_URL: serverUrl, PORT: port }
  })
  server.stdout?.on('data', chunk => serverLogs.push(chunk.toString()))
  server.stderr?.on('data', chunk => serverLogs.push(chunk.toString()))

  let exitCode = 1
  try {
    await waitForHealth(`${serverUrl}/health`)
    exitCode = await runConformance()
  } catch (err) {
    console.error((err as Error).message)
    if (serverLogs.length) {
      console.error('\n--- server output ---\n' + serverLogs.join(''))
    }
  } finally {
    server.kill('SIGTERM')
  }
  process.exit(exitCode)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
