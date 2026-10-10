/**
 * Local performance check of the Postgres backend.
 *
 * Starts the server from this checkout as its own process, with
 * `DATABASE_URL` pointed at the schema `pnpm perf:pg:seed` already filled
 * (see `scripts/performance/perf-pg-seed.ts`), so the Postgres backend is always the one
 * measured. Runs the same load tests as `pnpm perf:fs` (see
 * `scripts/performance/perf-fs.ts`) against that pre-seeded data, prints one table
 * (Markdown, ready to paste), and stops the server. It measures the
 * checked-out code only: to compare two versions, run it on each; to compare
 * against the filesystem backend, run `pnpm perf:fs` with the same sizes and
 * read the two reports side by side.
 *
 * Unlike `pnpm perf:fs`, there is no over-HTTP seeding fallback: a run always
 * reads the schema, sizes, and signing identity `pnpm perf:pg:seed` recorded
 * in `.perf-pg-seed/seed-meta.json`, and fails with a message naming that
 * script if it is missing. Seeding into Postgres over the network one
 * signed request at a time is much slower than seeding straight through
 * `PostgresBackend`'s own write methods, so there is no reason to default to
 * the slow path the way `pnpm perf:fs` does.
 *
 * Each load test runs `--clients` concurrent clients for `--duration` seconds,
 * each client sending one request at a time:
 * - public read of one Resource, and public list, of each Collection size,
 *   with k6. Without k6 these rows are skipped, with a warning saying how to
 *   install it.
 * - signed read of one Resource of each size, and signed write (a new
 *   Resource) and signed delete in the smallest and the largest size, through
 *   `@interop/was-client`. A delete test runs in rounds: each client
 *   re-creates the same few Resources, untimed, then deletes them, timed, so
 *   the Collection stays near its size.
 *
 * Last, one client writes `--writes` new Resources in a row into the smallest
 * and the largest size.
 *
 * The seeded schema is left in place after the run, so it can be inspected or
 * reused for another run without reseeding; `pnpm perf:pg:seed` is what resets
 * it. The server's other settings come from the environment as usual, e.g.
 * `STORAGE_LIMIT_PER_SPACE=1000000000`. was-client retries a 5xx, so a failing
 * request can show as a slow one rather than a failure. The table and the
 * server log are kept in a temp dir, printed at the end.
 *
 * Usage: pnpm perf:pg:seed [--sizes 1,500,2000] first, then
 * pnpm perf:pg [--clients 5] [--duration 10] [--writes 100]
 * [--database-url postgres://was:was@localhost:5433/was]. Override the port
 * with `PORT=...` if 4455 is taken.
 */
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { cpus, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'

import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { WasClient } from '@interop/was-client'
import type { Collection } from '@interop/was-client'

import {
  deleteLoad,
  estimateMinutes,
  formatMachine,
  formatPivotedTable,
  formatProgressLine,
  formatScalingSummary,
  load,
  pivotRows,
  positiveInteger,
  serialWriteLoad,
  type Measurement,
  type Row
} from './perf-lib.js'

const port = process.env.PORT ?? '4455'
const serverUrl = `http://localhost:${port}`
const healthTimeoutMs = 30_000
const pauseMs = 2_000
const deleteRoundSize = 20
const warmUpWrites = 20
const seedDir = '.perf-pg-seed'

const { values: args } = parseArgs({
  options: {
    clients: { type: 'string', default: '5' },
    duration: { type: 'string', default: '10' },
    writes: { type: 'string', default: '100' },
    'database-url': { type: 'string' }
  }
})
const clients = positiveInteger(args.clients)
const durationSeconds = positiveInteger(args.duration)
const serialWrites = positiveInteger(args.writes)

/**
 * Refuses to start when anything already listens on the port, since the
 * health check would then reach that process instead of this server.
 * @returns {Promise<void>}
 */
function assertPortFree(): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', err =>
      reject(
        new Error(
          `Port ${port} is in use (${(err as NodeJS.ErrnoException).code}). ` +
            'Stop what is using it, or set PORT=...',
          { cause: err }
        )
      )
    )
    probe.listen(Number(port), () => probe.close(() => resolve()))
  })
}

/**
 * Returns the installed k6 version line, or undefined when k6 is not on PATH.
 * @returns {string | undefined}
 */
function findK6(): string | undefined {
  const result = spawnSync('k6', ['version'], { encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    return undefined
  }
  return result.stdout.trim().split(' ').slice(0, 2).join(' ')
}

/**
 * Describes the checked-out commit, marking uncommitted changes.
 * @returns {string}
 */
function describeCommit(): string {
  const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8'
  })
  if (head.status !== 0) {
    return 'unknown'
  }
  const status = spawnSync('git', ['status', '--porcelain'], {
    encoding: 'utf8'
  })
  const dirty = status.stdout.trim() !== ''
  return `${head.stdout.trim()}${dirty ? ' (with local changes)' : ''}`
}

