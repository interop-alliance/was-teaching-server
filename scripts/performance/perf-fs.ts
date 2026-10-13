/**
 * Local performance check of the filesystem backend.
 *
 * Starts the server from this checkout as its own process, on a fresh temp
 * data dir and with `DATABASE_URL` and `WAS_ONBOARDING_TOKEN` cleared, so the
 * filesystem backend is always the one measured and Space creation is open.
 * It fills Collections of each size, runs the tests below, prints two tables
 * (the Collection-size tests and the payload matrix; Markdown, ready to
 * paste), and stops the server. It measures the
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
 * Then the payload matrix (`scripts/performance/perf-matrix-run.ts`), the
 * same one `pnpm perf:pg` runs: a read and a write test of a JSON credential,
 * a 100 KiB file and a 10 MiB file, in a public, a private plaintext and a
 * private encrypted Collection, each counted in whole files. It is reported
 * as a table of its own. Its Spaces are seeded over signed HTTP through
 * `@interop/was-client` (`scripts/performance/perf-matrix-seed.ts`), since
 * was-client makes the encrypted Collection's key epoch and EDV envelopes.
 * Unlike `pnpm perf:pg:seed`, no binary ballast is seeded: the filesystem
 * backend's cache is the OS page cache, which ballast small enough to copy
 * every run cannot outgrow.
 *
 * A write or delete test gets a Space of its own, since the byte quota, when
 * set, measures the whole Space. The server's other settings come from the
 * environment as usual, e.g. `STORAGE_LIMIT_PER_SPACE=1000000000`. was-client
 * retries a 5xx, so a failing request can show as a slow one rather than a
 * failure. The table and the server log are kept in a temp dir, printed at the
 * end.
 *
 * Usage: pnpm perf:fs [--sizes 1,500,2000] [--clients 5] [--duration 10]
 * [--writes 100] [--seed-dir <path>]. The defaults are a quick run, about 15
 * minutes filling fresh (8 from a seed); the full run is
 * `--duration 20 --writes 300`, about 22 minutes (15 from a seed). It runs
 * the server on port 4455 (`PORT=...` overrides it) and first stops whatever
 * else listens there, another perf run's server included.
 *
 * Like `pnpm perf:pg`, a run uses the seed `pnpm perf:fs:seed` wrote (see
 * `scripts/performance/perf-fs-seed.ts`) when there is one at `.perf-fs-seed`:
 * it skips the "Filling Collections..." step, copies the seed into this run's
 * own temp data dir (the seed itself is left untouched), and reloads the
 * `did:key` identity that seeded it so signed requests against those Spaces
 * still verify. The sizes then come from the seed. `--seed-dir <path>` names
 * another seed. With no seed, or with `--sizes` given (explicit sizes ask for
 * a fresh fill), it fills fresh over signed HTTP instead. The run prints which
 * it did.
 */
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import type { Collection, JsonObject, WasClient } from '@interop/was-client'

import {
  credential,
  edgeSpaceLabels,
  fillConcurrently,
  isEncryptedIds,
  itemIds,
  parseLoadSettings,
  parseSizes,
  seedConcurrency,
  type MatrixPayload
} from './perf-lib.js'
import { seedMatrix } from './perf-matrix-seed.js'
import {
  connect,
  findK6,
  loadTestOptions,
  matrixReport,
  printEstimate,
  reportHeader,
  runAgainstServer,
  runPayloadMatrix,
  runTests,
  saveReport,
  seededTargets,
  serverUrl,
  sizeReport,
  unsignedReader,
  type TestTargets
} from './perf-runner.js'
import {
  defaultSeedDirs,
  readSeedMeta,
  seedMetaFile
} from './perf-seed-meta.js'

const { values: args } = parseArgs({
  options: {
    ...loadTestOptions,
    // No parseArgs default: whether `--sizes` was given decides the seed.
    sizes: { type: 'string' },
    'seed-dir': { type: 'string' }
  }
})
let { sizes, edgeSizes } = parseSizes(args.sizes ?? '1,500,2000')
const settings = parseLoadSettings(args)

/**
 * Writes one Resource per id into the Collection over signed HTTP, several
 * at a time.
 * @param options {object}
 * @param options.collection {Collection}
 * @param options.ids {string[]}
 * @returns {Promise<void>}
 */
