/**
 * The process plumbing `pnpm perf:fs` and `pnpm perf:pg` share: the shared
 * CLI options, running the server under test as its own process, k6, the
 * Collection-size tests themselves, and the printed and saved report. Each
 * runner supplies only how its backend is prepared, pointed at, and torn
 * down. `pnpm perf:remote` reuses the tests and the report against a deployed
 * server, with no process of its own to start.
 */
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { cpus, totalmem } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { PwsClient } from '@interop/pws-client'
import type { Collection } from '@interop/pws-client'

import {
  backendCell,
  backendPool,
  deleteLoad,
  describePool,
  edgeSpaceLabels,
  estimateMinutes,
  formatMachine,
  formatMatrixProgressLine,
  formatMatrixTable,
  formatPivotedTable,
  formatProgressLine,
  formatScalingSummary,
  k6Measurement,
  load,
  pivotRows,
  poolBackends,
  seedResourceCount,
  serialWriteLoad,
  serverPathUrl,
  type EncryptedReadIds,
  type LoadSettings,
  type MatrixRow,
  type BackendShare,
  type Measurement,
  type PoolMember,
  type PoolTarget,
  type Row,
  type ServerBackendId
} from './perf-lib.js'
import { runMatrix } from './perf-matrix-run.js'

export const port = process.env.PORT ?? '4455'
// The server `runAgainstServer` starts. A run against a deployed server
// (`pnpm perf:remote`) passes its own URL to `connect` and `unsignedReader`.
export const localServerUrl = `http://localhost:${port}`
const healthTimeoutMs = 30_000
const pauseMs = 2_000
const deleteRoundSize = 20
const warmUpWrites = 20

/**
 * The `parseArgs` options both runners take, read by `parseLoadSettings`.
 */
export const loadTestOptions = {
  clients: { type: 'string', default: '5' },
  duration: { type: 'string', default: '10' },
  writes: { type: 'string', default: '100' },
  'large-file-clients': { type: 'string' }
} as const

/**
 * The pids listening on the port, from `lsof`, or undefined where `lsof` is
 * not installed.
 * @returns {number[] | undefined}
 */
function listenersOnPort(): number[] | undefined {
  const result = spawnSync(
    'lsof',
    ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
    { encoding: 'utf8' }
  )
  if (result.error) {
    return undefined
  }
  // lsof exits 1, printing nothing, when no process matches.
  return [...new Set(result.stdout.split('\n').filter(Boolean).map(Number))]
}

/**
 * Sends `signal` to `pid`, ignoring a process that has already exited.
 * @param options {object}
 * @param options.pid {number}
 * @param options.signal {NodeJS.Signals}
 * @returns {void}
 */
function signalProcess({
  pid,
  signal
}: {
  pid: number
  signal: NodeJS.Signals
}): void {
  try {
    process.kill(pid, signal)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      return
    }
    throw new Error(
      `Could not stop pid ${pid}, which listens on port ${port} ` +
        `(${(err as NodeJS.ErrnoException).code}). Stop it yourself, or set ` +
        'PORT=...',
      { cause: err }
    )
  }
}

/**
 * Waits until nothing listens on the port, for up to `timeoutMs`.
 * @param timeoutMs {number}
 * @returns {Promise<boolean>} whether the port came free in time
 */
async function waitForPortFree(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while ((listenersOnPort() ?? []).length > 0) {
    if (Date.now() > deadline) {
      return false
    }
    await sleep(250)
  }
  return true
}

/**
 * Where `lsof` is missing: refuses to start when anything already listens on
 * the port, since the health check would then reach that process instead of
 * this server.
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
 * Stops whatever listens on the port, so this run's server can bind it: a
 * server left behind, or another perf run's (which then fails, since its
 * server exited). Sends SIGTERM, then SIGKILL after 10 s, and names each
 * process it stops.
 * @returns {Promise<void>}
 */
async function freePort(): Promise<void> {
  const pids = listenersOnPort()
  if (pids === undefined) {
    await assertPortFree()
    return
  }
  if (pids.length === 0) {
    return
  }
  for (const pid of pids) {
    const command = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8'
    }).stdout.trim()
    console.warn(
      `Port ${port} is taken by pid ${pid} (${command || 'unknown command'}); ` +
        'stopping it.'
    )
    signalProcess({ pid, signal: 'SIGTERM' })
  }
  if (await waitForPortFree(10_000)) {
    return
  }
  for (const pid of listenersOnPort() ?? []) {
    signalProcess({ pid, signal: 'SIGKILL' })
  }
  if (!(await waitForPortFree(5_000))) {
    throw new Error(
      `Port ${port} is still in use after stopping what listened on it. ` +
        'Stop it yourself, or set PORT=...'
    )
  }
}

