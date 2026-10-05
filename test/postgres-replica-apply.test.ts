/**
 * The Postgres backend's replica registrations and apply path: the
 * `replicas` table, the registration records and their loop state, and each
 * `apply*` method's comparison against the held record.
 *
 * OPT-IN, like the rest of the Postgres suite: requires a disposable Postgres
 * reachable via `WAS_TEST_DATABASE_URL`, and is skipped with a visible notice
 * when unset. Each test runs in a throwaway `was_test_<hex>` schema.
 */
import { it, describe, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { text as streamText } from 'node:stream/consumers'
import pg from 'pg'
import { PostgresBackend } from '../src/backends/postgres.js'
import { MIGRATIONS } from '../src/backends/postgresSchema.js'
import { IdConflictError, SpaceNotFoundError } from '../src/errors.js'
import { formatEtag } from '../src/lib/etag.js'
import type {
  CollectionMetadata,
  ReplicaRegistration,
  WriteStamp
} from '../src/types.js'

const connectionString = process.env.WAS_TEST_DATABASE_URL

const spaceId = 'space-1'
const replicaId = 'from-peer'
const controller = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH'
// A fixed physical clock, so a test dates a received stamp against it.
const NOW = Date.parse('2026-10-04T12:00:00.000Z')

/**
 * A stamp from a peer, `offset` ms from the frozen clock.
 * @param offset {number}
 * @param [counter] {number}
 * @returns {WriteStamp}
 */
function peerStamp(offset: number, counter = 0): WriteStamp {
  return {
    updatedAt: new Date(NOW + offset).toISOString(),
    updatedAtCounter: counter,
    originId: 'peer-origin'
  }
}

const registration = {
  id: replicaId,
  fromSpace: 'https://peer.example/space/space-9/',
  toSpace: 'https://was.example/space/space-1/',
  capability: { id: 'urn:uuid:pull' },
  role: 'source'
} as unknown as ReplicaRegistration

if (!connectionString) {
  describe('PostgresBackend replica apply path', () => {
    it.skip('skipped: set WAS_TEST_DATABASE_URL to run the Postgres backend tests', () => {})
  })
} else {
  describe('PostgresBackend replica apply path', () => {
    let backend: PostgresBackend
    let schema: string

    beforeEach(async () => {
      schema = `was_test_${crypto.randomBytes(8).toString('hex')}`
      backend = await PostgresBackend.open({
        connectionString,
        schema,
        physicalClock: () => NOW
      })
      await backend.writeSpace({
        spaceId,
        spaceMetadata: { id: spaceId, type: ['Space'], controller, name: 'One' }
      })
    })

    afterEach(async () => {
      await backend.close()
      const admin = new pg.Client({ connectionString })
      await admin.connect()
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      } finally {
        await admin.end()
      }
    })

    /**
     * A received live Collection Metadata object.
     */
    function peerCollection({
      stamp,
      created = stamp,
      ...members
    }: Partial<CollectionMetadata> & {
      stamp: WriteStamp
      created?: WriteStamp
    }): CollectionMetadata {
      return {
        id: 'notes',
        name: 'notes',
        type: ['Collection'],
        createdAt: created.updatedAt,
        created,
        ...members,
        ...stamp
      } as CollectionMetadata
    }

    async function applyNotes(
      options: { generation?: string; stamp?: WriteStamp } = {}
    ) {
      return backend.applyCollection({
        spaceId,
        replicaId,
        collectionId: 'notes',
        collection: {
          deleted: false,
          generation: options.generation ?? 'genPeerA',
          metadata: peerCollection({ stamp: options.stamp ?? peerStamp(-1000) })
        }
      })
    }

    describe('registrations', () => {
      it('migrates the replicas table', async () => {
        const admin = new pg.Client({ connectionString })
        await admin.connect()
        try {
          const { rows } = await admin.query(
            `SELECT MAX(version) AS version FROM "${schema}".schema_migrations`
          )
          assert.equal(rows[0].version, MIGRATIONS.length)
          await admin.query(`SELECT state FROM "${schema}".replicas`)
        } finally {
          await admin.end()
        }
      })

      it('creates, reads, lists and deletes a registration', async () => {
        const before = (await backend.getSpaceMetadata({ spaceId }))!
        const stored = await backend.createReplica({
          spaceId,
          record: registration
        })
        assert.deepStrictEqual(stored.record, registration)
        assert.equal(stored.spaceGeneration, before.metaGeneration)
        assert.ok(stored.generation.length > 0)

        const afterCreate = (await backend.getSpaceMetadata({ spaceId }))!
        assert.equal(afterCreate.metaLocal, before.metaLocal! + 1)
        assert.equal(afterCreate.updatedAt, before.updatedAt)

        assert.deepStrictEqual(
          await backend.getReplica({ spaceId, replicaId }),
          stored
        )
        assert.deepStrictEqual(await backend.listReplicas({ spaceId }), [
          stored
        ])
        assert.deepStrictEqual(await backend.listAllReplicas(), [
          { ...stored, spaceId }
        ])

        assert.equal(await backend.deleteReplica({ spaceId, replicaId }), true)
        assert.equal(await backend.deleteReplica({ spaceId, replicaId }), false)
        const afterDelete = (await backend.getSpaceMetadata({ spaceId }))!
        assert.equal(afterDelete.metaLocal, before.metaLocal! + 2)
        assert.equal(
          await backend.getReplica({ spaceId, replicaId }),
          undefined
        )
        assert.deepStrictEqual(await backend.listReplicas({ spaceId }), [])
      })

      it('refuses a duplicate id and an absent Space', async () => {
        await backend.createReplica({ spaceId, record: registration })
        await assert.rejects(
          backend.createReplica({ spaceId, record: registration }),
          IdConflictError
        )
        await assert.rejects(
          backend.createReplica({ spaceId: 'nowhere', record: registration }),
          SpaceNotFoundError
        )
        assert.deepStrictEqual(
          await backend.listReplicas({ spaceId: 'nowhere' }),
          []
        )
      })

      it('keeps loop state beside the record and drops both with the Space', async () => {
        assert.equal(
          await backend.writeReplicaState({
            spaceId,
            replicaId,
            state: { collections: {} }
          }),
          false
        )
        await backend.createReplica({ spaceId, record: registration })
        assert.equal(
          await backend.getReplicaState({ spaceId, replicaId }),
          undefined
        )
        const state = {
          lastPullAt: '2026-10-04T12:00:00.000Z',
          collections: {
            notes: { state: 'synced' as const, checkpoint: 'abc' }
          }
        }
        assert.equal(
          await backend.writeReplicaState({ spaceId, replicaId, state }),
          true
        )
        assert.deepStrictEqual(
          await backend.getReplicaState({ spaceId, replicaId }),
          state
        )
        await backend.deleteSpace({ spaceId })
        assert.deepStrictEqual(await backend.listAllReplicas(), [])
        assert.equal(
          await backend.getReplicaState({ spaceId, replicaId }),
          undefined
        )
      })
    })

    describe('apply', () => {
      beforeEach(async () => {
        await backend.createReplica({ spaceId, record: registration })
      })

      it('applies nothing without the registration, or under another Space generation', async () => {
        assert.deepStrictEqual(
          await backend.applySpaceName({
            spaceId,
            replicaId: 'unknown',
            name: 'Peer',
            stamp: peerStamp(1000)
          }),
          { outcome: 'unregistered' }
        )
        // The Space is deleted and created again: the registration is gone,
        // and one made for the old life would not match the new generation.
        await backend.deleteSpace({ spaceId })
        await backend.writeSpace({
          spaceId,
          spaceMetadata: { id: spaceId, type: ['Space'], controller }
        })
        assert.deepStrictEqual(await applyNotes(), { outcome: 'unregistered' })
        assert.equal(
          await backend.getCollectionMetadata({
            spaceId,
            collectionId: 'notes'
          }),
          undefined
        )
      })

      it('refuses a stamp past the clock bound', async () => {
        assert.partialDeepStrictEqual(
          await backend.applySpaceName({
            spaceId,
            replicaId,
            name: 'Future',
            stamp: peerStamp(120_000)
          }),
          { outcome: 'refused', reason: 'clock-bound' }
        )
        assert.equal((await backend.getSpaceMetadata({ spaceId }))!.name, 'One')
      })

      it('applies the Space name under a greater stamp only', async () => {
        const before = (await backend.getSpaceMetadata({ spaceId }))!
        assert.deepStrictEqual(
          await backend.applySpaceName({
            spaceId,
            replicaId,
            name: 'Older',
            stamp: peerStamp(-5000)
          }),
          { outcome: 'skipped' }
        )
        const stamp = peerStamp(1000)
        assert.deepStrictEqual(
          await backend.applySpaceName({
            spaceId,
            replicaId,
            name: 'Peer',
            stamp
          }),
          { outcome: 'applied' }
        )
        const after = (await backend.getSpaceMetadata({ spaceId }))!
        assert.equal(after.name, 'Peer')
        assert.equal(after.controller, controller)
        assert.equal(after.metaGeneration, before.metaGeneration)
        assert.equal(after.metaLocal, 0)
        assert.partialDeepStrictEqual(after, stamp)
        // The same stamp again is a repeat.
        assert.deepStrictEqual(
          await backend.applySpaceName({ spaceId, replicaId, stamp }),
          { outcome: 'skipped' }
        )
        // An absent name removes the stored one.
        await backend.applySpaceName({
          spaceId,
          replicaId,
          stamp: peerStamp(2000)
        })
        assert.equal(
          'name' in (await backend.getSpaceMetadata({ spaceId }))!,
          false
        )
        // A local write still mints above the applied stamp.
        const written = await backend.writeSpace({
          spaceId,
          spaceMetadata: { id: spaceId, type: ['Space'], controller }
        })
        assert.ok(Date.parse(written.validator.stamp.updatedAt) >= NOW + 2000)
      })

      it('creates and updates a Collection under the received validator', async () => {
        const stamp = peerStamp(-1000)
        assert.deepStrictEqual(await applyNotes({ stamp }), {
          outcome: 'applied'
        })
        const stored = (await backend.getCollectionMetadata({
          spaceId,
          collectionId: 'notes'
        }))!
        assert.equal(stored.metaGeneration, 'genPeerA')
        assert.deepStrictEqual(stored.created, stamp)
        assert.partialDeepStrictEqual(stored, stamp)
        assert.deepStrictEqual(await applyNotes({ stamp }), {
          outcome: 'skipped'
        })

        const feed = await backend.changesSince({
          spaceId,
          collectionId: 'notes',
          limit: 10
        })
        assert.deepStrictEqual(
          feed.documents.map(document => document.kind),
          ['collection-metadata']
        )

        const later = peerStamp(-500)
        assert.deepStrictEqual(
          await backend.applyCollection({
            spaceId,
            replicaId,
            collectionId: 'notes',
            collection: {
              deleted: false,
              generation: 'genPeerA',
              metadata: peerCollection({
                stamp: later,
                created: stamp,
                name: 'renamed'
              })
            }
          }),
          { outcome: 'applied' }
        )
        const updated = (await backend.getCollectionMetadata({
          spaceId,
          collectionId: 'notes'
        }))!
        assert.equal(updated.name, 'renamed')
        assert.deepStrictEqual(updated.created, stamp)
      })

      it('records the creating stamp on a local create', async () => {
        const { metadata, validator } = await backend.writeCollection({
          spaceId,
          collectionId: 'local',
          collectionMetadata: {
            id: 'local',
            name: 'local'
          } as CollectionMetadata
        })
        assert.deepStrictEqual(metadata.created, validator.stamp)
        const updated = await backend.writeCollection({
          spaceId,
          collectionId: 'local',
          collectionMetadata: {
            id: 'local',
            name: 'again'
          } as CollectionMetadata
        })
        assert.deepStrictEqual(updated.metadata.created, validator.stamp)
        assert.deepStrictEqual(
          (await backend.getCollectionMetadata({
            spaceId,
            collectionId: 'local'
          }))!.created,
          validator.stamp
        )
      })

      it('stalls an update that forks an immutable member', async () => {
        const stamp = peerStamp(-1000)
        await backend.applyCollection({
          spaceId,
          replicaId,
          collectionId: 'notes',
          collection: {
            deleted: false,
            generation: 'genPeerA',
            metadata: peerCollection({
              stamp,
              revisions: { immutable: true }
            })
          }
        })
        assert.partialDeepStrictEqual(
          await backend.applyCollection({
            spaceId,
            replicaId,
            collectionId: 'notes',
            collection: {
              deleted: false,
              generation: 'genPeerA',
              metadata: peerCollection({
                stamp: peerStamp(-500),
                created: stamp,
                revisions: { immutable: false }
              })
            }
          }),
          { outcome: 'refused', reason: 'fork' }
        )
      })

      it('deletes a Collection on a tombstone and skips its members afterward', async () => {
        await applyNotes({ stamp: peerStamp(-3000) })
        await backend.applyResource({
          spaceId,
          replicaId,
          collectionId: 'notes',
          resourceId: 'doc',
          generation: 'genDoc',
          stamp: peerStamp(-100),
          resource: {
            deleted: false,
            input: { kind: 'json', contentType: 'application/json', data: {} }
          }
        })
        // A tombstone older than the Collection's creating stamp loses.
        assert.deepStrictEqual(
          await backend.applyCollection({
            spaceId,
            replicaId,
            collectionId: 'notes',
            collection: { deleted: true, stamp: peerStamp(-4000) }
          }),
          { outcome: 'skipped' }
        )
        // One after it wins, although the member's stamp is newer still.
        const deletedAt = peerStamp(-2000)
        assert.deepStrictEqual(
          await backend.applyCollection({
            spaceId,
            replicaId,
            collectionId: 'notes',
            collection: { deleted: true, stamp: deletedAt }
          }),
          { outcome: 'applied' }
        )
        assert.equal(
          await backend.getCollectionMetadata({
            spaceId,
            collectionId: 'notes'
          }),
          undefined
        )
        const listing = await backend.listCollections({
          spaceId,
          includeDeleted: true
        })
        assert.partialDeepStrictEqual(listing.items, [
          { id: 'notes', deleted: true, ...deletedAt }
        ])
        assert.equal((await backend.reportUsage({ spaceId })).usageBytes, 0)
        assert.deepStrictEqual(
          await backend.applyResource({
            spaceId,
            replicaId,
            collectionId: 'notes',
            resourceId: 'doc',
            generation: 'genDoc',
            stamp: peerStamp(-50),
            resource: {
              deleted: false,
              input: { kind: 'json', contentType: 'application/json', data: {} }
            }
          }),
          { outcome: 'skipped' }
        )
        // A life created before the tombstone stays deleted; one created
        // after it is created.
        assert.deepStrictEqual(await applyNotes({ stamp: peerStamp(-3000) }), {
          outcome: 'skipped'
        })
        assert.deepStrictEqual(
          await applyNotes({ generation: 'genPeerB', stamp: peerStamp(-1000) }),
          { outcome: 'applied' }
        )
        // A tombstone for an id never held is stored.
        assert.deepStrictEqual(
          await backend.applyCollection({
            spaceId,
            replicaId,
            collectionId: 'never',
            collection: { deleted: true, stamp: peerStamp(-10) }
          }),
          { outcome: 'applied' }
        )
      })

      it('replaces one life of a Collection with a later one', async () => {
        await applyNotes({ generation: 'genPeerA', stamp: peerStamp(-3000) })
        await backend.applyResource({
          spaceId,
          replicaId,
          collectionId: 'notes',
          resourceId: 'doc',
          generation: 'genDoc',
          stamp: peerStamp(-2500),
          resource: {
            deleted: false,
            input: { kind: 'json', contentType: 'application/json', data: {} }
          }
        })
        const before = await backend.changesSince({
          spaceId,
          collectionId: 'notes',
          limit: 10
        })
        // An earlier life loses.
        assert.deepStrictEqual(
          await applyNotes({ generation: 'genOld', stamp: peerStamp(-9000) }),
          { outcome: 'skipped' }
        )
        assert.deepStrictEqual(
          await applyNotes({ generation: 'genPeerB', stamp: peerStamp(-2000) }),
          { outcome: 'applied' }
        )
        const stored = (await backend.getCollectionMetadata({
          spaceId,
          collectionId: 'notes'
        }))!
        assert.equal(stored.metaGeneration, 'genPeerB')
        assert.equal(
          await backend.getResourceMetadata({
            spaceId,
            collectionId: 'notes',
            resourceId: 'doc'
          }),
          undefined
        )
        const after = await backend.changesSince({
          spaceId,
          collectionId: 'notes',
          limit: 10
        })
        assert.notEqual(after.feedGeneration, before.feedGeneration)
        assert.deepStrictEqual(
          after.documents.map(document => document.kind),
          ['collection-metadata']
        )
      })

      describe('Resources', () => {
        const target = { spaceId, replicaId, collectionId: 'notes' }
        const at = { spaceId, collectionId: 'notes', resourceId: 'doc' }

        beforeEach(async () => {
          await applyNotes({ stamp: peerStamp(-9000) })
        })

        function applyDoc({
          stamp,
          data
        }: {
          stamp: WriteStamp
          data: unknown
        }) {
          return backend.applyResource({
            ...target,
            resourceId: 'doc',
            generation: 'genDoc',
            stamp,
            createdAt: '2026-10-01T00:00:00.000Z',
            createdBy: controller,
            writerId: 'writer-a',
            resource: {
              deleted: false,
              epoch: 'epoch-1',
              input: { kind: 'json', contentType: 'application/json', data }
            }
          })
        }

        it('stores the received bytes under the received validator', async () => {
          const stamp = peerStamp(-1000, 3)
          assert.deepStrictEqual(await applyDoc({ stamp, data: { a: 1 } }), {
            outcome: 'applied'
          })
          const read = await backend.getResource(at)
          assert.equal(await streamText(read.resourceStream), '{"a":1}')
          assert.equal(
            formatEtag({ generation: read.generation!, stamp }),
            formatEtag({ generation: 'genDoc', stamp })
          )
          assert.partialDeepStrictEqual(read, stamp)
          assert.partialDeepStrictEqual(await backend.getResourceMetadata(at), {
            createdAt: '2026-10-01T00:00:00.000Z',
            createdBy: controller,
            epoch: 'epoch-1',
            writerId: 'writer-a',
            ...stamp
          })
          assert.equal((await backend.reportUsage({ spaceId })).usageBytes, 7)
          const feed = await backend.changesSince({
            ...at,
            limit: 10
          })
          assert.partialDeepStrictEqual(feed.documents.at(-1), {
            kind: 'resource',
            resourceId: 'doc',
            data: { a: 1 },
            ...stamp
          })
        })

        it('applies a greater stamp and skips an equal or lower one', async () => {
          await applyDoc({ stamp: peerStamp(-1000), data: { a: 1 } })
          assert.deepStrictEqual(
            await applyDoc({ stamp: peerStamp(-1000), data: { a: 2 } }),
            { outcome: 'skipped' }
          )
          assert.deepStrictEqual(
            await applyDoc({ stamp: peerStamp(-2000), data: { a: 2 } }),
            { outcome: 'skipped' }
          )
          assert.deepStrictEqual(
            await applyDoc({ stamp: peerStamp(-1000, 1), data: { a: 3 } }),
            { outcome: 'applied' }
          )
          assert.equal(
            await streamText((await backend.getResource(at)).resourceStream),
            '{"a":3}'
          )
          // A local write over the applied record sorts above it.
          const local = await backend.writeResource({
            ...at,
            input: {
              kind: 'json',
              contentType: 'application/json',
              data: { local: true }
            }
          })
          assert.equal(local.validator.generation, 'genDoc')
          assert.deepStrictEqual(
            await applyDoc({ stamp: peerStamp(-500), data: { a: 4 } }),
            { outcome: 'skipped' }
          )
        })

        it('applies a tombstone, then a later re-create', async () => {
          await applyDoc({ stamp: peerStamp(-1000), data: { a: 1 } })
          await backend.applyResourceMetadata({
            ...target,
            resourceId: 'doc',
            meta: { ...peerStamp(-900), generation: 'genMeta' },
            custom: { name: 'Doc' }
          })
          const deletedAt = peerStamp(-800)
          assert.deepStrictEqual(
            await backend.applyResource({
              ...target,
              resourceId: 'doc',
              generation: 'genDoc',
              stamp: deletedAt,
              writerId: 'writer-b',
              resource: { deleted: true, contentType: 'application/json' }
            }),
            { outcome: 'applied' }
          )
          assert.equal(await backend.getResourceMetadata(at), undefined)
          assert.equal((await backend.reportUsage({ spaceId })).usageBytes, 0)
          const feed = await backend.changesSince({ ...at, limit: 10 })
          assert.partialDeepStrictEqual(feed.documents.at(-1), {
            kind: 'resource',
            resourceId: 'doc',
            deleted: true,
            writerId: 'writer-b',
            createdBy: controller,
            ...deletedAt
          })
          // A `/meta` stamped after the tombstone is skipped while it holds.
          assert.deepStrictEqual(
            await backend.applyResourceMetadata({
              ...target,
              resourceId: 'doc',
              meta: { ...peerStamp(-700), generation: 'genMeta' },
              custom: { name: 'Late' }
            }),
            { outcome: 'skipped' }
          )
          // A write stamped before the delete loses to it.
          assert.deepStrictEqual(
            await applyDoc({ stamp: peerStamp(-850), data: { a: 2 } }),
            { outcome: 'skipped' }
          )
          assert.deepStrictEqual(
            await applyDoc({ stamp: peerStamp(-600), data: { a: 5 } }),
            { outcome: 'applied' }
          )
          const recreated = (await backend.getResourceMetadata(at))!
          assert.equal(recreated.meta, undefined)
          assert.equal(recreated.custom, undefined)
        })

        it('applies a tombstone for a Resource never held', async () => {
          assert.deepStrictEqual(
            await backend.applyResource({
              ...target,
              resourceId: 'gone',
              generation: 'genGone',
              stamp: peerStamp(-800),
              resource: { deleted: true, contentType: 'text/plain' }
            }),
            { outcome: 'applied' }
          )
          const feed = await backend.changesSince({ ...at, limit: 10 })
          assert.partialDeepStrictEqual(feed.documents.at(-1), {
            kind: 'resource',
            resourceId: 'gone',
            deleted: true,
            contentType: 'text/plain'
          })
        })

        it('applies /meta on its own stamp and keeps it across a content apply', async () => {
          await applyDoc({ stamp: peerStamp(-1000), data: { a: 1 } })
          const meta = { ...peerStamp(-900), generation: 'genMeta' }
          assert.deepStrictEqual(
            await backend.applyResourceMetadata({
              ...target,
              resourceId: 'doc',
              meta,
              custom: { name: 'Doc' }
            }),
            { outcome: 'applied' }
          )
          assert.deepStrictEqual(
            await backend.applyResourceMetadata({
              ...target,
              resourceId: 'doc',
              meta: { ...peerStamp(-950), generation: 'genMeta' },
              custom: { name: 'Older' }
            }),
            { outcome: 'skipped' }
          )
          assert.deepStrictEqual(
            await backend.applyResourceMetadata({
              ...target,
              resourceId: 'absent',
              meta
            }),
            { outcome: 'skipped' }
          )
          await applyDoc({ stamp: peerStamp(-500), data: { a: 2 } })
          const stored = (await backend.getResourceMetadata(at))!
          assert.deepStrictEqual(stored.meta, meta)
          assert.deepStrictEqual(stored.custom, { name: 'Doc' })
          assert.partialDeepStrictEqual(stored, peerStamp(-500))
        })

        it('fast-forwards a did.jsonl and refuses a fork', async () => {
          const applyLog = (text: string, stamp: WriteStamp) =>
            backend.applyResource({
              ...target,
              resourceId: 'did.jsonl',
              generation: 'genLog',
              stamp,
              resource: {
                deleted: false,
                input: {
                  kind: 'binary',
                  contentType: 'text/jsonl',
                  stream: Readable.from(Buffer.from(text))
                }
              }
            })
          assert.deepStrictEqual(await applyLog('{"v":1}\n', peerStamp(-900)), {
            outcome: 'applied'
          })
          assert.deepStrictEqual(
            await applyLog('{"v":1}\n{"v":2}\n', peerStamp(-800)),
            { outcome: 'applied' }
          )
          // A prefix is a no-op whatever its stamp.
          assert.deepStrictEqual(await applyLog('{"v":1}\n', peerStamp(-100)), {
            outcome: 'skipped'
          })
          assert.partialDeepStrictEqual(
            await applyLog('{"v":1}\n{"x":2}\n', peerStamp(-50)),
            { outcome: 'refused', reason: 'fork' }
          )
          assert.equal(
            await streamText(
              (
                await backend.getResource({
                  ...at,
                  resourceId: 'did.jsonl'
                })
              ).resourceStream
            ),
            '{"v":1}\n{"v":2}\n'
          )
        })

        it('applies a policy and its tombstone at each level', async () => {
          const policy = { type: 'PublicCanRead' } as never
          for (const level of [
            {},
            { collectionId: 'notes' },
            { collectionId: 'notes', resourceId: 'doc' }
          ]) {
            const stamp = peerStamp(-900)
            assert.deepStrictEqual(
              await backend.applyPolicy({
                spaceId,
                replicaId,
                ...level,
                generation: 'genPolicy',
                stamp,
                policy
              }),
              { outcome: 'applied' }
            )
            const stored = (await backend.getPolicyRecord({
              spaceId,
              ...level
            }))!
            assert.deepStrictEqual(stored.validator, {
              generation: 'genPolicy',
              stamp
            })
            assert.deepStrictEqual(
              await backend.applyPolicy({
                spaceId,
                replicaId,
                ...level,
                generation: 'genPolicy',
                stamp: peerStamp(-950)
              }),
              { outcome: 'skipped' }
            )
            assert.deepStrictEqual(
              await backend.applyPolicy({
                spaceId,
                replicaId,
                ...level,
                generation: 'genPolicy',
                stamp: peerStamp(-800)
              }),
              { outcome: 'applied' }
            )
            assert.equal(
              await backend.getPolicy({ spaceId, ...level }),
              undefined
            )
            assert.equal(
              (await backend.getPolicyRecord({ spaceId, ...level }))!.deleted,
              true
            )
          }
          assert.deepStrictEqual(
            await backend.applyPolicy({
              spaceId,
              replicaId,
              collectionId: 'absent',
              generation: 'genPolicy',
              stamp: peerStamp(-700),
              policy
            }),
            { outcome: 'skipped' }
          )
        })

        it('fast-forwards the governing history log', async () => {
          const applyLog = (body: string, stamp: WriteStamp) =>
            backend.applyCollectionLog({
              ...target,
              body,
              generation: 'genGovLog',
              stamp
            })
          const before = (await backend.getCollectionMetadata(at))!
          const stamp = peerStamp(-900)
          assert.deepStrictEqual(await applyLog('{"state":{}}\n', stamp), {
            outcome: 'applied'
          })
          assert.deepStrictEqual(await backend.getCollectionLog(at), {
            body: '{"state":{}}\n',
            validator: { generation: 'genGovLog', stamp }
          })
          const after = (await backend.getCollectionMetadata(at))!
          assert.equal(after.metaLocal, before.metaLocal! + 1)
          assert.equal(after.updatedAt, before.updatedAt)
          assert.deepStrictEqual(
            await applyLog('{"state":{}}\n', peerStamp(-100)),
            {
              outcome: 'skipped'
            }
          )
          assert.partialDeepStrictEqual(
            await applyLog('{"state":{"x":1}}\n', peerStamp(-100)),
            { outcome: 'refused', reason: 'fork' }
          )
          assert.deepStrictEqual(
            await applyLog(
              '{"state":{}}\n{"state":{"x":1}}\n',
              peerStamp(-100)
            ),
            { outcome: 'applied' }
          )
          const feed = await backend.changesSince({ ...at, limit: 10 })
          assert.equal(feed.documents.at(-1)!.kind, 'log')
        })
      })
    })
  })
}
