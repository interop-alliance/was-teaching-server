/**
 * Performance check of an already-running (deployed) server, e.g. a staging
 * host, measuring its backends side by side on the same network path.
 *
 * Runs the same load tests as `pnpm perf:fs` and `pnpm perf:pg` (see
 * `scripts/performance/perf-fs.ts`), but spawns no server: every request goes
 * to `--url`. Nothing can be pre-seeded behind a deployed server's back, so
 * the Collections and the payload matrix are filled fresh over signed HTTP
 * (`scripts/performance/perf-http-seed.ts`) under a throwaway `did:key`, and
 * the Spaces that identity created are deleted again when the run ends, even
 * when a test fails or the run is interrupted (Ctrl-C or SIGTERM; a second
 * one exits at once, skipping the cleanup). The identity's key is never
 * stored, so a Space the cleanup misses can only be removed on the server
 * itself; the run names any it could not delete. The server must allow Space
 * creation (no onboarding
 * token). The numbers include the network round trip from this machine, so
 * compare runs made from the same machine, against hosts in the same place.
 *
 * `--split` (default `postgres=50,fs=50`) shares each test's Collections
 * among the host's backends by percent: every test spreads its load
 * round-robin over a pool of Collections, the smallest one that realizes the
 * split (`backendPool`), each created with that backend's fixed id. The report
 * shows the combined tables and one per backend under each. Before seeding,
 * the run reads the host's backends listing and stops if the split names a
 * backend the host does not list; `--split fs=100` measures one backend alone.
 *
 * `--payloads` narrows the payload matrix to some of `json`, `small` (100 KiB)
 * and `large` (10 MiB). Leaving out `large` is how to run from a machine whose
 * upload is too slow to send 10 MiB within was-client's 10 s request timeout.
 *
 * `--record <dir>` with `--runner <name>` also writes the run as a JSON run
 * record at `<dir>/<runner>/<host>/<stamp>.json` (`recordPath`), once the run
 * has completed: the run's start, the target, the server version and build
 * time its `/health` reports, the runner and its machine, the label, the
 * tooling, the settings, and every measurement (`runResults`). A run that
 * fails or is interrupted records nothing, and an existing record is never
 * replaced. The runner names the machine the run's numbers belong to, so
 * only records under one runner and host compare.
 *
 * Usage: pnpm perf:remote --url https://staging.freewallet.me
 * [--split postgres=50,fs=50] [--label "Staging"] [--sizes 1,500,2000]
 * [--clients 5] [--duration 10] [--writes 100] [--payloads json,small,large]
 * [--large-file-clients 2] [--record ../ops/perf-results --runner fly-iad].
 */
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'

import type { WasClient } from '@interop/was-client'

import { seedViaHttp } from './perf-http-seed.js'
import {
  backendPool,
  describeError,
  describePool,
  formatRetries,
  healthBuild,
  missingBackends,
  parseLoadSettings,
  parsePayloads,
  parseRunner,
  parseSizes,
  parseSplit,
  recordPath,
  retriedFaultCounts,
  retryOnNetworkFault,
  runRecordSchema,
  runResults,
  type BackendShare
} from './perf-lib.js'
import {
  connect,
  describeCommit,
  describeMachine,
  findK6,
  loadTestOptions,
  matrixReport,
  printEstimate,
  reportHeader,
  runPayloadMatrix,
  runTests,
  saveReport,
  sizeReport,
  unsignedReader
} from './perf-runner.js'

const { values: args } = parseArgs({
  options: {
    ...loadTestOptions,
    sizes: { type: 'string', default: '1,500,2000' },
    payloads: { type: 'string', default: 'json,small,large' },
    split: { type: 'string', default: 'postgres=50,fs=50' },
    url: { type: 'string' },
    label: { type: 'string' },
    record: { type: 'string' },
    runner: { type: 'string' }
  }
})
if (!args.url) {
  console.error('Pass --url https://host of the server to measure.')
  process.exit(1)
}
if ((args.record === undefined) !== (args.runner === undefined)) {
  console.error(
    'Pass --record <dir> and --runner <name> together: the runner names the ' +
      'folder the run record goes in.'
  )
  process.exit(1)
}
const serverUrl = args.url.replace(/\/+$/, '')
const runner = args.runner === undefined ? undefined : parseRunner(args.runner)

const { sizes, edgeSizes } = parseSizes(args.sizes)
const payloads = parsePayloads(args.payloads)
const settings = parseLoadSettings(args)
const split = parseSplit(args.split)
const pool = backendPool(split)
// One backend's table would repeat the combined one.
const reportedBackends =
  split.length > 1 ? split.map(({ backend }) => backend) : []

