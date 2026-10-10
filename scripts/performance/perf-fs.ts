/**
 * Local performance check of the filesystem backend.
 *
 * Starts the server from this checkout as its own process, on a fresh temp
 * data dir and with `DATABASE_URL` and `WAS_ONBOARDING_TOKEN` cleared, so the
 * filesystem backend is always the one measured and Space creation is open.
 * It fills Collections of each size, runs the tests below, prints one table
 * (Markdown, ready to paste), and stops the server. It measures the
 * checked-out code only: to compare two versions, run it on each.
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
 * A write or delete test gets a Space of its own, since the byte quota, when
 * set, measures the whole Space. The server's other settings come from the
 * environment as usual, e.g. `STORAGE_LIMIT_PER_SPACE=1000000000`. was-client
 * retries a 5xx, so a failing request can show as a slow one rather than a
 * failure. The table and the server log are kept in a temp dir, printed at the
 * end.
 *
 * Usage: pnpm perf:fs [--sizes 1,500] [--clients 5] [--duration 10]
 * [--writes 100]. The defaults are a quick run, about 5 minutes; the full run
 * is `--sizes 1,500,2000 --duration 20 --writes 300`, about 15 minutes.
 * Override the port with `PORT=...` if 4455 is taken.
 *
 * `--seed-dir <path>` skips the "Filling Collections..." step: instead of
 * seeding fresh over signed HTTP every run, it copies a data dir that
 * `pnpm perf:fs:seed` already filled (see `scripts/performance/perf-fs-seed.ts`) into this
 * run's own temp data dir, and reloads the `did:key` identity that seeded it
 * so signed requests against those Spaces still verify. `--sizes` is ignored
 * when `--seed-dir` is given; the sizes come from the seed dir itself.
 */
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { cpus, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'

import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { WasClient } from '@interop/was-client'
import type { Collection, JsonObject } from '@interop/was-client'

import {
  credential,
  deleteLoad,
  estimateMinutes,
  fillConcurrently,
  formatMachine,
  formatPivotedTable,
  formatProgressLine,
  formatScalingSummary,
  itemIds,
  load,
  parseSizes,
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
const seedConcurrency = 10
const deleteRoundSize = 20
const warmUpWrites = 20

const { values: args } = parseArgs({
  options: {
    sizes: { type: 'string', default: '1,500' },
    clients: { type: 'string', default: '5' },
    duration: { type: 'string', default: '10' },
    writes: { type: 'string', default: '100' },
    'seed-dir': { type: 'string' }
  }
})
let { sizes, edgeSizes } = parseSizes(args.sizes)
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
 * Starts `src/start.ts` on the filesystem backend over `dataDir`, with its
 * output going to `logPath`.
 * @param options {object}
 * @param options.dataDir {string}
 * @param options.logPath {string}
 * @returns {ChildProcess}
 */
function startServer({
  dataDir,
  logPath
}: {
  dataDir: string
  logPath: string
}): ChildProcess {
  const env = { ...process.env }
  delete env.DATABASE_URL
  delete env.WAS_ONBOARDING_TOKEN
  const server = spawn('tsx', ['src/start.ts'], {
    env: { ...env, SERVER_URL: serverUrl, PORT: port, WAS_DATA_DIR: dataDir }
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
 * Reads the `seed-meta.json` that `pnpm perf:fs:seed` wrote into `seedDir`,
 * failing with a message that names that script when the dir is not a seed.
 * @param seedDir {string}
 * @returns {Promise<{ seed: string, sizes: number[], edgeSizes: number[] }>}
 */
async function readSeedMeta(
  seedDir: string
): Promise<{ seed: string; sizes: number[]; edgeSizes: number[] }> {
  const metaPath = join(seedDir, 'seed-meta.json')
  let text: string
  try {
    text = await readFile(metaPath, 'utf8')
  } catch (err) {
    throw new Error(
      `No seed at ${metaPath}. Run \`pnpm perf:fs:seed --out ${seedDir}\` first.`,
      { cause: err }
    )
  }
  const meta = JSON.parse(text)
  if (
    typeof meta.seed !== 'string' ||
    !Array.isArray(meta.sizes) ||
    !Array.isArray(meta.edgeSizes)
  ) {
    throw new Error(
      `${metaPath} is not a seed-meta.json. Reseed with \`pnpm perf:fs:seed --out ${seedDir}\`.`
    )
  }
  return meta
}

/**
 * Makes a client signing with a `did:key`: a fresh throwaway one, or the one
 * `seed` reconstructs (the identity `pnpm perf:fs:seed` wrote Spaces under,
 * when `--seed-dir` is given).
 * @param options {object}
 * @param [options.seed] {Uint8Array}
 * @returns {Promise<WasClient>}
 */
async function connect({
  seed
}: { seed?: Uint8Array } = {}): Promise<WasClient> {
  const keyPair = await Ed25519VerificationKey.generate({
    seed: seed ?? Uint8Array.from(randomBytes(32))
  })
  return WasClient.fromSigner({ serverUrl, signer: keyPair.didKeySigner() })
}

/**
 * Writes one Resource per id into the Collection, several at a time.
 * @param options {object}
 * @param options.collection {Collection}
 * @param options.ids {string[]}
 * @returns {Promise<void>}
 */
async function fill({
  collection,
  ids
}: {
  collection: Collection
  ids: string[]
}): Promise<void> {
  await fillConcurrently({
    ids,
    concurrency: seedConcurrency,
    write: id => collection.put(id, credential(id) as JsonObject)
  })
}

/**
 * Creates a Space holding one Collection of `size` Resources.
 * @param options {object}
 * @param options.was {WasClient}
 * @param options.name {string}
 * @param options.size {number}
 * @returns {Promise<{ path: string, collection: Collection }>} the
 *   Collection's path, with no trailing slash, and its handle
 */
async function seedSpace({
  was,
  name,
  size
}: {
  was: WasClient
  name: string
  size: number
}): Promise<{ path: string; collection: Collection }> {
  const space = await was.createSpace({ name })
  const collection = await space.createCollection({ id: 'items', name })
  await fill({ collection, ids: itemIds(size) })
  return { path: `/space/${space.id}/items`, collection }
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
 * The Spaces every measured test needs, built either by seeding fresh over
 * HTTP (`seedViaHttp`) or by referencing what `pnpm perf:fs:seed` already
 * wrote to the copied data dir (`targetsFromSeedDir`).
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
 * Seeds every Space the tests need, fresh, over signed HTTP.
 * @param options {object}
 * @param options.was {WasClient}
 * @param options.sizes {number[]}
 * @param options.edgeSizes {number[]}
 * @returns {Promise<TestTargets>}
 */
async function seedViaHttp({
  was,
  sizes,
  edgeSizes
}: {
  was: WasClient
  sizes: number[]
  edgeSizes: number[]
}): Promise<TestTargets> {
  const seedStarted = performance.now()
  console.log('Filling Collections...')

  const publicSpace = await was.createSpace({ name: 'perf-public' })
  const privateSpace = await was.createSpace({ name: 'perf-private' })
  for (const size of sizes) {
    const publicCollection = await publicSpace.createCollection({
      id: `c-${size}`
    })
    await fill({ collection: publicCollection, ids: itemIds(size) })
    await publicCollection.setPublic()
    const privateCollection = await privateSpace.createCollection({
      id: `c-${size}`
    })
    await fill({ collection: privateCollection, ids: itemIds(size) })
  }
  const edgeSpaces = []
  for (const size of edgeSizes) {
    edgeSpaces.push({
      size,
      write: await seedSpace({ was, name: `perf-write-${size}`, size }),
      remove: await seedSpace({ was, name: `perf-delete-${size}`, size }),
      serial: await seedSpace({ was, name: `perf-serial-${size}`, size })
    })
  }
  const seedSeconds = (performance.now() - seedStarted) / 1000
  console.log(`Filled in ${seedSeconds.toFixed(0)}s. Running tests...\n`)
  return {
    publicSpaceId: publicSpace.id,
    privateSpaceId: privateSpace.id,
    edgeSpaces
  }
}

/**
 * Builds handles for the Spaces `pnpm perf:fs:seed` already wrote into the
 * copied data dir, under the fixed ids it used (`perf-public`,
 * `perf-private`, `perf-write-<size>`, `perf-delete-<size>`,
 * `perf-serial-<size>`). No I/O: `WasClient`'s Space/Collection handles are
 * lazy.
 * @param options {object}
 * @param options.was {WasClient}
 * @param options.edgeSizes {number[]}
 * @returns {TestTargets}
 */
function targetsFromSeedDir({
  was,
  edgeSizes
}: {
  was: WasClient
  edgeSizes: number[]
}): TestTargets {
  console.log('Using pre-seeded data (skipping Collection fill).\n')
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
 * Runs every measured test in order against already-seeded Spaces.
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
 * Starts the server, runs the tests, prints and saves the table, and stops
 * the server, removing its data dir, even when a test fails.
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  let seed: Uint8Array | undefined
  if (args['seed-dir']) {
    const meta = await readSeedMeta(args['seed-dir'])
    seed = Uint8Array.from(Buffer.from(meta.seed, 'base64'))
    sizes = meta.sizes
    edgeSizes = meta.edgeSizes
  }
  await assertPortFree()
  const k6Version = findK6()
  if (!k6Version) {
    console.warn(
      [
        'Warning: k6 is not installed, so the public read and list tests are skipped.',
        'Install it, then run `pnpm perf:fs` again:',
        '  macOS:   brew install k6',
        '  Windows: winget install k6 --source winget',
        '  Linux and others: https://grafana.com/docs/k6/latest/set-up/install-k6/',
        ''
      ].join('\n')
    )
  }

  const outDir = await mkdtemp(join(tmpdir(), 'was-perf-fs-'))
  const dataDir = join(outDir, 'data')
  await mkdir(dataDir)
  if (args['seed-dir']) {
    await cp(args['seed-dir'], dataDir, {
      recursive: true,
      filter: source => !source.endsWith('seed-meta.json')
    })
  }
  const logPath = join(outDir, 'server.log')
  const server = startServer({ dataDir, logPath })
  const cleanUp = async () => {
    await stopServer(server)
    await rm(dataDir, { recursive: true, force: true })
  }
  for (const [signal, exitCode] of [
    ['SIGINT', 130],
    ['SIGTERM', 143]
  ] as const) {
    process.once(signal, () => {
      cleanUp().finally(() => process.exit(exitCode))
    })
  }

  const header = [
    '## Filesystem backend performance',
    '',
    `- Commit: ${describeCommit()}`,
    `- Date: ${new Date().toISOString()}`,
    `- Node ${process.version}, ${k6Version ?? 'k6 not installed'}`,
    `- ${describeMachine()}`,
    `- ${clients} clients, ${durationSeconds} s per load test`,
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
    filling: !args['seed-dir']
  })
  console.log(`Note: this run takes about ${minutes} minutes (an estimate).\n`)

  let rows: Row[]
  try {
    await waitForHealth(server)
    const was = await connect({ seed })
    const targets = args['seed-dir']
      ? targetsFromSeedDir({ was, edgeSizes })
      : await seedViaHttp({ was, sizes, edgeSizes })
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
