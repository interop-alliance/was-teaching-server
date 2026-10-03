/**
 * The Postgres backend's per-store origin id: settled by `open()` from the
 * single-row `store` table, minted on a fresh schema or taken from the
 * configured id, and refused when a configured id differs from the stored one.
 *
 * OPT-IN like the Postgres contract suite: requires a disposable Postgres
 * reachable via `WAS_TEST_DATABASE_URL`, and skipped with a visible notice
 * when unset. Each test operates in a throwaway `was_test_<hex>` schema,
 * dropped afterwards.
 *
 *   WAS_TEST_DATABASE_URL=postgres://was:was@localhost:5433/was pnpm test:pg
 */
import { it, describe, expect, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert'
import crypto from 'node:crypto'
import pg from 'pg'
import { PostgresBackend } from '../src/backends/postgres.js'
import { StoreOriginIdError } from '../src/errors.js'
import { ORIGIN_ID_PATTERN } from '../src/lib/originId.js'

const connectionString = process.env.WAS_TEST_DATABASE_URL

if (!connectionString) {
  describe('PostgresBackend origin id', () => {
    it.skip('skipped: set WAS_TEST_DATABASE_URL to run the Postgres backend tests', () => {})
  })
} else {
  describe('PostgresBackend origin id', () => {
    let schema: string
    const backends: PostgresBackend[] = []

    /**
     * Opens a backend over the test's schema.
     * @param [originId] {string}   the configured origin id
     * @returns {Promise<PostgresBackend>}
     */
    async function boot(originId?: string): Promise<PostgresBackend> {
      const backend = await PostgresBackend.open({
        connectionString: connectionString!,
        schema,
        originId
      })
      backends.push(backend)
      return backend
    }

    /**
     * Runs one statement as an admin client outside any backend's pool.
     * @param sql {string}
     * @returns {Promise<pg.QueryResult>}
     */
    async function adminQuery(sql: string): Promise<pg.QueryResult> {
      const admin = new pg.Client({ connectionString: connectionString! })
      await admin.connect()
      try {
        return await admin.query(sql)
      } finally {
        await admin.end()
      }
    }

    /**
     * Reads the store table's rows directly.
     * @returns {Promise<string[]>}   every stored origin id
     */
    async function storedOriginIds(): Promise<string[]> {
      const { rows } = await adminQuery(
        `SELECT origin_id FROM "${schema}".store`
      )
      return rows.map(row => row.origin_id as string)
    }

    beforeEach(() => {
      schema = `was_test_${crypto.randomBytes(8).toString('hex')}`
    })

    afterEach(async () => {
      await Promise.all(backends.splice(0).map(backend => backend.close()))
      await adminQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    })

    it('mints an id on a fresh schema and reads it back on the next init', async () => {
      const first = await boot()
      assert.match(first.originId, ORIGIN_ID_PATTERN)
      const second = await boot()
      assert.equal(second.originId, first.originId)
      assert.deepEqual(await storedOriginIds(), [first.originId])
    })

    it('uses a configured id verbatim and reads it back unconfigured', async () => {
      const first = await boot('origin-a')
      assert.equal(first.originId, 'origin-a')
      const configured = await boot('origin-a')
      assert.equal(configured.originId, 'origin-a')
      const unconfigured = await boot()
      assert.equal(unconfigured.originId, 'origin-a')
    })

    it('refuses a configured id that differs from the stored one', async () => {
      const first = await boot()
      const stored = first.originId
      await expect(boot('origin-b')).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof StoreOriginIdError &&
          err.message.includes(`"${stored}"`) &&
          err.message.includes('"origin-b"')
      )
      assert.deepEqual(await storedOriginIds(), [stored])
    })

    it('fills an empty store table on the next init', async () => {
      const first = await boot()
      await adminQuery(`DELETE FROM "${schema}".store`)
      const second = await boot()
      assert.match(second.originId, ORIGIN_ID_PATTERN)
      assert.notEqual(second.originId, first.originId)
      assert.deepEqual(await storedOriginIds(), [second.originId])
    })

    it('carries the id as soon as open() resolves', async () => {
      const backend = await PostgresBackend.open({
        connectionString: connectionString!,
        schema
      })
      backends.push(backend)
      assert.match(backend.originId, ORIGIN_ID_PATTERN)
    })
  })
}
