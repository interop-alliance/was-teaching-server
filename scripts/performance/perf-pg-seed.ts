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
 * It then seeds the payload matrix (`scripts/performance/perf-matrix-seed.ts`)
 * over signed HTTP, through an in-process server on the same backend, since an
 * encrypted Collection's key epoch and EDV envelopes are made by was-client:
 * the `perf-matrix-read` and `perf-matrix-write` Spaces, and `--binary-total-mib`
 * MiB of extra binary data in the `perf-ballast` Space. The encrypted read
 * targets' EDV ids go into `seed-meta.json` too.
 *
 * Usage: pnpm perf:pg:seed [--sizes 1,500,2000] [--binary-total-mib 100]
 *   [--schema perf] [--database-url postgres://was:was@localhost:5433/was]
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
import { startTestServer } from '../../src/testing.js'
import {
  credential,
  fillConcurrently,
  itemIds,
  parseSizes,
  positiveInteger
} from './perf-lib.js'
import { seedMatrix } from './perf-matrix-seed.js'

const seedConcurrency = 10
const outDir = '.perf-pg-seed'
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
 * Drops and recreates `schema`, seeds the Collection-size Spaces directly
 * through `PostgresBackend`, then the payload matrix over HTTP, and persists
 * the signing identity, the sizes and the encrypted read targets' ids
 * alongside it.
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  console.log(
    [
      `Seeding schema "${schema}" at ${redactPassword(databaseUrl)} ` +
        '(--schema, --database-url), replacing what it holds:',
      `- Collection sizes: ${sizes.join(', ')} Resources (--sizes)`,
      '- Payload matrix: a JSON credential, a 100 KiB file and a 10 MiB file, ' +
        'in public, plaintext and encrypted Collections',
      `- Binary ballast: ${binaryTotalMib} MiB (--binary-total-mib)`,
      ''
    ].join('\n')
  )
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
  } catch (err) {
    await backend.close()
    throw err
  }

  console.log(
    `Seeding the payload matrix and ${binaryTotalMib} MiB of binary ballast...`
  )
  // The server owns the backend from here: `fastify.close()` closes it, and a
  // failed boot closes it before rethrowing.
  const { fastify, serverUrl } = await startTestServer({ backend })
  let encryptedIds
  try {
    encryptedIds = await seedMatrix({
      serverUrl,
      signerKey: keyPair,
      binaryTotalMib
    })
  } finally {
    await fastify.close()
  }

  await writeFile(
    join(outDir, 'seed-meta.json'),
    JSON.stringify(
      {
        seed: Buffer.from(seed).toString('base64'),
        sizes,
        edgeSizes,
        schema,
        databaseUrl,
        binaryTotalMib,
        encryptedIds
      },
      null,
      2
    )
  )
  console.log(
    `Seeded schema "${schema}" at ${redactPassword(databaseUrl)} (sizes: ${sizes.join(', ')}; ` +
      `matrix and ${binaryTotalMib} MiB ballast)`
  )
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