/**
 * Returns the installed k6 version line, or undefined when k6 is not on PATH,
 * in which case it warns that the public read tests are skipped and how to
 * install k6.
 * @param options {object}
 * @param options.rerunCommand {string}   the command to run again afterward
 * @returns {string | undefined}
 */
export function findK6({
  rerunCommand
}: {
  rerunCommand: string
}): string | undefined {
  const result = spawnSync('k6', ['version'], { encoding: 'utf8' })
  if (!result.error && result.status === 0) {
    return result.stdout.trim().split(' ').slice(0, 2).join(' ')
  }
  console.warn(
    [
      'Warning: k6 is not installed, so the public read and list tests are skipped.',
      `Install it, then run \`${rerunCommand}\` again:`,
      '  macOS:   brew install k6',
      '  Windows: winget install k6 --source winget',
      '  Linux and others: https://grafana.com/docs/k6/latest/set-up/install-k6/',
      ''
    ].join('\n')
  )
  return undefined
}

/**
 * Describes the checked-out commit, marking uncommitted changes.
 * @returns {string}
 */
export function describeCommit(): string {
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
export function describeMachine(): string {
  const [cpu] = cpus()
  return formatMachine({
    cpuModel: cpu?.model ?? 'unknown CPU',
    cores: cpus().length,
    totalMemoryBytes: totalmem()
  })
}

/**
 * The report's header lines, printed before the run and repeated in the
 * saved report.
 * @param options {object}
 * @param options.title {string}
 * @param options.k6Version {string | undefined}
 * @param options.settings {LoadSettings}
 * @param [options.extraLines] {string[]}   more `- ...` lines, last
 * @param [options.startedAt] {Date}   the date the header shows; now by
 *   default
 * @returns {string[]}
 */
export function reportHeader({
  title,
  k6Version,
  settings,
  extraLines = [],
  startedAt = new Date()
}: {
  title: string
  k6Version: string | undefined
  settings: LoadSettings
  extraLines?: string[]
  startedAt?: Date
}): string[] {
  return [
    `## ${title}`,
    '',
    `- Commit: ${describeCommit()}`,
    `- Date: ${startedAt.toISOString()}`,
    `- Node ${process.version}, ${k6Version ?? 'k6 not installed'}`,
    `- ${describeMachine()}`,
    `- ${settings.clients} clients, ${settings.durationSeconds} s per load test` +
      (settings.largeFileClients === settings.clients
        ? ''
        : `; ${settings.largeFileClients} for the 10 MiB file`),
    ...extraLines,
    ''
  ]
}

/**
 * Prints how long the run will take, from `estimateMinutes`, and for a run
 * whose tests spread over a pool of Collections, the pool and how many
 * Resources filling it writes.
 * @param options {object}
 * @param options.sizes {number[]}
 * @param options.edgeSizes {number[]}
 * @param options.settings {LoadSettings}
 * @param options.k6Version {string | undefined}
 * @param options.filling {boolean}
 * @param [options.matrix] {boolean}
 * @param [options.split] {BackendShare[]}   the split whose pool each test
 *   spreads its load over; a pool of one by default
 * @returns {void}
 */
export function printEstimate({
  sizes,
  edgeSizes,
  settings,
  k6Version,
  filling,
  matrix,
  split
}: {
  sizes: number[]
  edgeSizes: number[]
  settings: LoadSettings
  k6Version: string | undefined
  filling: boolean
  matrix?: boolean
  split?: BackendShare[]
}): void {
  const poolSize = backendPool(split).length
  const minutes = estimateMinutes({
    sizes,
    edgeSizes,
    durationSeconds: settings.durationSeconds,
    serialWrites: settings.serialWrites,
    warmUpWrites,
    pauseMs,
    withK6: k6Version !== undefined,
    filling,
    matrix,
    poolSize
  })
  if (split !== undefined) {
    const resources = seedResourceCount({ sizes, edgeSizes, poolSize })
    console.log(
      `Pool: ${describePool(split)}; filling writes ` +
        `${resources.toLocaleString('en-US')} Resources before the matrix.`
    )
  }
  console.log(`Note: this run takes about ${minutes} minutes (an estimate).\n`)
}

/**
 * Where the server's output goes inside a run's temp dir.
 * @param outDir {string}
 * @returns {string}
 */
function serverLogPath(outDir: string): string {
  return join(outDir, 'server.log')
}

/**
 * Starts `src/start.ts` with `env` over the environment, open for Space
 * creation (`WAS_ONBOARDING_TOKEN` cleared), with its output going to the
 * run's server log.
 * @param options {object}
 * @param options.env {Record<string, string | undefined>}   an `undefined`
 *   value clears that variable
 * @param options.outDir {string}
 * @returns {ChildProcess}
 */
function startServer({
  env,
  outDir
}: {
  env: Record<string, string | undefined>
  outDir: string
}): ChildProcess {
  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    SERVER_URL: localServerUrl,
    PORT: port,
    ...env
  }
  delete serverEnv.WAS_ONBOARDING_TOKEN
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) {
      delete serverEnv[name]
    }
  }
  const server = spawn('tsx', ['src/start.ts'], { env: serverEnv })
  const log = createWriteStream(serverLogPath(outDir))
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
      const response = await fetch(`${localServerUrl}/health`)
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
 * Frees the port, starts the server, waits for it to answer, runs `run`
 * against it, and stops it again (then runs `afterStop`), even when `run`
 * fails or the process is interrupted. The run fails as soon as the server
 * exits early. A failure names the server log.
 * @param options {object}
 * @param options.env {Record<string, string | undefined>}   see `startServer`
 * @param options.outDir {string}
 * @param options.run {() => Promise<Result>}
 * @param [options.afterStop] {() => Promise<unknown>}
 * @returns {Promise<Result>} what `run` returned
 */
