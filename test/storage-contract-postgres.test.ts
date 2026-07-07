/**
 * Runs the shared StorageBackend contract suite against the Postgres backend,
 * plus the cross-backend export/import round-trip (the filesystem-to-Postgres
 * migration path and back).
 *
 * OPT-IN: requires a disposable Postgres reachable via `WAS_TEST_DATABASE_URL`
 * (the README's "Storage Backends" section has a Podman one-liner); skipped
 * with a
 * visible notice when unset, so `pnpm test-node` passes without a container.
 * Isolation: each harness operates in a throwaway `was_test_<hex>` schema
 * (the Postgres analogue of the per-suite temp dir), dropped on cleanup, so
 * parallel Vitest workers cannot collide.
 *
 *   WAS_TEST_DATABASE_URL=postgres://was:was@localhost:5433/was pnpm test:pg
 */
import { it, describe, expect } from 'vitest'
import assert from 'node:assert'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import pg from 'pg'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { PostgresBackend } from '../src/backends/postgres.js'
import { extractTarEntries } from '../src/lib/importTar.js'
import {
  describeStorageBackendContract,
  type BackendHarness
} from './storage-backend-contract.js'

const connectionString = process.env.WAS_TEST_DATABASE_URL

async function makePostgresHarness(
  options: { capacityBytes?: number; maxUploadBytes?: number } = {}
): Promise<BackendHarness> {
  const schema = `was_test_${crypto.randomBytes(8).toString('hex')}`
  const backend = new PostgresBackend({
    connectionString: connectionString!,
    schema,
    ...options
  })
  await backend.init()
  return {
    backend,
    async cleanup() {
      await backend.close()
      const admin = new pg.Client({ connectionString: connectionString! })
      await admin.connect()
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      } finally {
        await admin.end()
      }
    }
  }
}

