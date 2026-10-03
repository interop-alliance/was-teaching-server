/**
 * The Postgres backend's side of the write stamps: the hybrid logical clock's
 * high-water mark in the store row (persisted on a cadence and seeded at the
 * next boot), a restarted clock minting above a stamp the store already
 * holds, and the boot refusal of a schema that holds Spaces written before
 * records carried stamps. The stamp behavior every backend shares runs in the
 * storage contract suite.
 *
 * OPT-IN like the Postgres contract suite: requires a disposable Postgres
 * reachable via `WAS_TEST_DATABASE_URL`, and skipped with a visible notice
 * when unset. Each test operates in a throwaway `was_test_<hex>` schema,
 * dropped afterwards.
 *
 *   WAS_TEST_DATABASE_URL=postgres://was:was@localhost:5433/was pnpm test:pg
 */
import { it, describe, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert'
import crypto from 'node:crypto'
import pg from 'pg'
import { PostgresBackend } from '../src/backends/postgres.js'
import { MIGRATIONS } from '../src/backends/postgresSchema.js'
import { StoreVersionError } from '../src/errors.js'
import { compareStamps, readingOfStamp } from '../src/lib/hlc.js'
import { etagOf, formatEtag } from '../src/lib/etag.js'
import { frozenClock } from './helpers.js'

const connectionString = process.env.WAS_TEST_DATABASE_URL

const CONTROLLER = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'

/**
 * The schema version before records carried write stamps.
 */
const PRE_STAMP_VERSION = 8

if (!connectionString) {
  describe('PostgresBackend write stamps', () => {
    it.skip('skipped: set WAS_TEST_DATABASE_URL to run the Postgres backend tests', () => {})
  })
} else {
  describe('PostgresBackend write stamps', () => {
    let schema: string
    const backends: PostgresBackend[] = []

    /**
     * Opens a backend over the test's schema under the given physical clock.
     * @param [physicalClock] {() => number}
     * @returns {Promise<PostgresBackend>}
     */
    async function boot(
      physicalClock?: () => number
    ): Promise<PostgresBackend> {
      const backend = await PostgresBackend.open({
        connectionString: connectionString!,
        schema,
        ...(physicalClock !== undefined && { physicalClock })
      })
      backends.push(backend)
      return backend
    }

    /**
     * Runs one statement as an admin client outside any backend's pool.
     * @param sql {string}
     * @param [values] {unknown[]}
     * @returns {Promise<pg.QueryResult>}
     */
    async function adminQuery(
      sql: string,
      values?: unknown[]
    ): Promise<pg.QueryResult> {
      const admin = new pg.Client({ connectionString: connectionString! })
      await admin.connect()
      try {
        return await admin.query(sql, values)
      } finally {
        await admin.end()
      }
    }

    /**
     * Reads the store row's `clock_high_water` column.
     * @returns {Promise<number | undefined>}
     */
    async function storedHighWater(): Promise<number | undefined> {
      const { rows } = await adminQuery(
        `SELECT clock_high_water FROM "${schema}".store`
      )
      const value = rows[0]?.clock_high_water as string | null | undefined
      return value === null || value === undefined ? undefined : Number(value)
    }

    /**
     * The newest version the test schema's `schema_migrations` records.
     * @returns {Promise<number>}
     */
    async function storedSchemaVersion(): Promise<number> {
      const { rows } = await adminQuery(
        `SELECT max(version)::int AS version FROM "${schema}".schema_migrations`
      )
      return rows[0]!.version as number
    }

    /**
     * Builds the test schema at the version before write stamps (8), as a
     * build from before them left it: the first eight migrations applied and
     * recorded, and the store row filled. The scripts are run directly,
     * since the current runner reads the store row's later columns.
     * @returns {Promise<void>}
     */
    async function migrateToPreStampVersion(): Promise<void> {
      await adminQuery(`CREATE SCHEMA "${schema}"`)
      const client = new pg.Client({
        connectionString: connectionString!,
        options: `-csearch_path=${schema}`
      })
      await client.connect()
      try {
        await client.query(`
          CREATE TABLE schema_migrations (
            version    integer PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
          )
        `)
        const preStamp = MIGRATIONS.slice(0, PRE_STAMP_VERSION)
        for (const [index, migration] of preStamp.entries()) {
          assert.equal(typeof migration, 'string')
          await client.query(migration as string)
          await client.query(
            'INSERT INTO schema_migrations (version) VALUES ($1)',
            [index + 1]
          )
        }
        await client.query(
          "INSERT INTO store (origin_id) VALUES ('pre-stamp-origin')"
        )
      } finally {
        await client.end()
      }
    }

    /**
     * Writes a Space and one Collection in it.
     * @param backend {PostgresBackend}
     * @returns {Promise<void>}
     */
    async function provision(backend: PostgresBackend): Promise<void> {
      await backend.writeSpace({
        spaceId: 'space1',
        spaceMetadata: { id: 'space1', type: ['Space'], controller: CONTROLLER }
      })
      await backend.writeCollection({
        spaceId: 'space1',
        collectionId: 'notes',
        collectionMetadata: { id: 'notes', type: ['Collection'] }
      })
    }

    beforeEach(() => {
      schema = `was_test_${crypto.randomBytes(8).toString('hex')}`
    })

    afterEach(async () => {
      await Promise.all(backends.splice(0).map(backend => backend.close()))
      await adminQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    })

    it('persists the high-water mark in the store row on a cadence and seeds the clock from it at the next boot', async () => {
      const physical = frozenClock()
      const start = physical.now
      const backend = await boot(physical.read)
      assert.equal(await storedHighWater(), undefined)

      await backend.writeSpace({
        spaceId: 'space1',
        spaceMetadata: { id: 'space1', type: ['Space'], controller: CONTROLLER }
      })
      assert.equal(await storedHighWater(), start)

      // Within a second of the mark, a write leaves it.
      physical.now = start + 500
      await backend.writeCollection({
        spaceId: 'space1',
        collectionId: 'notes',
        collectionMetadata: { id: 'notes', type: ['Collection'] }
      })
      assert.equal(await storedHighWater(), start)

      // Past it, the next write persists the new reading.
      physical.now = start + 5000
      await backend.writeCollection({
        spaceId: 'space1',
        collectionId: 'notes',
        collectionMetadata: { id: 'notes', type: ['Collection'] }
      })
      assert.equal(await storedHighWater(), start + 5000)

      // A reboot whose physical clock stands behind the mark mints just past
      // it, above everything minted before the restart.
      const behind = frozenClock(start - 60_000)
      const rebooted = await boot(behind.read)
      const minted = await rebooted.clock.mint()
      assert.deepEqual(readingOfStamp(minted), {
        ms: start + 5000 + 1,
        counter: 0
      })
      assert.equal(minted.originId, backend.originId)
    })

    it('persists the high-water mark on close(), so a clean restart mints above every stamp minted before it', async () => {
      const physical = frozenClock()
      const start = physical.now
      const backend = await boot(physical.read)
      await backend.writeSpace({
        spaceId: 'space1',
        spaceMetadata: { id: 'space1', type: ['Space'], controller: CONTROLLER }
      })
      // Within the cadence, so the write leaves the mark behind its stamp.
      physical.now = start + 500
      await backend.writeCollection({
        spaceId: 'space1',
        collectionId: 'notes',
        collectionMetadata: { id: 'notes', type: ['Collection'] }
      })
      assert.equal(await storedHighWater(), start)

      backends.splice(backends.indexOf(backend), 1)
      await backend.close()
      assert.equal(await storedHighWater(), start + 500)

      const behind = frozenClock(start - 60_000)
      const rebooted = await boot(behind.read)
      const minted = await rebooted.clock.mint()
      assert.deepEqual(readingOfStamp(minted), {
        ms: start + 500 + 1,
        counter: 0
      })
      const stored = await rebooted.getCollectionMetadata({
        spaceId: 'space1',
        collectionId: 'notes'
      })
      assert.ok(
        compareStamps(minted, {
          updatedAt: stored!.updatedAt!,
          updatedAtCounter: stored!.updatedAtCounter!,
          originId: stored!.originId!
        }) > 0
      )
    })

    it('close() logs a failed high-water write and still drains the pools', async () => {
      const physical = frozenClock()
      const backend = await boot(physical.read)
      const warnings: unknown[] = []
      backend.logger = {
        ...backend.logger,
        warn: (object: unknown) => warnings.push(object)
      } as any
      await backend.clock.mint()
      physical.now += 1
      backend.clock.now()
      await adminQuery(`DROP TABLE "${schema}".store`)
      backends.splice(backends.indexOf(backend), 1)
      await backend.close()
      assert.equal(warnings.length, 1)
    })

    it('a restarted clock behind a stored stamp mints a later stamp over it', async () => {
      const physical = frozenClock()
      const start = physical.now
      const backend = await boot(physical.read)
      await provision(backend)
      assert.equal(await storedHighWater(), start)
      const priorCollection = await backend.getCollectionMetadata({
        spaceId: 'space1',
        collectionId: 'notes'
      })

      // Stored half a second past the persisted mark: within the cadence, so
      // the mark stays behind this stamp.
      physical.now = start + 500
      const stored = await backend.writeResource({
        spaceId: 'space1',
        collectionId: 'notes',
        resourceId: 'doc',
        input: { kind: 'json', contentType: 'application/json', data: {} }
      })
      assert.equal(await storedHighWater(), start)

      // The restarted clock starts at the mark plus one millisecond, below
      // the stored stamp, and its physical clock stands further back still.
      const behind = frozenClock(start - 60_000)
      const rebooted = await boot(behind.read)
      const rewritten = await rebooted.writeResource({
        spaceId: 'space1',
        collectionId: 'notes',
        resourceId: 'doc',
        input: { kind: 'json', contentType: 'application/json', data: { n: 2 } }
      })
      assert.equal(rewritten.generation, stored.generation)
      assert.equal(rewritten.stamp.updatedAt, stored.stamp.updatedAt)
      assert.equal(
        rewritten.stamp.updatedAtCounter,
        stored.stamp.updatedAtCounter + 1
      )

      const metadata = await rebooted.getResourceMetadata({
        spaceId: 'space1',
        collectionId: 'notes',
        resourceId: 'doc'
      })
      assert.equal(etagOf(metadata!), formatEtag(rewritten))
      assert.ok(
        compareStamps(
          {
            updatedAt: metadata!.updatedAt!,
            updatedAtCounter: metadata!.updatedAtCounter!,
            originId: metadata!.originId!
          },
          stored.stamp
        ) > 0
      )

      // The same holds for a container Metadata object, whose stored stamp
      // the seeded clock already stands above.
      const collection = await rebooted.writeCollection({
        spaceId: 'space1',
        collectionId: 'notes',
        collectionMetadata: { id: 'notes', type: ['Collection'] }
      })
      assert.ok(
        compareStamps(collection.stamp, {
          updatedAt: priorCollection!.updatedAt!,
          updatedAtCounter: priorCollection!.updatedAtCounter!,
          originId: priorCollection!.originId!
        }) > 0
      )
    })

    it('stamps an empty pre-stamp schema at the current version, and boots', async () => {
      await migrateToPreStampVersion()
      assert.equal(await storedSchemaVersion(), PRE_STAMP_VERSION)
      const backend = await boot()
      assert.equal(await storedSchemaVersion(), MIGRATIONS.length)
      assert.equal(backend.originId, 'pre-stamp-origin')
      await provision(backend)
      const stored = await backend.getSpaceMetadata({ spaceId: 'space1' })
      assert.equal(stored?.originId, backend.originId)
      assert.equal(stored?.metaLocal, 0)
    })

    it('refuses a pre-stamp schema that holds a Space, on every boot', async () => {
      await migrateToPreStampVersion()
      await adminQuery(
        `INSERT INTO "${schema}".spaces (space_id, metadata, controller)
         VALUES ($1, $2::jsonb, $3)`,
        [
          'old-space',
          JSON.stringify({ id: 'old-space', controller: CONTROLLER }),
          CONTROLLER
        ]
      )
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(
          PostgresBackend.open({ connectionString: connectionString!, schema }),
          (err: unknown) =>
            err instanceof StoreVersionError &&
            err.message.includes('1 Space(s)')
        )
        assert.equal(await storedSchemaVersion(), PRE_STAMP_VERSION)
      }
      // The refusal rolled the whole run back: the old layout stands.
      const { rows } = await adminQuery(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'resources'
            AND column_name = 'version'`,
        [schema]
      )
      assert.equal(rows.length, 1)
    })
  })
}