export async function runAgainstServer<Result>({
  env,
  outDir,
  run,
  afterStop
}: {
  env: Record<string, string | undefined>
  outDir: string
  run: () => Promise<Result>
  afterStop?: () => Promise<unknown>
}): Promise<Result> {
  await freePort()
  const server = startServer({ env, outDir })
  let stopping = false
  const cleanUp = async () => {
    stopping = true
    await stopServer(server)
    await afterStop?.()
  }
  // Fails the run the moment this server exits early (e.g. it lost the port
  // to a run started at the same instant), so no test is measured against
  // whatever else answers on the port.
  const serverDied = new Promise<never>((_resolve, reject) => {
    server.once('exit', (code, signal) => {
      if (!stopping) {
        reject(
          new Error(
            `The server under test exited (${signal ?? `code ${code}`}) ` +
              'before the run finished.'
          )
        )
      }
    })
  })
  serverDied.catch(() => undefined)
  for (const [signal, exitCode] of [
    ['SIGINT', 130],
    ['SIGTERM', 143]
  ] as const) {
    process.once(signal, () => {
      cleanUp().finally(() => process.exit(exitCode))
    })
  }
  try {
    return await Promise.race([
      waitForHealth(server).then(() => run()),
      serverDied
    ])
  } catch (err) {
    throw new Error(
      `${(err as Error).message}\nServer log: ${serverLogPath(outDir)}`,
      { cause: err }
    )
  } finally {
    await cleanUp()
  }
}

/**
 * Makes a client of the server at `serverUrl`, signing with the `did:key`
 * `seed` derives: the identity the seeded Spaces were written under.
 * @param options {object}
 * @param options.serverUrl {string}   the server's base server URL
 * @param options.seed {Uint8Array}
 * @returns {Promise<PwsClient>}
 */
export async function connect({
  serverUrl,
  seed
}: {
  serverUrl: string
  seed: Uint8Array
}): Promise<PwsClient> {
  const keyPair = await Ed25519VerificationKey.generate({ seed })
  return PwsClient.fromSigner({
    baseServerUrl: serverUrl,
    signer: keyPair.didKeySigner()
  })
}

/**
 * Runs k6 against public URLs, round-robin, and reads its summary.
 * @param options {object}
 * @param options.serverUrl {string}   the server's base URL
 * @param options.targets {PoolTarget[]}
 * @param options.summaryPath {string}
 * @param options.settings {LoadSettings}
 * @returns {Promise<Measurement>}
 */