/**
 * How many times the cleanup lists and deletes the identity's Spaces before
 * giving up, and how long it waits between passes.
 */
const cleanupPasses = 5
const cleanupPauseMs = 2_000

/**
 * Deletes every Space the throwaway identity created on the server, retrying
 * a request that hits a network fault. An interrupted run is still seeding
 * while this runs, and a Space created after a listing would be missed, so it
 * lists and deletes again, after a pause, until a listing comes back empty.
 * @param was {WasClient}
 * @returns {Promise<void>}
 * @throws {Error}   naming each Space it could not delete
 */
async function deleteCreatedSpaces(was: WasClient): Promise<void> {
  const failed = new Map<string, string>()
  for (let pass = 0; pass < cleanupPasses; pass++) {
    const { items } = await retryOnNetworkFault({ op: () => was.listSpaces() })
    const remaining = items.filter(item => !failed.has(item.id))
    if (remaining.length === 0) {
      break
    }
    console.log(`Deleting ${remaining.length} Spaces this run created...`)
    for (const item of remaining) {
      try {
        await retryOnNetworkFault({ op: () => was.space(item.id).delete() })
      } catch (err) {
        failed.set(item.id, describeError(err))
      }
    }
    await sleep(cleanupPauseMs)
  }
  if (failed.size > 0) {
    const spaces = [...failed].map(([id, reason]) => `${id} (${reason})`)
    throw new Error(
      `Could not delete ${failed.size} Spaces on ${serverUrl}: ` +
        spaces.join('; ')
    )
  }
}

/**
 * The server backends the host lists, read from a new Space's backends
 * listing (`GET /space/:spaceId/backends`), so the run stops before it seeds
 * anything when `split` names one the host does not have. The Space is left
 * for the run's cleanup to delete.
 * @param options {object}
 * @param options.was {WasClient}
 * @param options.split {BackendShare[]}
 * @returns {Promise<string[]>} the listed ids, in the listing's order,
 *   without the `default` alias
 * @throws {Error}   naming each backend the split needs and the host lacks
 */
async function hostBackends({
  was,
  split
}: {
  was: WasClient
  split: BackendShare[]
}): Promise<string[]> {
  const space = await retryOnNetworkFault({
    op: () => was.createSpace({ name: 'perf-backends' })
  })
  const listing = await retryOnNetworkFault({ op: () => space.backends() })
  // `default` aliases one of the backends listed under its own id.
  const listedIds = (listing ?? [])
    .map(({ id }) => id)
    .filter(id => id !== 'default')
  const missing = missingBackends({ split, listedIds })
  if (missing.length > 0) {
    throw new Error(
      `--split names ${missing.join(', ')}, which ${serverUrl} does not ` +
        `list (it lists ${listedIds.join(', ') || 'only default'}). Give a ` +
        '--split of the backends it lists.'
    )
  }
  return listedIds
}

/**
 * Makes the run's cleanup: a function that deletes the identity's Spaces the
 * first time it is called and hands every later caller that same deletion,
 * however many of the run's end, its failure, and an interrupt ask for it.
 * @param was {WasClient}
 * @returns {() => Promise<void>}
 */
function createCleanUp(was: WasClient): () => Promise<void> {
  let deleting: Promise<void> | undefined
  return () => {
    deleting ??= deleteCreatedSpaces(was)
    return deleting
  }
}

/**
 * On Ctrl-C (SIGINT) or SIGTERM, runs the cleanup and then exits, so an
 * interrupted run leaves no Spaces behind. A second signal exits at once.
 * @param cleanUp {() => Promise<void>}
 * @returns {void}
 */
function cleanUpOnSignal(cleanUp: () => Promise<void>): void {
  let interrupted = false
  for (const [signal, exitCode] of [
    ['SIGINT', 130],
    ['SIGTERM', 143]
  ] as const) {
    process.on(signal, () => {
      if (interrupted) {
        console.error(
          `\n${signal} again: exiting before the cleanup finished. Spaces ` +
            `this run created may be left on ${serverUrl}, and their key is ` +
            'gone, so only the server itself can remove them.'
        )
        process.exit(exitCode)
      }
      interrupted = true
      console.log(
        `\n${signal}: deleting this run's Spaces before exiting ` +
          `(${signal} again to skip)...`
      )
      cleanUp()
        .catch(err => console.error(`\n${describeError(err)}`))
        .finally(() => process.exit(exitCode))
    })
  }
}

