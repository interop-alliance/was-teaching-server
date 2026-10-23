/**
 * Pre-seeds a Postgres schema for `pnpm perf:pg`, so a run can skip refilling
 * Collections over signed HTTP every time.
 *
 * Drops and recreates a fixed schema (`perf` by default) each time it runs,
 * then writes directly through `PostgresBackend`'s own write methods (the
 * same class the server uses), under a throwaway `did:key` whose private key
 * it persists alongside the seed (`.perf-pg-seed/seed-meta.json`), so
 * `pnpm perf:pg` can reload the identity and issue valid signed requests
 * against the same Spaces. The seeded rows are what a real signed write
 * over HTTP would have produced: `createdBy` and `controller` are explicitly
 * set to that same `did:key`, matching what the request handlers set from
 * `invokerDid(request)`.
 *
 * The seeded layout matches `scripts/performance/perf-fs-seed.ts`'s: a
 * `perf-public` Space (one public Collection per size), a `perf-private`
 * Space (one private Collection per size), and three Spaces per edge size
 * (`perf-write-<size>`, `perf-delete-<size>`, `perf-serial-<size>`), each
 * with a single `items` Collection.
 *
 * It then seeds the payload matrix (`scripts/performance/perf-matrix-seed.ts`)
 * over signed HTTP, through an in-process server on the same backend, since an
 * encrypted Collection's key epoch and EDV envelopes are made by was-client:
 * the `perf-matrix-read` and `perf-matrix-write` Spaces, and
 * `--binary-total-mib` MiB of extra binary data in the `perf-ballast` Space. The encrypted read
 * targets' EDV ids go into `seed-meta.json` too.
 *
 * Usage: pnpm perf:pg:seed [--sizes 1,500,2000] [--binary-total-mib 100]
 *   [--schema perf] [--database-url postgres://was:was@localhost:5433/was]
 */
import { mkdir } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import pg from 'pg'

import {
  assertValidSchemaName,
  PostgresBackend
} from '../../src/backends/postgres.js'
import {
  formatSeedPlan,
  parseSizes,
  positiveInteger,
  seedSizeSpaces
} from './perf-lib.js'
import { seedMatrixInProcess } from './perf-matrix-seed.js'
import {
  createSeedIdentity,
  defaultSeedDirs,
  writeSeedMeta
} from './perf-seed-meta.js'

const defaultDatabaseUrl = 'postgres://was:was@localhost:5433/was'

const { values: args } = parseArgs({
  options: {
    sizes: { type: 'string', default: '1,500,2000' },
    'binary-total-mib': { type: 'string', default: '100' },
    schema: { type: 'string', default: 'perf' },
    'database-url': { type: 'string' }
  }
})
const { sizes, edgeSizes } = parseSizes(args.sizes)
const binaryTotalMib = positiveInteger(args['binary-total-mib'])
const databaseUrl =
  args['database-url'] ?? process.env.DATABASE_URL ?? defaultDatabaseUrl
const schema = args.schema
assertValidSchemaName(schema)

/**
 * Drops `schema` if it exists, so a reseed starts from nothing rather than
 * layering onto the previous run's data. Run before `PostgresBackend.open()`,
 * which only creates a schema, never drops one.
 * @param options {object}
 * @param options.connectionString {string}
 * @param options.schema {string}
 * @returns {Promise<void>}
 */
async function dropSchema({
  connectionString,
  schema
}: {
  connectionString: string
  schema: string
}): Promise<void> {
  const client = new pg.Client({ connectionString })
  await client.connect()
  try {
    // Identifier-quoted; validated by assertValidSchemaName above.
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  } finally {
    await client.end()
  }
}

/**
 * A connection string fit to print: its password, if any, replaced with
 * `***`.
 * @param connectionString {string}
 * @returns {string}
 */
function redactPassword(connectionString: string): string {
  const url = new URL(connectionString)
  if (url.password !== '') {
    url.password = '***'
  }
  return url.toString()
}

/**
 * Drops and recreates `schema`, seeds the Collection-size Spaces directly
 * through `PostgresBackend`, then the payload matrix over HTTP, and persists
 * the signing identity, the sizes and the encrypted read targets' ids
 * alongside it.
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  console.log(
    formatSeedPlan({
      target:
        `schema "${schema}" at ${redactPassword(databaseUrl)} ` +
        '(--schema, --database-url)',
      sizes,
      ballast: `${binaryTotalMib} MiB (--binary-total-mib)`
    })
  )
  await dropSchema({ connectionString: databaseUrl, schema })
  await mkdir(defaultSeedDirs.pg, { recursive: true })
  const { seed, controller } = await createSeedIdentity()

  const backend = await PostgresBackend.open({
    connectionString: databaseUrl,
    schema
  })
  try {
    await seedSizeSpaces({ backend, sizes, edgeSizes, controller })
  } catch (err) {
    await backend.close()
    throw err
  }

  console.log(
    `Seeding the payload matrix and ${binaryTotalMib} MiB of binary ballast...`
  )
  const encryptedIds = await seedMatrixInProcess({
    backend,
    seed,
    binaryTotalMib
  })

  await writeSeedMeta({
    seedDir: defaultSeedDirs.pg,
    meta: {
      seed,
      sizes,
      edgeSizes,
      schema,
      databaseUrl,
      binaryTotalMib,
      encryptedIds
    }
  })
  console.log(
    `Seeded schema "${schema}" at ${redactPassword(databaseUrl)} (sizes: ${sizes.join(', ')}; ` +
      `matrix and ${binaryTotalMib} MiB ballast)`
  )
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