async function k6Get({
  serverUrl,
  targets,
  summaryPath,
  settings
}: {
  serverUrl: string
  targets: PoolTarget[]
  summaryPath: string
  settings: LoadSettings
}): Promise<Measurement> {
  const output: string[] = []
  const { exitCode, signal } = await new Promise<{
    exitCode: number | null
    signal: NodeJS.Signals | null
  }>((resolve, reject) => {
    const k6 = spawn('k6', [
      'run',
      '--quiet',
      '--no-color',
      '-e',
      `BASE_URL=${serverUrl}`,
      '-e',
      `TARGETS=${JSON.stringify(targets)}`,
      '-e',
      `VUS=${settings.clients}`,
      '-e',
      `DURATION=${settings.durationSeconds}s`,
      '-e',
      `SUMMARY_PATH=${summaryPath}`,
      'scripts/performance/perf-unsigned-get.k6.js'
    ])
    k6.stdout.on('data', chunk => output.push(chunk.toString()))
    k6.stderr.on('data', chunk => output.push(chunk.toString()))
    k6.on('exit', (code, killedBy) =>
      resolve({ exitCode: code, signal: killedBy })
    )
    k6.on('error', reject)
  })
  if (signal) {
    // The kernel's out-of-memory killer sends SIGKILL, and k6 prints nothing.
    throw new Error(
      `k6 was killed by ${signal}` +
        (signal === 'SIGKILL' ? ' (out of memory?)' : '') +
        `:\n${output.join('')}`
    )
  }
  if (exitCode !== 0) {
    throw new Error(`k6 exited with code ${exitCode}:\n${output.join('')}`)
  }
  const { metrics } = JSON.parse(await readFile(summaryPath, 'utf8'))
  return k6Measurement({ metrics, backends: poolBackends(targets) })
}

/**
 * The unsigned public read every test of public URLs goes through: k6 when
 * it is installed, each run keeping its summary in `outDir`, or else the skip
 * string.
 * @param options {object}
 * @param options.serverUrl {string}   the server's base URL
 * @param options.outDir {string}
 * @param options.k6Version {string | undefined}
 * @param options.settings {LoadSettings}
 * @returns {(targets: PoolTarget[], clients?: number) => Promise<Measurement | string>}
 */
export function unsignedReader({
  serverUrl,
  outDir,
  k6Version,
  settings
}: {
  serverUrl: string
  outDir: string
  k6Version: string | undefined
  settings: LoadSettings
}): (targets: PoolTarget[], clients?: number) => Promise<Measurement | string> {
  let runs = 0
  return async (targets, clients = settings.clients) => {
    if (!k6Version) {
      return 'skipped (no k6)'
    }
    const summaryPath = join(outDir, `k6-${runs++}.json`)
    return k6Get({
      serverUrl,
      targets,
      summaryPath,
      settings: { ...settings, clients }
    })
  }
}

/**
 * Pauses after a test that ran, so the server settles before the next one.
 * A skipped test needs no pause.
 * @param result {Measurement | string}
 * @returns {Promise<void>}
 */
export async function settleAfter(result: Measurement | string): Promise<void> {
  if (typeof result !== 'string') {
    await sleep(pauseMs)
  }
}

/**
 * Prints a row as it completes and keeps it for the table, then settles.
 * @param options {object}
 * @param options.rows {Row[]}
 * @param options.row {Row}
 * @returns {Promise<void>}
 */
async function record({ rows, row }: { rows: Row[]; row: Row }): Promise<void> {
  rows.push(row)
  console.log(formatProgressLine(row))
  await settleAfter(row.result)
}

/**
 * A Collection a test writes to: its path, with no trailing slash, its
 * backend, and its handle.
 */
export interface EdgeTarget extends PoolTarget {
  collection: Collection
}

/**
 * The Spaces every measured test needs. The size Collections are
 * `c-<size><suffix>` in the public and the private Space, one per `pool`
 * member, and each edge test has one Collection per member.
 */
export interface TestTargets {
  publicSpaceId: string
  privateSpaceId: string
  pool: PoolMember[]
  edgeSpaces: Array<{
    size: number
    write: EdgeTarget[]
    remove: EdgeTarget[]
    serial: EdgeTarget[]
  }>
}