/**
 * Writes a run record as JSON at `path`, creating its folders, and refuses to
 * replace a file already there, so a recorded run is never overwritten.
 * @param options {object}
 * @param options.path {string}
 * @param options.record {object}
 * @returns {Promise<void>}
 */
async function saveRunRecord({
  path,
  record
}: {
  path: string
  record: object
}): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
  console.log(`Recorded to ${path}`)
}

/**
 * Checks the host lists the split's backends, seeds it, runs the tests,
 * prints and saves the tables, records the run when `--record` asks for it,
 * and removes the Spaces it created.
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  const startedAt = new Date()
  const k6Version = findK6({ rerunCommand: 'pnpm perf:remote' })
  const outDir = await mkdtemp(join(tmpdir(), 'was-perf-remote-'))
  const response = await retryOnNetworkFault({
    op: () => fetch(`${serverUrl}/health`)
  })
  if (!response.ok) {
    throw new Error(`${serverUrl}/health answered ${response.status}.`)
  }
  const health = healthBuild(await response.json().catch(() => undefined))

  const seed = Uint8Array.from(randomBytes(32))
  const was = await connect({ serverUrl, seed })
  const cleanUp = createCleanUp(was)
  cleanUpOnSignal(cleanUp)
  const publicRead = unsignedReader({ serverUrl, outDir, k6Version, settings })
  try {
    const listedIds = await hostBackends({ was, split })
    const shares = split
      .map(({ backend, percent }) => `${backend} ${percent}%`)
      .join(', ')
    const header = reportHeader({
      title: args.label ?? `Performance of ${serverUrl}`,
      k6Version,
      settings,
      startedAt,
      extraLines: [
        `- Target: ${serverUrl}, listing backends ${listedIds.join(', ')}`,
        `- Backend split: ${shares}; ${describePool(split)}`,
        `- Matrix payloads: ${payloads.join(', ')}`
      ]
    })
    console.log(header.join('\n'))
    printEstimate({
      sizes,
      edgeSizes,
      settings,
      k6Version,
      filling: true,
      matrix: true,
      split
    })
    const { targets, encryptedIds } = await seedViaHttp({
      was,
      serverUrl,
      seed,
      sizes,
      edgeSizes,
      payloads,
      pool
    })
    const rows = await runTests({
      was,
      sizes,
      targets,
      settings,
      publicRead
    })
    const matrixRows = await runPayloadMatrix({
      was,
      settings,
      encryptedIds,
      publicRead,
      pool
    })
    const retries =
      '- Retries of untimed requests after a network fault: ' +
      formatRetries(retriedFaultCounts())
    await saveReport({
      outDir,
      serverLog: false,
      lines: [
        // Known only once the run is over, so it joins the header here,
        // ahead of the blank line that ends it.
        ...header.slice(0, -1),
        retries,
        ...header.slice(-1),
        ...sizeReport({ sizes, rows, backends: reportedBackends }),
        '',
        ...matrixReport({ rows: matrixRows, backends: reportedBackends })
      ]
    })
    if (args.record !== undefined && runner !== undefined) {
      await saveRunRecord({
        path: recordPath({ dir: args.record, runner, serverUrl, startedAt }),
        record: {
          schema: runRecordSchema,
          datetime: startedAt.toISOString(),
          // The measurements' end: the Spaces are deleted after it.
          finished_at: new Date().toISOString(),
          spaces_url: serverUrl,
          server_version: health.version,
          server_built_at: health.builtAt,
          runner,
          machine: describeMachine(),
          label: args.label ?? null,
          tool: {
            commit: describeCommit(),
            node: process.version,
            k6: k6Version ?? null
          },
          settings: {
            clients: settings.clients,
            large_file_clients: settings.largeFileClients,
            duration_s: settings.durationSeconds,
            serial_writes: settings.serialWrites,
            sizes,
            payloads,
            split: Object.fromEntries(
              split.map(({ backend, percent }) => [backend, percent])
            )
          },
          results: runResults({
            rows,
            matrixRows,
            backends: reportedBackends
          })
        }
      })
    }
  } finally {
    // Reported rather than thrown, so it doesn't hide the error that ended
    // the run.
    await cleanUp().catch(err => {
      console.error(`\n${describeError(err)}`)
      process.exitCode = 1
    })
  }
}

main().catch(err => {
  console.error(`\n${describeError(err)}`)
  process.exit(1)
})
