/**
 * Performance check of an already-running (deployed) server, e.g. a staging
 * host, so two backends can be compared on the same network path.
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
 * `--payloads` narrows the payload matrix to some of `json`, `small` (100 KiB)
 * and `large` (10 MiB). Leaving out `large` is how to run from a machine whose
 * upload is too slow to send 10 MiB within was-client's 10 s request timeout.
 *
 * Usage: pnpm perf:remote --url https://staging.freewallet.me
 * [--label "Filesystem (staging)"] [--sizes 1,500,2000] [--clients 5]
 * [--duration 10] [--writes 100] [--payloads json,small,large].
 */
import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'

import type { WasClient } from '@interop/was-client'

import { seedViaHttp } from './perf-http-seed.js'
import {
  parseLoadSettings,
  parsePayloads,
  parseSizes,
  retryOnTimeout
} from './perf-lib.js'
import {
  connect,
  findK6,
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
    clients: { type: 'string', default: '5' },
    duration: { type: 'string', default: '10' },
    writes: { type: 'string', default: '100' },
    sizes: { type: 'string', default: '1,500,2000' },
    payloads: { type: 'string', default: 'json,small,large' },
    url: { type: 'string' },
    label: { type: 'string' }
  }
})
if (!args.url) {
  console.error('Pass --url https://host of the server to measure.')
  process.exit(1)
}
const serverUrl = args.url.replace(/\/+$/, '')

const { sizes, edgeSizes } = parseSizes(args.sizes)
const payloads = parsePayloads(args.payloads)
const settings = parseLoadSettings(args)

/**
 * How many times the cleanup lists and deletes the identity's Spaces before
 * giving up, and how long it waits between passes.
 */
const cleanupPasses = 5
const cleanupPauseMs = 2_000

/**
 * Deletes every Space the throwaway identity created on the server, retrying
 * a request that times out. An interrupted run is still seeding while this
 * runs, and a Space created after a listing would be missed, so it lists and
 * deletes again, after a pause, until a listing comes back empty.
 * @param was {WasClient}
 * @returns {Promise<void>}
 * @throws {Error}   naming each Space it could not delete
 */
async function deleteCreatedSpaces(was: WasClient): Promise<void> {
  const failed = new Map<string, string>()
  for (let pass = 0; pass < cleanupPasses; pass++) {
    const { items } = await retryOnTimeout({ op: () => was.listSpaces() })
    const remaining = items.filter(item => !failed.has(item.id))
    if (remaining.length === 0) {
      break
    }
    console.log(`Deleting ${remaining.length} Spaces this run created...`)
    for (const item of remaining) {
      try {
        await retryOnTimeout({ op: () => was.space(item.id).delete() })
      } catch (err) {
        failed.set(item.id, (err as Error).message)
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
        .catch(err => console.error(`\n${(err as Error).message}`))
        .finally(() => process.exit(exitCode))
    })
  }
}

/**
 * Seeds the server, runs the tests, prints and saves the tables, and removes
 * the Spaces it created.
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  const k6Version = findK6({ rerunCommand: 'pnpm perf:remote' })
  const outDir = await mkdtemp(join(tmpdir(), 'was-perf-remote-'))
  const header = reportHeader({
    title: args.label ?? `Performance of ${serverUrl}`,
    k6Version,
    settings,
    extraLines: [
      `- Target: ${serverUrl}`,
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
    matrix: true
  })
  const response = await fetch(`${serverUrl}/health`)
  if (!response.ok) {
    throw new Error(`${serverUrl}/health answered ${response.status}.`)
  }

  const seed = Uint8Array.from(randomBytes(32))
  const was = await connect({ serverUrl, seed })
  const cleanUp = createCleanUp(was)
  cleanUpOnSignal(cleanUp)
  const publicRead = unsignedReader({ serverUrl, outDir, k6Version, settings })
  try {
    const { targets, encryptedIds } = await seedViaHttp({
      was,
      serverUrl,
      seed,
      sizes,
      edgeSizes,
      payloads
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
      publicRead
    })
    await saveReport({
      outDir,
      serverLog: false,
      lines: [
        ...header,
        ...sizeReport({ sizes, rows }),
        '',
        ...matrixReport(matrixRows)
      ]
    })
  } finally {
    // Reported rather than thrown, so it doesn't hide the error that ended
    // the run.
    await cleanUp().catch(err => {
      console.error(`\n${(err as Error).message}`)
      process.exitCode = 1
    })
  }
}

main().catch(err => {
  console.error(`\n${(err as Error).message}`)
  process.exit(1)
})