/**
 * Builds handles for the Spaces a seed script already wrote, under the fixed
 * ids `seedSizeSpaces` (in `perf-lib.ts`) uses: `perf-public`,
 * `perf-private`, and `edgeSpaceLabels`' three per edge size, each with a
 * pool of one Collection on the server's default backend. No I/O:
 * `PwsClient`'s Space/Collection handles are lazy.
 * @param options {object}
 * @param options.pws {PwsClient}
 * @param options.edgeSizes {number[]}
 * @returns {TestTargets}
 */
export function seededTargets({
  pws,
  edgeSizes
}: {
  pws: PwsClient
  edgeSizes: number[]
}): TestTargets {
  const edgeSpaces = edgeSizes.map(size => {
    const target = (label: string): EdgeTarget[] => [
      {
        path: `/space/${label}-${size}/items`,
        collection: pws.space(`${label}-${size}`).collection('items')
      }
    ]
    return {
      size,
      write: target(edgeSpaceLabels.write),
      remove: target(edgeSpaceLabels.remove),
      serial: target(edgeSpaceLabels.serial)
    }
  })
  return {
    publicSpaceId: 'perf-public',
    privateSpaceId: 'perf-private',
    pool: backendPool(),
    edgeSpaces
  }
}

/**
 * Runs every Collection-size test in order against already-seeded Spaces,
 * each one spread over its pool of Collections.
 * @param options {object}
 * @param options.pws {PwsClient}
 * @param options.sizes {number[]}
 * @param options.targets {TestTargets}
 * @param options.settings {LoadSettings}
 * @param options.publicRead {(targets: PoolTarget[], clients?: number) => Promise<Measurement | string>}
 *   see `unsignedReader`
 * @returns {Promise<Row[]>}
 */