async function fillViaHttp({
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
 * Creates a Space holding one Collection of `size` Resources over signed
 * HTTP.
 * @param options {object}
 * @param options.was {WasClient}
 * @param options.name {string}
 * @param options.size {number}
 * @returns {Promise<{ path: string, collection: Collection }>} the
 *   Collection's path, with no trailing slash, and its handle
 */
async function seedSpaceViaHttp({
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
  await fillViaHttp({ collection, ids: itemIds(size) })
  return { path: `/space/${space.id}/items`, collection }
}

/**
 * Seeds every Space the tests need, fresh, over signed HTTP: the
 * Collection-size Spaces, then the payload matrix.
 * @param options {object}
 * @param options.was {WasClient}
 * @param options.seed {Uint8Array}   the identity `was` signs with
 * @param options.sizes {number[]}
 * @param options.edgeSizes {number[]}
 * @returns {Promise<{
 *   targets: TestTargets, encryptedIds: Record<MatrixPayload, string>
 * }>}
 */
async function seedViaHttp({
  was,
  seed,
  sizes,
  edgeSizes
}: {
  was: WasClient
  seed: Uint8Array
  sizes: number[]
  edgeSizes: number[]
}): Promise<{
  targets: TestTargets
  encryptedIds: Record<MatrixPayload, string>
}> {
  const seedStarted = performance.now()
  console.log('Filling Collections and the payload matrix...')

  const publicSpace = await was.createSpace({ name: 'perf-public' })
  const privateSpace = await was.createSpace({ name: 'perf-private' })
  for (const size of sizes) {
    const publicCollection = await publicSpace.createCollection({
      id: `c-${size}`
    })
    await fillViaHttp({ collection: publicCollection, ids: itemIds(size) })
    await publicCollection.setPublic()
    const privateCollection = await privateSpace.createCollection({
      id: `c-${size}`
    })
    await fillViaHttp({ collection: privateCollection, ids: itemIds(size) })
  }
  const edgeSpaces = []
  for (const size of edgeSizes) {
    const seed = (label: string) =>
      seedSpaceViaHttp({ was, name: `${label}-${size}`, size })
    edgeSpaces.push({
      size,
      write: await seed(edgeSpaceLabels.write),
      remove: await seed(edgeSpaceLabels.remove),
      serial: await seed(edgeSpaceLabels.serial)
    })
  }
  const encryptedIds = await seedMatrix({ serverUrl, seed })
  const seedSeconds = (performance.now() - seedStarted) / 1000
  console.log(`Filled in ${seedSeconds.toFixed(0)}s. Running tests...\n`)
  return {
    targets: {
      publicSpaceId: publicSpace.id,
      privateSpaceId: privateSpace.id,
      edgeSpaces
    },
    encryptedIds
  }
}

/**
 * Picks the seed this run uses: `--seed-dir` when given; else the default
 * seed dir, when it holds a seed and `--sizes` was not given; else none, so
 * the run fills fresh. Says which, and why, for the run to print.
 * @returns {{ seedDir: string | undefined, note: string }}
 */
function chooseSeed(): { seedDir: string | undefined; note: string } {
  const defaultDir = defaultSeedDirs.fs
  if (args['seed-dir']) {
    return {
      seedDir: args['seed-dir'],
      note: `Using the seed at ${args['seed-dir']} (--seed-dir).`
    }
  }
  if (!existsSync(join(defaultDir, seedMetaFile))) {
    return {
      seedDir: undefined,
      note:
        `No seed at ${defaultDir}, so filling fresh over signed HTTP ` +
        '(`pnpm perf:fs:seed` makes one).'
    }
  }
  if (args.sizes) {
    return {
      seedDir: undefined,
      note:
        `--sizes given, so filling fresh over signed HTTP instead of using ` +
        `the seed at ${defaultDir}.`
    }
  }
  return { seedDir: defaultDir, note: `Using the seed at ${defaultDir}.` }
}

/**
 * Starts the server, runs the tests, prints and saves the table, and stops
 * the server, removing its data dir, even when a test fails.
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  const { seedDir, note } = chooseSeed()
  // A fresh run signs with a throwaway identity; a seeded one with the seed's.
  let seed: Uint8Array = Uint8Array.from(randomBytes(32))
  let seededIds: Record<MatrixPayload, string> | undefined
  if (seedDir) {
    const meta = await readSeedMeta<{
      encryptedIds: Record<MatrixPayload, string>
    }>({
      seedDir,
      seedCommand:
        seedDir === defaultSeedDirs.fs
          ? 'pnpm perf:fs:seed'
          : `pnpm perf:fs:seed --out ${seedDir}`,
      hasOwnMembers: ({ encryptedIds }) => isEncryptedIds(encryptedIds)
    })
    seed = meta.seed
    sizes = meta.sizes
    edgeSizes = meta.edgeSizes
    seededIds = meta.encryptedIds
  }
  const k6Version = findK6({ rerunCommand: 'pnpm perf:fs' })

  const outDir = await mkdtemp(join(tmpdir(), 'was-perf-fs-'))
  const dataDir = join(outDir, 'data')
  await mkdir(dataDir)

  const header = reportHeader({
    title: 'Filesystem backend performance',
    k6Version,
    settings
  })
  console.log(header.join('\n'))
  printEstimate({
    sizes,
    edgeSizes,
    settings,
    k6Version,
    filling: !seedDir,
    matrix: true
  })

  console.log(`${note}\n`)
  if (seedDir) {
    console.log("Copying the seed into this run's data dir...")
    await cp(seedDir, dataDir, {
      recursive: true,
      filter: source => !source.endsWith(seedMetaFile)
    })
  }
  const publicRead = unsignedReader({ outDir, k6Version, settings })
  const { rows, matrixRows } = await runAgainstServer({
    outDir,
    env: { DATABASE_URL: undefined, WAS_DATA_DIR: dataDir },
    afterStop: () => rm(dataDir, { recursive: true, force: true }),
    run: async () => {
      const was = await connect({ seed })
      const { targets, encryptedIds } = seededIds
        ? {
            targets: seededTargets({ was, edgeSizes }),
            encryptedIds: seededIds
          }
        : await seedViaHttp({ was, seed, sizes, edgeSizes })
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
      return { rows, matrixRows }
    }
  })

  await saveReport({
    outDir,
    lines: [
      ...header,
      ...sizeReport({ sizes, rows }),
      '',
      ...matrixReport(matrixRows)
    ]
  })
}

main().catch(err => {
  console.error(`\n${(err as Error).message}`)
  process.exit(1)
})
