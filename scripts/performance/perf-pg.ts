/**
 * Local performance check of the Postgres backend.
 *
 * Starts the server from this checkout as its own process, with
 * `DATABASE_URL` pointed at the schema `pnpm perf:pg:seed` already filled
 * (see `scripts/performance/perf-pg-seed.ts`), so the Postgres backend is
 * always the one measured. Runs the same load tests as `pnpm perf:fs` (see
 * `scripts/performance/perf-fs.ts`) against that pre-seeded data, prints two
 * tables (the Collection-size tests and the payload matrix; Markdown, ready
 * to paste), and stops the server. It measures the
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
 *   `@interop/pws-client`. A delete test runs in rounds: each client
 *   re-creates the same few Resources, untimed, then deletes them, timed, so
 *   the Collection stays near its size.
 *
 * Last, one client writes `--writes` new Resources in a row into the smallest
 * and the largest size.
 *
 * Then the payload matrix (`scripts/performance/perf-matrix-run.ts`): a read
 * and a write test of a JSON credential, a 100 KiB file and a 10 MiB file, in a
 * public, a private plaintext and a private encrypted Collection, each
 * counted in whole files. It is reported as a table of its own.
 *
 * The seeded schema is left in place after the run, so it can be inspected or
 * reused for another run without reseeding; `pnpm perf:pg:seed` is what resets
 * it. The server's other settings come from the environment as usual, e.g.
 * `STORAGE_LIMIT_PER_SPACE=1000000000`. pws-client retries a 5xx, so a failing
 * request can show as a slow one rather than a failure. The table and the
 * server log are kept in a temp dir, printed at the end.
 *
 * Usage: pnpm perf:pg:seed [--sizes 1,500,2000] first, then
 * pnpm perf:pg [--clients 5] [--duration 10] [--writes 100]
 * [--database-url postgres://was:was@localhost:5433/was]. It runs the server
 * on port 4455 (`PORT=...` overrides it) and first stops whatever else
 * listens there, another perf run's server included.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import {
  isEncryptedIds,
  parseLoadSettings,
  type MatrixPayload
} from './perf-lib.js'
import {
  connect,
  findK6,
  loadTestOptions,
  localServerUrl,
  matrixReport,
  printEstimate,
  reportHeader,
  runAgainstServer,
  runPayloadMatrix,
  runTests,
  saveReport,
  seededTargets,
  sizeReport,
  unsignedReader
} from './perf-runner.js'
import { defaultSeedDirs, readSeedMeta } from './perf-seed-meta.js'

const { values: args } = parseArgs({
  options: {
    ...loadTestOptions,
    'database-url': { type: 'string' }
  }
})
const settings = parseLoadSettings(args)

/**
 * Adds the seeded schema's `search_path` to a Postgres connection string via
 * the `options` query parameter (`options: -c search_path="<schema>"`), the
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
  url.searchParams.set('options', `-c search_path="${schema}"`)
  return url.toString()
}

/**
 * Starts the server against the seeded schema, runs the tests, prints and
 * saves the table, and stops the server. Unlike `pnpm perf:fs`, no data is
 * removed afterward: the seeded schema is left in place for inspection or
 * reuse, and `pnpm perf:pg:seed` is what resets it.
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  const meta = await readSeedMeta<{
    schema: string
    databaseUrl: string
    encryptedIds: Record<MatrixPayload, string>
  }>({
    seedDir: defaultSeedDirs.pg,
    seedCommand: 'pnpm perf:pg:seed',
    hasOwnMembers: ({ schema, databaseUrl, encryptedIds }) =>
      typeof schema === 'string' &&
      typeof databaseUrl === 'string' &&
      isEncryptedIds(encryptedIds)
  })
  const { seed, sizes, edgeSizes, schema } = meta
  const baseDatabaseUrl =
    args['database-url'] ?? process.env.DATABASE_URL ?? meta.databaseUrl
  const databaseUrl = withSchema({ databaseUrl: baseDatabaseUrl, schema })

  const k6Version = findK6({ rerunCommand: 'pnpm perf:pg' })
  const outDir = await mkdtemp(join(tmpdir(), 'was-perf-pg-'))

  const header = reportHeader({
    title: 'Postgres backend performance',
    k6Version,
    settings,
    extraLines: [`- Schema: ${schema}`]
  })
  console.log(header.join('\n'))
  printEstimate({
    sizes,
    edgeSizes,
    settings,
    k6Version,
    filling: false,
    matrix: true
  })

  const publicRead = unsignedReader({
    serverUrl: localServerUrl,
    outDir,
    k6Version,
    settings
  })
  const { rows, matrixRows } = await runAgainstServer({
    outDir,
    env: { DATABASE_URL: databaseUrl },
    run: async () => {
      const pws = await connect({ serverUrl: localServerUrl, seed })
      const targets = seededTargets({ pws, edgeSizes })
      const rows = await runTests({
        pws,
        sizes,
        targets,
        settings,
        publicRead
      })
      const matrixRows = await runPayloadMatrix({
        pws,
        settings,
        encryptedIds: meta.encryptedIds,
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
      ...matrixReport({ rows: matrixRows })
    ]
  })
}

main().catch(err => {
  console.error(`\n${(err as Error).message}`)
  process.exit(1)
})