/**
 * Describes the machine's CPU and RAM, so two compared runs can be checked
 * for a matching environment at a glance.
 * @returns {string}
 */
function describeMachine(): string {
  const [cpu] = cpus()
  return formatMachine({
    cpuModel: cpu?.model ?? 'unknown CPU',
    cores: cpus().length,
    totalMemoryBytes: totalmem()
  })
}

/**
 * Adds the seeded schema's `search_path` to a Postgres connection string via
 * the `options` query parameter (`options: -c search_path=<schema>`), the
 * same startup parameter `PostgresBackend`'s own `schema` option sets
 * internally -- so the spawned server lands in the seeded schema without any
 * config surface of its own needing to know about schemas.
 * @param options {object}
 * @param options.databaseUrl {string}
 * @param options.schema {string}
 * @returns {string}
 */
function withSchema({
  databaseUrl,
  schema
}: {
  databaseUrl: string
  schema: string
}): string {
  const url = new URL(databaseUrl)
  url.searchParams.set('options', `-c search_path=${schema}`)
  return url.toString()
}

/**
 * Starts `src/start.ts` on the Postgres backend, pointed at the seeded
 * schema, with its output going to `logPath`.
 * @param options {object}
 * @param options.databaseUrl {string}
 * @param options.logPath {string}
 * @returns {ChildProcess}
 */
function startServer({
  databaseUrl,
  logPath
}: {
  databaseUrl: string
  logPath: string
}): ChildProcess {
  const env = { ...process.env }
  delete env.WAS_ONBOARDING_TOKEN
  const server = spawn('tsx', ['src/start.ts'], {
    env: {
      ...env,
      SERVER_URL: serverUrl,
      PORT: port,
      DATABASE_URL: databaseUrl
    }
  })
  const log = createWriteStream(logPath)
  server.stdout?.pipe(log)
  server.stderr?.pipe(log)
  return server
}

/**
 * Polls `/health` until it answers OK, failing early if the server exits.
 * @param server {ChildProcess}
 * @returns {Promise<void>}
 */
async function waitForHealth(server: ChildProcess): Promise<void> {
  const deadline = Date.now() + healthTimeoutMs
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`The server exited with code ${server.exitCode}.`)
    }
    try {
      const response = await fetch(`${serverUrl}/health`)
      if (response.ok) {
        return
      }
    } catch {
      // not accepting connections yet; keep polling
    }
    await sleep(250)
  }
  throw new Error(
    `The server did not answer /health within ${healthTimeoutMs}ms.`
  )
}

/**
 * Stops the server and waits for it to exit.
 * @param server {ChildProcess}
 * @returns {Promise<void>}
 */
async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) {
    return
  }
  const exited = new Promise(resolve => server.once('exit', resolve))
  server.kill('SIGTERM')
  const timer = setTimeout(() => server.kill('SIGKILL'), 10_000)
  await exited
  clearTimeout(timer)
}

/**
 * Reads the `seed-meta.json` that `pnpm perf:pg:seed` wrote into
 * `.perf-pg-seed`, failing with a message that names that script when it is
 * missing or not a seed.
 * @returns {Promise<{
 *   seed: string, sizes: number[], edgeSizes: number[], schema: string,
 *   databaseUrl: string
 * }>}
 */
async function readSeedMeta(): Promise<{
  seed: string
  sizes: number[]
  edgeSizes: number[]
  schema: string
  databaseUrl: string
}> {
  const metaPath = join(seedDir, 'seed-meta.json')
  let text: string
  try {
    text = await readFile(metaPath, 'utf8')
  } catch (err) {
    throw new Error(
      `No seed at ${metaPath}. Run \`pnpm perf:pg:seed\` first.`,
      {
        cause: err
      }
    )
  }
  const meta = JSON.parse(text)
  if (
    typeof meta.seed !== 'string' ||
    !Array.isArray(meta.sizes) ||
    !Array.isArray(meta.edgeSizes) ||
    typeof meta.schema !== 'string' ||
    typeof meta.databaseUrl !== 'string'
  ) {
    throw new Error(
      `${metaPath} is not a seed-meta.json. Reseed with \`pnpm perf:pg:seed\`.`
    )
  }
  return meta
}

/**
 * Makes a client signing with the `did:key` `pnpm perf:pg:seed` reconstructs
 * (the identity it wrote Spaces under).
 * @param options {object}
 * @param options.seed {Uint8Array}
 * @returns {Promise<WasClient>}
 */
