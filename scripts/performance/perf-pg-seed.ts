/**
 * Pre-seeds a Postgres schema for `pnpm perf:pg`, so a run can skip refilling
 * Collections over signed HTTP every time.
 *
 * Drops and recreates a fixed schema (`perf` by default) each time it runs,
 * then writes directly through `PostgresBackend`'s own write methods (the
 * same class the server uses), under a throwaway `did:key` whose private key
 * it persists alongside the seed (`.perf-pg-seed/seed-meta.json`), so
 * `pnpm perf:pg` can reload the identity and issue valid signed requests
 * against the same Spaces. The on-disk result is what a real signed write
 * over HTTP would have produced: `createdBy` and `controller` are explicitly
 * set to that same `did:key`, matching what the request handlers set from
 * `invokerDid(request)`.
 *
 * The seeded layout matches `scripts/performance/perf-fs-seed.ts`'s: a `perf-public`
 * Space (one public Collection per size), a `perf-private` Space (one private
 * Collection per size), and three Spaces per edge size (`perf-write-<size>`,
 * `perf-delete-<size>`, `perf-serial-<size>`), each with a single `items`
 * Collection.
 *
 * Usage: pnpm perf:pg:seed [--sizes 1,500] [--schema perf]
 *   [--database-url postgres://was:was@localhost:5433/was]
 */
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'

import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import pg from 'pg'

import {
  assertValidSchemaName,
  PostgresBackend
} from '../../src/backends/postgres.js'
import {
  credential,
  fillConcurrently,
  itemIds,
  parseSizes
} from './perf-lib.js'

const seedConcurrency = 10
const outDir = '.perf-pg-seed'
const defaultDatabaseUrl = 'postgres://was:was@localhost:5433/was'

const { values: args } = parseArgs({
  options: {
    sizes: { type: 'string', default: '1,500' },
    schema: { type: 'string', default: 'perf' },
    'database-url': { type: 'string' }
  }
})
const { sizes, edgeSizes } = parseSizes(args.sizes)
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
 * Writes one Resource per id directly through the backend, several at a
 * time, under `createdBy`.
 * @param options {object}
 * @param options.backend {PostgresBackend}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.ids {string[]}
 * @param options.createdBy {`did:${string}`}
 * @returns {Promise<void>}
 */
async function fill({
  backend,
  spaceId,
  collectionId,
  ids,
  createdBy
}: {
  backend: PostgresBackend
  spaceId: string
  collectionId: string
  ids: string[]
  createdBy: `did:${string}`
}): Promise<void> {
  await fillConcurrently({
    ids,
    concurrency: seedConcurrency,
    write: id =>
      backend.writeResource({
        spaceId,
        collectionId,
        resourceId: id,
        input: {
          kind: 'json',
          contentType: 'application/json',
          data: credential(id)
        },
        createdBy
      })
  })
}

/**
 * Creates one Space with one Collection, filled to `size`, directly through
 * the backend.
 * @param options {object}
 * @param options.backend {PostgresBackend}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.size {number}
 * @param options.controller {`did:${string}`}
 * @param options.makePublic {boolean}
 * @returns {Promise<void>}
 */
async function seedSpace({
  backend,
  spaceId,
  collectionId,
  size,
  controller,
  makePublic
}: {
  backend: PostgresBackend
  spaceId: string
  collectionId: string
  size: number
  controller: `did:${string}`
  makePublic: boolean
}): Promise<void> {
  await backend.writeSpace({
    spaceId,
    spaceMetadata: { id: spaceId, type: ['Space'], controller },
    createdBy: controller
  })
  await backend.writeCollection({
    spaceId,
    collectionId,
    collectionMetadata: { id: collectionId, type: ['Collection'] },
    createdBy: controller
  })
  await fill({
    backend,
    spaceId,
    collectionId,
    ids: itemIds(size),
    createdBy: controller
  })
  if (makePublic) {
    await backend.writePolicy({
      spaceId,
      collectionId,
      policy: { type: 'PublicCanRead' }
    })
  }
}

/**
 * Drops and recreates `schema`, seeds every Space `pnpm perf:pg` expects
 * directly through `PostgresBackend`, and persists the signing identity and
 * the sizes alongside it.
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  await dropSchema({ connectionString: databaseUrl, schema })
  await mkdir(outDir, { recursive: true })
  const seed = Uint8Array.from(randomBytes(32))
  const keyPair = await Ed25519VerificationKey.generate({ seed })
  const controller = `did:key:${keyPair.fingerprint()}` as const

  const backend = await PostgresBackend.open({
    connectionString: databaseUrl,
    schema
  })
  try {
    for (const size of sizes) {
      await seedSpace({
        backend,
        spaceId: 'perf-public',
        collectionId: `c-${size}`,
        size,
        controller,
        makePublic: true
      })
      await seedSpace({
        backend,
        spaceId: 'perf-private',
        collectionId: `c-${size}`,
        size,
        controller,
        makePublic: false
      })
    }
    for (const size of edgeSizes) {
      for (const label of ['perf-write', 'perf-delete', 'perf-serial']) {
        await seedSpace({
          backend,
          spaceId: `${label}-${size}`,
          collectionId: 'items',
          size,
          controller,
          makePublic: false
        })
      }
    }
  } finally {
    await backend.close()
  }

  await writeFile(
    join(outDir, 'seed-meta.json'),
    JSON.stringify(
      {
        seed: Buffer.from(seed).toString('base64'),
        sizes,
        edgeSizes,
        schema,
        databaseUrl
      },
      null,
      2
    )
  )
  console.log(
    `Seeded schema "${schema}" at ${databaseUrl} (sizes: ${sizes.join(', ')})`
  )
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