if (!connectionString) {
  describe('PostgresBackend', () => {
    it.skip('skipped: set WAS_TEST_DATABASE_URL to run the Postgres backend tests', () => {})
  })
} else {
  describeStorageBackendContract({
    name: 'PostgresBackend',
    makeBackend: makePostgresHarness,
    // Transactional accounting: the quota is a HARD limit under concurrency,
    // and usage is exactly the stored content bytes.
    hardQuota: true,
    exactUsage: true
  })

  describe('cross-backend export/import round-trip', () => {
    async function makeFilesystemHarness(): Promise<
      BackendHarness & { dataDir: string }
    > {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), 'was-contract-xfs-'))
      return {
        backend: new FileSystemBackend({ dataDir }),
        dataDir,
        async cleanup() {
          await rm(dataDir, { recursive: true, force: true })
        }
      }
    }

    /** Populates a Space with a representative mix on the given backend. */
    async function populate(harness: BackendHarness, spaceId: string) {
      const { backend } = harness
      await backend.writeSpace({
        spaceId,
        spaceDescription: {
          id: spaceId,
          type: ['Space'],
          name: 'Round Trip',
          controller: 'did:key:z6MkRoundTrip'
        }
      })
      await backend.writeCollection({
        spaceId,
        collectionId: 'docs',
        collectionDescription: {
          id: 'docs',
          type: ['Collection'],
          name: 'Documents'
        }
      })
      await backend.writeResource({
        spaceId,
        collectionId: 'docs',
        resourceId: 'json-doc',
        input: {
          kind: 'json',
          contentType: 'application/json',
          data: { hello: 'round trip', n: [1, 2, 3] }
        }
      })
      await backend.writeResource({
        spaceId,
        collectionId: 'docs',
        resourceId: 'blob',
        input: {
          kind: 'binary',
          contentType: 'application/octet-stream',
          stream: Readable.from(Buffer.from([7, 8, 9, 0, 255]))
        }
      })
      await backend.writeResourceMetadata({
        spaceId,
        collectionId: 'docs',
        resourceId: 'json-doc',
        custom: { name: 'The Doc', tags: ['a', 'b'] }
      })
      await backend.writeResource({
        spaceId,
        collectionId: 'docs',
        resourceId: 'tomb',
        input: {
          kind: 'json',
          contentType: 'application/json',
          data: { soon: 'gone' }
        }
      })
      await backend.deleteResource({
        spaceId,
        collectionId: 'docs',
        resourceId: 'tomb'
      })
      await backend.writePolicy({
        spaceId,
        policy: { level: 'space' } as never
      })
      await backend.writePolicy({
        spaceId,
        collectionId: 'docs',
        policy: { level: 'collection' } as never
      })
    }

    /**
     * Indexes a Space-export tar: entry names, plus parsed JSON for the
     * dot-files and raw bytes for resource representations. JSON documents
     * are compared parsed (jsonb does not preserve key order), resource
     * bodies byte-for-byte.
     */
    async function indexArchive(tarStream: Readable) {
      const entries = await extractTarEntries(tarStream)
      const names = [...entries.keys()].sort()
      const parsed = new Map<string, unknown>()
      const bytes = new Map<string, Buffer>()
      for (const [name, entry] of entries) {
        if (entry.type !== 'file' || !entry.body) {
          continue
        }
        const base = name.split('/').pop()!
        if (base.startsWith('.') && base.endsWith('.json')) {
          parsed.set(name, JSON.parse(entry.body.toString('utf8')))
        } else if (base.startsWith('r.')) {
          bytes.set(name, entry.body)
        }
      }
      return { names, parsed, bytes }
    }

    it.runIf(Boolean(connectionString))(
      'filesystem export imports into Postgres and re-exports equivalently (and vice versa)',
      async () => {
        const spaceId = 'xchg-space'
        const fsSource = await makeFilesystemHarness()
        const pgTarget = await makePostgresHarness()
        const fsTarget = await makeFilesystemHarness()
        try {
          await populate(fsSource, spaceId)
          const fsArchive = await indexArchive(
            await fsSource.backend.exportSpace({ spaceId })
          )

          // FS to PG: import, then re-export and compare.
          await pgTarget.backend.writeSpace({
            spaceId,
            spaceDescription: {
              id: spaceId,
              type: ['Space'],
              name: 'Round Trip',
              controller: 'did:key:z6MkRoundTrip'
            }
          })
          await pgTarget.backend.importSpace({
            spaceId,
            tarStream: await fsSource.backend.exportSpace({ spaceId })
          })
          const pgArchive = await indexArchive(
            await pgTarget.backend.exportSpace({ spaceId })
          )
          assert.deepEqual(pgArchive.names, fsArchive.names)
          for (const [name, body] of fsArchive.bytes) {
            assert.deepEqual(
              pgArchive.bytes.get(name),
              body,
              `resource bytes differ: ${name}`
            )
          }
          for (const [name, doc] of fsArchive.parsed) {
            assert.deepEqual(
              pgArchive.parsed.get(name),
              doc,
              `document differs: ${name}`
            )
          }

          // And back: PG to FS.
          await fsTarget.backend.writeSpace({
            spaceId,
            spaceDescription: {
              id: spaceId,
              type: ['Space'],
              name: 'Round Trip',
              controller: 'did:key:z6MkRoundTrip'
            }
          })
          const stats = await fsTarget.backend.importSpace({
            spaceId,
            tarStream: await pgTarget.backend.exportSpace({ spaceId })
          })
          assert.equal(stats.collectionsCreated, 1)
          assert.equal(stats.resourcesCreated, 3) // json-doc, blob, tombstone
          const backArchive = await indexArchive(
            await fsTarget.backend.exportSpace({ spaceId })
          )
          assert.deepEqual(backArchive.names, fsArchive.names)

          // Spot-check semantics on the Postgres side: content, metadata,
          // and the tombstone's read-invisibility.
          const doc = await pgTarget.backend.getResource({
            spaceId,
            collectionId: 'docs',
            resourceId: 'json-doc'
          })
          const chunks: Buffer[] = []
          for await (const chunk of doc.resourceStream) {
            chunks.push(Buffer.from(chunk))
          }
          assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
            hello: 'round trip',
            n: [1, 2, 3]
          })
          const metadata = await pgTarget.backend.getResourceMetadata({
            spaceId,
            collectionId: 'docs',
            resourceId: 'json-doc'
          })
          assert.deepEqual(metadata?.custom, {
            name: 'The Doc',
            tags: ['a', 'b']
          })
          await expect(
            pgTarget.backend.getResource({
              spaceId,
              collectionId: 'docs',
              resourceId: 'tomb'
            })
          ).rejects.toThrow()
        } finally {
          await fsSource.cleanup()
          await pgTarget.cleanup()
          await fsTarget.cleanup()
        }
      }
    )
  })
}