export async function runTests({
  pws,
  sizes,
  targets,
  settings,
  publicRead
}: {
  pws: PwsClient
  sizes: number[]
  targets: TestTargets
  settings: LoadSettings
  publicRead: (
    targets: PoolTarget[],
    clients?: number
  ) => Promise<Measurement | string>
}): Promise<Row[]> {
  const { publicSpaceId, privateSpaceId, pool, edgeSpaces } = targets
  const { clients, durationSeconds, serialWrites } = settings
  // The same path in each pool member's size Collection.
  const sizeTargets = ({
    spaceId,
    size,
    path
  }: {
    spaceId: string
    size: number
    path: string
  }): PoolTarget[] =>
    pool.map(({ backend, suffix }) => ({
      path: `/space/${spaceId}/c-${size}${suffix}/${path}`,
      backend
    }))
  await sleep(pauseMs)

  const rows: Row[] = []
  for (const [test, path] of [
    ['Public read', 'vc-1'],
    ['Public list', '']
  ] as const) {
    for (const size of sizes) {
      const result = await publicRead(
        sizeTargets({ spaceId: publicSpaceId, size, path })
      )
      await record({ rows, row: { test, size, result } })
    }
  }
  for (const size of sizes) {
    const result = await load({
      clients,
      durationSeconds,
      pool: sizeTargets({ spaceId: privateSpaceId, size, path: 'vc-1' }),
      op: ({ path }) => pws.request({ url: serverPathUrl({ pws, path }) })
    })
    await record({ rows, row: { test: 'Signed read', size, result } })
  }
  for (const { size, write } of edgeSpaces) {
    const result = await load({
      clients,
      durationSeconds,
      pool: write,
      op: ({ path }, worker, count) =>
        pws.request({
          url: serverPathUrl({ pws, path: `${path}/w-${worker}-${count}` }),
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
      pws,
      pool: remove
    })
    await record({ rows, row: { test: 'Signed delete', size, result } })
  }
  for (const { size, serial } of edgeSpaces) {
    const result = await serialWriteLoad({
      pws,
      pool: serial,
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
 * One table per backend, each under its own heading, after a line saying how
 * they relate to the combined table above them. Nothing when `backends` is
 * empty.
 * @param options {object}
 * @param options.backends {ServerBackendId[]}
 * @param options.table {(backend: ServerBackendId) => string}
 * @returns {string[]}
 */
function backendTables({
  backends,
  table
}: {
  backends: ServerBackendId[]
  table: (backend: ServerBackendId) => string
}): string[] {
  if (backends.length === 0) {
    return []
  }
  return [
    '',
    "Each backend's table counts the requests its Collections answered over " +
      "the whole test, so a test's rates add up to the combined one above.",
    ...backends.flatMap(backend => [
      '',
      `### Collections on ${backend}`,
      '',
      table(backend)
    ])
  ]
}

/**
 * The Collection-size results as report lines: the pivoted table, one per
 * backend under it, then the scaling summary.
 * @param options {object}
 * @param options.sizes {number[]}
 * @param options.rows {Row[]}
 * @param [options.backends] {ServerBackendId[]}   the backends to give a
 *   table of their own; none by default
 * @returns {string[]}
 */
export function sizeReport({
  sizes,
  rows,
  backends = []
}: {
  sizes: number[]
  rows: Row[]
  backends?: ServerBackendId[]
}): string[] {
  const pivoted = pivotRows({ sizes, rows })
  return [
    formatPivotedTable({ sizes, pivoted }),
    ...backendTables({
      backends,
      table: backend =>
        formatPivotedTable({
          sizes,
          pivoted: pivoted.map(({ test, cells }) => ({
            test,
            cells: cells.map(cell => backendCell(cell, backend))
          }))
        })
    }),
    '',
    '## Summary',
    '',
    ...formatScalingSummary({ sizes, pivoted })
  ]
}

/**
 * Runs the payload matrix (`perf-matrix-run.ts`) against the Spaces
 * `seedMatrix` wrote, printing each result as it completes and settling after
 * it.
 * @param options {object}
 * @param options.pws {PwsClient}
 * @param options.settings {LoadSettings}
 * @param options.encryptedIds {EncryptedReadIds}
 * @param options.publicRead {(targets: PoolTarget[], clients?: number) => Promise<Measurement | string>}
 *   see `unsignedReader`
 * @param [options.pool] {PoolMember[]}   the Collections each test spreads
 *   its load over, as `seedMatrix` was given; one by default
 * @returns {Promise<MatrixRow[]>}
 */
export async function runPayloadMatrix({
  pws,
  settings,
  encryptedIds,
  publicRead,
  pool
}: {
  pws: PwsClient
  settings: LoadSettings
  encryptedIds: EncryptedReadIds
  publicRead: (
    targets: PoolTarget[],
    clients?: number
  ) => Promise<Measurement | string>
  pool?: PoolMember[]
}): Promise<MatrixRow[]> {
  console.log('\nRunning the payload matrix...')
  return runMatrix({
    pws,
    settings,
    encryptedIds,
    publicRead,
    pool,
    report: async result => {
      console.log(formatMatrixProgressLine(result))
      await settleAfter(result.result)
    }
  })
}

/**
 * The payload-matrix results as report lines, under their own heading: the
 * table, then one per backend.
 * @param options {object}
 * @param options.rows {MatrixRow[]}
 * @param [options.backends] {ServerBackendId[]}   the backends to give a
 *   table of their own; none by default
 * @returns {string[]}
 */
export function matrixReport({
  rows,
  backends = []
}: {
  rows: MatrixRow[]
  backends?: ServerBackendId[]
}): string[] {
  return [
    '## Payload matrix',
    '',
    'Each cell counts whole files: an encrypted 10 MiB file is one document ' +
      'plus 10 chunks, written in 12 requests and read in 11.',
    '',
    formatMatrixTable(rows),
    ...backendTables({
      backends,
      table: backend =>
        formatMatrixTable(
          rows.map(row => ({
            ...row,
            read: backendCell(row.read, backend),
            write: backendCell(row.write, backend)
          }))
        )
    })
  ]
}

/**
 * Saves the report as `summary.md` in `outDir` and prints it, with where it
 * and the server log were kept.
 * @param options {object}
 * @param options.outDir {string}
 * @param options.lines {string[]}
 * @param [options.serverLog] {boolean}   whether this run spawned a server
 *   whose log is in `outDir`; default true
 * @returns {Promise<void>}
 */
export async function saveReport({
  outDir,
  lines,
  serverLog = true
}: {
  outDir: string
  lines: string[]
  serverLog?: boolean
}): Promise<void> {
  const report = lines.join('\n')
  const summaryPath = join(outDir, 'summary.md')
  await writeFile(summaryPath, `${report}\n`)
  console.log(`\n${report}\n`)
  console.log(
    serverLog
      ? `Saved to ${summaryPath} (server log: ${serverLogPath(outDir)})`
      : `Saved to ${summaryPath}`
  )
}