async function connect({ seed }: { seed: Uint8Array }): Promise<WasClient> {
  const keyPair = await Ed25519VerificationKey.generate({ seed })
  return WasClient.fromSigner({ serverUrl, signer: keyPair.didKeySigner() })
}

/**
 * Runs k6 against one public URL and reads its summary.
 * @param options {object}
 * @param options.path {string}
 * @param options.summaryPath {string}
 * @returns {Promise<Measurement>}
 */
async function k6Get({
  path,
  summaryPath
}: {
  path: string
  summaryPath: string
}): Promise<Measurement> {
  const output: string[] = []
  const exitCode = await new Promise<number>((resolve, reject) => {
    const k6 = spawn('k6', [
      'run',
      '--quiet',
      '--no-color',
      '-e',
      `BASE_URL=${serverUrl}`,
      '-e',
      `TARGET_PATH=${path}`,
      '-e',
      `VUS=${clients}`,
      '-e',
      `DURATION=${durationSeconds}s`,
      '-e',
      `SUMMARY_PATH=${summaryPath}`,
      'scripts/performance/perf-fs.k6.js'
    ])
    k6.stdout.on('data', chunk => output.push(chunk.toString()))
    k6.stderr.on('data', chunk => output.push(chunk.toString()))
    k6.on('exit', code => resolve(code ?? 1))
    k6.on('error', reject)
  })
  if (exitCode !== 0) {
    throw new Error(`k6 exited with code ${exitCode}:\n${output.join('')}`)
  }
  const { metrics } = JSON.parse(await readFile(summaryPath, 'utf8'))
  return {
    rate: metrics.http_reqs.values.rate,
    avgMs: metrics.http_req_duration.values.avg,
    failed: metrics.checks.values.fails
  }
}

/**
 * Prints a row as it completes and keeps it for the table, then pauses after
 * a test that ran, so the server settles before the next one.
 * @param options {object}
 * @param options.rows {Row[]}
 * @param options.row {Row}
 * @returns {Promise<void>}
 */
async function record({ rows, row }: { rows: Row[]; row: Row }): Promise<void> {
  rows.push(row)
  console.log(formatProgressLine(row))
  if (typeof row.result !== 'string') {
    await sleep(pauseMs)
  }
}

/**
 * The Spaces every measured test needs, built from what `pnpm perf:pg:seed`
 * already wrote to the seeded schema, under the fixed ids it used
 * (`perf-public`, `perf-private`, `perf-write-<size>`, `perf-delete-<size>`,
 * `perf-serial-<size>`). No I/O: `WasClient`'s Space/Collection handles are
 * lazy.
 */
interface TestTargets {
  publicSpaceId: string
  privateSpaceId: string
  edgeSpaces: Array<{
    size: number
    write: { path: string; collection: Collection }
    remove: { path: string; collection: Collection }
    serial: { path: string; collection: Collection }
  }>
}

/**
 * @param options {object}
 * @param options.was {WasClient}
 * @param options.edgeSizes {number[]}
 * @returns {TestTargets}
 */
function targetsFromSeed({
  was,
  edgeSizes
}: {
  was: WasClient
  edgeSizes: number[]
}): TestTargets {
  const edgeSpaces = edgeSizes.map(size => {
    const target = (label: string) => ({
      path: `/space/${label}-${size}/items`,
      collection: was.space(`${label}-${size}`).collection('items')
    })
    return {
      size,
      write: target('perf-write'),
      remove: target('perf-delete'),
      serial: target('perf-serial')
    }
  })
  return {
    publicSpaceId: 'perf-public',
    privateSpaceId: 'perf-private',
    edgeSpaces
  }
}

/**
 * Runs every measured test in order against the seeded Spaces.
 * @param options {object}
 * @param options.outDir {string}
 * @param options.k6Version {string | undefined}
 * @param options.was {WasClient}
 * @param options.sizes {number[]}
 * @param options.targets {TestTargets}
 * @returns {Promise<Row[]>}
 */
