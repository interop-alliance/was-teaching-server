/**
 * One-shot local conformance runner.
 *
 * Spins up the WAS server on a fixed local URL, waits until it answers, runs
 * the `@interop/was-conformance-suite` CLI (`was-conformance`) against it, then
 * tears the server down (even if the suite fails). This guarantees the
 * `SERVER_URL` / conformance-target match that ZCap `invocationTarget`
 * verification requires — the two must be byte-identical host:port strings, or
 * the delegated-access tests 404.
 *
 * Override the port with `PORT=... pnpm conformance:local` if 3002 is taken;
 * the server URL and the CLI's target URL are both derived from it, so they
 * stay in sync. Extra arguments are forwarded to the CLI, e.g.
 * `pnpm conformance:local -- --grep chunk --reporter json`.
 *
 * Usage: pnpm conformance:local
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
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
 * Runs the `was-conformance` CLI against `serverUrl`, inheriting stdio so its
 * output streams to the terminal. The URL is passed positionally and must stay
 * byte-identical to the `SERVER_URL` the server was started with (ZCap
 * invocation targets embed host:port). Any CLI arguments given to this script
 * are forwarded through.
 * @returns {Promise<number>} the suite's exit code
 */
function runConformance(): Promise<number> {
  return new Promise((resolve, reject) => {
    const suite = spawn(
      'pnpm',
      ['exec', 'was-conformance', serverUrl, ...process.argv.slice(2)],
      { stdio: 'inherit' }
    )
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