async function runTests({
  outDir,
  k6Version,
  was,
  sizes,
  targets
}: {
  outDir: string
  k6Version: string | undefined
  was: WasClient
  sizes: number[]
  targets: TestTargets
}): Promise<Row[]> {
  const { publicSpaceId, privateSpaceId, edgeSpaces } = targets
  await sleep(pauseMs)

  const rows: Row[] = []
  for (const [test, suffix] of [
    ['Public read', 'vc-1'],
    ['Public list', '']
  ] as const) {
    for (const size of sizes) {
      const path = `/space/${publicSpaceId}/c-${size}/${suffix}`
      const result = k6Version
        ? await k6Get({
            path,
            summaryPath: join(outDir, `k6-${rows.length}.json`)
          })
        : 'skipped (no k6)'
      await record({ rows, row: { test, size, result } })
    }
  }
  for (const size of sizes) {
    const path = `/space/${privateSpaceId}/c-${size}/vc-1`
    const result = await load({
      clients,
      durationSeconds,
      op: () => was.request({ path })
    })
    await record({ rows, row: { test: 'Signed read', size, result } })
  }
  for (const { size, write } of edgeSpaces) {
    const result = await load({
      clients,
      durationSeconds,
      op: (worker, count) =>
        was.request({
          path: `${write.path}/w-${worker}-${count}`,
          method: 'PUT',
          json: { worker, count }
        })
    })
    await record({ rows, row: { test: 'Signed write', size, result } })
  }
  for (const { size, remove } of edgeSpaces) {
    const result = await deleteLoad({
      clients,
      durationSeconds,
      deleteRoundSize,
      was,
      ...remove
    })
    await record({ rows, row: { test: 'Signed delete', size, result } })
  }
  for (const { size, serial } of edgeSpaces) {
    const result = await serialWriteLoad({
      was,
      path: serial.path,
      warmUpWrites,
      serialWrites
    })
    await record({
      rows,
      row: { test: `Write, 1 client (${serialWrites} in a row)`, size, result }
    })
  }
  return rows
}

/**
 * Starts the server against the seeded schema, runs the tests, prints and
 * saves the table, and stops the server. Unlike `pnpm perf:fs`, no data is
 * removed afterward: the seeded schema is left in place for inspection or
 * reuse, and `pnpm perf:pg:seed` is what resets it.
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  const meta = await readSeedMeta()
  const seed = Uint8Array.from(Buffer.from(meta.seed, 'base64'))
  const { sizes, edgeSizes, schema } = meta
  const baseDatabaseUrl =
    args['database-url'] ?? process.env.DATABASE_URL ?? meta.databaseUrl
  const databaseUrl = withSchema({ databaseUrl: baseDatabaseUrl, schema })

  await assertPortFree()
  const k6Version = findK6()
  if (!k6Version) {
    console.warn(
      [
        'Warning: k6 is not installed, so the public read and list tests are skipped.',
        'Install it, then run `pnpm perf:pg` again:',
        '  macOS:   brew install k6',
        '  Windows: winget install k6 --source winget',
        '  Linux and others: https://grafana.com/docs/k6/latest/set-up/install-k6/',
        ''
      ].join('\n')
    )
  }

  const outDir = await mkdtemp(join(tmpdir(), 'was-perf-pg-'))
  const logPath = join(outDir, 'server.log')
  const server = startServer({ databaseUrl, logPath })
  const cleanUp = () => stopServer(server)
  for (const [signal, exitCode] of [
    ['SIGINT', 130],
    ['SIGTERM', 143]
  ] as const) {
    process.once(signal, () => {
      cleanUp().finally(() => process.exit(exitCode))
    })
  }

  const header = [
    '## Postgres backend performance',
    '',
    `- Commit: ${describeCommit()}`,
    `- Date: ${new Date().toISOString()}`,
    `- Node ${process.version}, ${k6Version ?? 'k6 not installed'}`,
    `- ${describeMachine()}`,
    `- ${clients} clients, ${durationSeconds} s per load test`,
    `- Schema: ${schema}`,
    ''
  ]
  console.log(header.join('\n'))
  const minutes = estimateMinutes({
    sizes,
    edgeSizes,
    durationSeconds,
    serialWrites,
    warmUpWrites,
    pauseMs,
    withK6: k6Version !== undefined,
    filling: false
  })
  console.log(`Note: this run takes about ${minutes} minutes (an estimate).\n`)

  let rows: Row[]
  try {
    await waitForHealth(server)
    const was = await connect({ seed })
    const targets = targetsFromSeed({ was, edgeSizes })
    rows = await runTests({ outDir, k6Version, was, sizes, targets })
  } catch (err) {
    throw new Error(`${(err as Error).message}\nServer log: ${logPath}`, {
      cause: err
    })
  } finally {
    await cleanUp()
  }

  const pivoted = pivotRows({ sizes, rows })
  const report = [
    ...header,
    formatPivotedTable({ sizes, pivoted }),
    '',
    '## Summary',
    '',
    ...formatScalingSummary({ sizes, pivoted })
  ].join('\n')
  const summaryPath = join(outDir, 'summary.md')
  await writeFile(summaryPath, `${report}\n`)
  console.log(`\n${report}\n`)
  console.log(`Saved to ${summaryPath} (server log: ${logPath})`)
}

main().catch(err => {
  console.error(`\n${(err as Error).message}`)
  process.exit(1)
})
