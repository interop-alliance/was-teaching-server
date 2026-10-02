/**
 * Collection `changes` query-profile tests (Vitest): the replication change feed
 * served at `POST /space/:s/:c/query` (spec "Collection-level reserved
 * endpoints").
 *
 * Signed queries use the raw `was.request` escape hatch: the high-level client
 * does not yet surface the change feed. The query parameters ride the signed
 * JSON body.
 *
 * The same-millisecond cases (a rewrite or a lower-sorting id landing in the
 * checkpoint's millisecond) are the storage contract's, under a frozen
 * clock, since the request layer only wraps the backend's feed position.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { base64urlnopad } from '@scure/base'

import type { Space } from '@interop/was-client'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { startTestServer, zcapClients } from './helpers.js'

describe('Collection changes query profile', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    bob: any,
    aliceSpace: Space

  /**
   * Builds a checkpoint in this server's encoding by hand, for the refusal
   * cases: the client never builds one, it only echoes what it was handed.
   */
  function forgeCheckpoint(value: unknown): string {
    return base64urlnopad.encode(
      new TextEncoder().encode(JSON.stringify(value))
    )
  }

  /** Decodes a checkpoint in this server's encoding. */
  function readCheckpoint(checkpoint: string): unknown {
    return JSON.parse(
      new TextDecoder().decode(base64urlnopad.decode(checkpoint))
    )
  }

  /** The absolute URL of one of Alice's Collections, the checkpoint's scope. */
  function feedUrl(collectionId: string): string {
    return new URL(
      `/space/${alice.space1.id}/${collectionId}/`,
      serverUrl
    ).toString()
  }

  /** POSTs the `changes` query body to a Collection's `/query` with `signer`. */
  async function queryChanges(
    signer: any,
    collectionId: string,
    body: Record<string, unknown>
  ): Promise<any> {
    const url = new URL(
      `/space/${alice.space1.id}/${collectionId}/query`,
      serverUrl
    ).toString()
    return signer.was.request({
      url,
      method: 'POST',
      json: { profile: 'changes', ...body }
    })
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice, bob } = await zcapClients({ serverUrl }))

    aliceSpace = await alice.was.createSpace({
      id: alice.space1.id,
      name: "Alice's Space #1 (Home)",
      controller: alice.did
    })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  /** Creates a Collection and PUTs `{ n: <id> }` at each id, in order. */
  async function seedCollection(collectionId: string, ids: string[]) {
    const collection = await aliceSpace.createCollection({
      id: collectionId,
      name: collectionId
    })
    for (const id of ids) {
      await collection.put(id, { n: id })
    }
    return collection
  }

  it('returns changed documents with id/_deleted/updatedAt/version/data + checkpoint', async () => {
    await seedCollection('feed', ['c', 'a', 'b'])
    const { data } = await queryChanges(alice, 'feed', { limit: 10 })

    // Feed order is write order, not id order.
    assert.deepEqual(
      data.documents.map((doc: any) => doc.id),
      ['c', 'a', 'b']
    )
    for (const doc of data.documents) {
      assert.equal(doc._deleted, false)
      assert.equal(doc.version, 1)
      assert.deepEqual(doc.data, { n: doc.id })
      assert.ok(typeof doc.updatedAt === 'string')
      assert.ok(typeof doc.checkpoint === 'string')
    }
    // The page's checkpoint is its last document's, an opaque string.
    const last = data.documents[data.documents.length - 1]
    assert.equal(typeof data.checkpoint, 'string')
    assert.equal(data.checkpoint, last.checkpoint)
    // This server's encoding: the Collection's absolute URL, its feed
    // counter's generation, and the feed position, base64url-encoded JSON.
    const { generation, ...rest } = readCheckpoint(data.checkpoint) as any
    assert.equal(typeof generation, 'string')
    assert.deepEqual(rest, { feed: feedUrl('feed'), position: 3 })
    // Every checkpoint of one feed carries the same generation.
    for (const doc of data.documents) {
      assert.equal(
        (readCheckpoint(doc.checkpoint) as any).generation,
        generation
      )
    }
  })

  it('surfaces a tombstone as _deleted:true with no data', async () => {
    const collection = await seedCollection('with-delete', ['keep', 'remove'])
    await collection.resource('remove').delete()

    const { data } = await queryChanges(alice, 'with-delete', { limit: 10 })
    const byId = new Map(data.documents.map((doc: any) => [doc.id, doc]))
    assert.equal((byId.get('keep') as any)._deleted, false)
    const tombstone = byId.get('remove') as any
    assert.equal(tombstone._deleted, true)
    assert.equal(tombstone.data, undefined, 'tombstone carries no data')
    assert.equal(tombstone.version, 2, 'delete bumped the version')
  })

  it('carries createdBy on live documents and on tombstones so provenance replicates', async () => {
    const collection = await seedCollection('creator-feed', ['keep', 'remove'])
    await collection.resource('remove').delete()

    const { data } = await queryChanges(alice, 'creator-feed', { limit: 10 })
    const byId = new Map(data.documents.map((doc: any) => [doc.id, doc]))
    assert.equal((byId.get('keep') as any).createdBy, alice.did)
    const tombstone = byId.get('remove') as any
    assert.equal(tombstone._deleted, true)
    assert.equal(tombstone.createdBy, alice.did)
  })

  it('carries metaVersion and custom so a metadata edit replicates', async () => {
    const collection = await seedCollection('meta-feed', ['a'])
    // A metadata-only edit: the resource re-surfaces in the feed carrying its
    // `custom` and `metaVersion`, with `version`/`data` unchanged (Decision 6).
    await collection.resource('a').setMeta({ custom: { name: 'labeled' } })

    const { data } = await queryChanges(alice, 'meta-feed', { limit: 10 })
    const doc = data.documents.find((entry: any) => entry.id === 'a')
    assert.ok(doc, 'expected the edited resource in the feed')
    assert.deepEqual(doc.custom, { name: 'labeled' })
    assert.equal(typeof doc.metaVersion, 'number')
    assert.equal(doc.version, 1, 'content version unchanged by a meta edit')
    assert.deepEqual(doc.data, { n: 'a' })
  })

  it('carries etag/metaEtag matching the ETag headers a GET returns', async () => {
    const collection = await seedCollection('etag-feed', ['a'])
    await collection.resource('a').setMeta({ custom: { name: 'labeled' } })

    const { data } = await queryChanges(alice, 'etag-feed', { limit: 10 })
    const doc = data.documents.find((entry: any) => entry.id === 'a')
    assert.ok(doc, 'expected the resource in the feed')

    const resourceUrl = new URL(
      `/space/${alice.space1.id}/etag-feed/a`,
      serverUrl
    ).toString()
    const getResponse = await alice.was.request({
      url: resourceUrl,
      method: 'GET'
    })
    assert.equal(typeof doc.etag, 'string')
    assert.equal(doc.etag, getResponse.headers.get('etag'))

    const metaResponse = await alice.was.request({
      url: `${resourceUrl}/meta`,
      method: 'GET'
    })
    assert.equal(typeof doc.metaEtag, 'string')
    assert.equal(doc.metaEtag, metaResponse.headers.get('etag'))
  })

  it('carries etag on a tombstone', async () => {
    const collection = await seedCollection('etag-tombstone-feed', ['a'])
    await collection.resource('a').delete()

    const { data } = await queryChanges(alice, 'etag-tombstone-feed', {
      limit: 10
    })
    const tombstone = data.documents.find((entry: any) => entry.id === 'a')
    assert.ok(tombstone, 'expected the tombstone in the feed')
    assert.equal(tombstone._deleted, true)
    assert.equal(typeof tombstone.etag, 'string')
  })

  it('iterates by checkpoint, returning only newer changes', async () => {
    await seedCollection('iter', ['a', 'b', 'c', 'd', 'e'])
    const seen: string[] = []
    let checkpoint: string | undefined

    for (let guard = 0; guard < 10; guard++) {
      const { data } = await queryChanges(alice, 'iter', {
        limit: 2,
        ...(checkpoint && { checkpoint })
      })
      seen.push(...data.documents.map((doc: any) => doc.id))
      if (data.documents.length < 2) {
        // Final short page; the next pull is empty with a null checkpoint.
        const { data: tail } = await queryChanges(alice, 'iter', {
          limit: 2,
          ...(data.checkpoint && { checkpoint: data.checkpoint })
        })
        assert.deepEqual(tail.documents, [])
        assert.equal(tail.checkpoint, null)
        break
      }
      checkpoint = data.checkpoint
    }
    assert.deepEqual(seen.sort(), ['a', 'b', 'c', 'd', 'e'])
  })

  it('rejects a body with no profile with 400 invalid-request-body', async () => {
    await seedCollection('missing-profile', ['a'])
    let thrown: any
    try {
      // `profile: undefined` overrides the helper's default and is dropped by
      // JSON serialization, so the signed body has no `profile` member.
      await queryChanges(alice, 'missing-profile', { profile: undefined })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected a missing profile to be rejected')
    assert.equal(thrown.response.status, 400)
    assert.equal(thrown.data.type, 'https://w3id.org/pws#invalid-request-body')
  })

  it('rejects an unknown profile with 501', async () => {
    await seedCollection('unknown-profile', ['a'])
    let thrown: any
    try {
      await queryChanges(alice, 'unknown-profile', {
        profile: 'something-else'
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected an unknown profile to be rejected')
    assert.equal(thrown.response.status, 501)
  })

  it("resumes from any document's checkpoint, not only the page's", async () => {
    await seedCollection('prefix-resume', ['a', 'b', 'c', 'd'])
    const { data } = await queryChanges(alice, 'prefix-resume', { limit: 10 })
    assert.deepEqual(
      data.documents.map((doc: any) => doc.id),
      ['a', 'b', 'c', 'd']
    )
    // A client that applied only `a` and `b` checkpoints on `b`.
    const { data: rest } = await queryChanges(alice, 'prefix-resume', {
      limit: 10,
      checkpoint: data.documents[1].checkpoint
    })
    assert.deepEqual(
      rest.documents.map((doc: any) => doc.id),
      ['c', 'd']
    )
    assert.equal(rest.checkpoint, data.checkpoint)
  })

  describe('refuses a checkpoint this server did not issue for this Collection', () => {
    /** Asserts the query is refused as `invalid-request-body` at the checkpoint. */
    async function assertRefused(collectionId: string, checkpoint: unknown) {
      let thrown: any
      try {
        await queryChanges(alice, collectionId, { checkpoint })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected the checkpoint to be rejected')
      assert.equal(thrown.response.status, 400)
      assert.equal(
        thrown.data.type,
        'https://w3id.org/pws#invalid-request-body'
      )
      assert.equal(thrown.data.errors?.[0]?.pointer, '#/checkpoint')
    }

    it('the retired { id, updatedAt } object', async () => {
      await seedCollection('retired-checkpoint', ['a'])
      const { data } = await queryChanges(alice, 'retired-checkpoint', {
        limit: 10
      })
      await assertRefused('retired-checkpoint', {
        id: 'a',
        updatedAt: data.documents[0].updatedAt
      })
    })

    it("another Collection's checkpoint", async () => {
      await seedCollection('scope-one', ['a'])
      await seedCollection('scope-two', ['a'])
      const { data } = await queryChanges(alice, 'scope-one', { limit: 10 })
      await assertRefused('scope-two', data.checkpoint)
    })

    it("another server's checkpoint for the same path", async () => {
      await seedCollection('scope-server', ['a'])
      const { data } = await queryChanges(alice, 'scope-server', { limit: 10 })
      const { generation } = readCheckpoint(data.checkpoint) as any
      await assertRefused(
        'scope-server',
        forgeCheckpoint({
          feed: `https://elsewhere.example/space/${alice.space1.id}/scope-server/`,
          generation,
          position: 1
        })
      )
    })

    it('a checkpoint from before the Collection was deleted and re-created', async () => {
      // The re-created Collection has the same URL, and its feed restarts at
      // 1. Reading the old position would skip the new feed up to it.
      const collection = await seedCollection('reborn', ['a', 'b', 'c'])
      const { data: before } = await queryChanges(alice, 'reborn', {
        limit: 10
      })
      await collection.delete()
      await seedCollection('reborn', ['a', 'b'])
      await assertRefused('reborn', before.checkpoint)
      // A checkpoint held from before its first write is refused as well: no
      // position has been handed out under any generation yet.
      await aliceSpace.collection('reborn').delete()
      await aliceSpace.createCollection({ id: 'reborn', name: 'reborn' })
      await assertRefused('reborn', before.checkpoint)
      // The new feed issues checkpoints of its own, which resume it.
      const { data: after } = await queryChanges(alice, 'reborn', { limit: 10 })
      assert.deepEqual(after.documents, [])
      assert.equal(after.checkpoint, null)
    })

    it('strings that do not decode to this shape', async () => {
      await seedCollection('bad-checkpoint', ['a'])
      const feed = feedUrl('bad-checkpoint')
      const { data } = await queryChanges(alice, 'bad-checkpoint', {
        limit: 10
      })
      const { generation } = readCheckpoint(data.checkpoint) as any
      for (const checkpoint of [
        'not base64url!',
        forgeCheckpoint('just a string'),
        forgeCheckpoint({ feed }),
        forgeCheckpoint({ feed, generation }),
        forgeCheckpoint({ feed, position: 1 }),
        forgeCheckpoint({ feed, generation: 'other', position: 1 }),
        forgeCheckpoint({ feed, generation: 1, position: 1 }),
        forgeCheckpoint({ feed, generation, position: -1 }),
        forgeCheckpoint({ feed, generation, position: 1.5 }),
        forgeCheckpoint({ feed, generation, position: '1' }),
        forgeCheckpoint({ feed, generation, position: 1, extra: true }),
        42
      ]) {
        await assertRefused('bad-checkpoint', checkpoint)
      }
    })
  })

  it('returns 404 to a caller not authorized to read the Collection', async () => {
    await seedCollection('private-feed', ['a'])
    let thrown: any
    try {
      await queryChanges(bob, 'private-feed', { limit: 10 })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, "expected Bob's query to be rejected")
    assert.equal(thrown.response.status, 404)
  })
})
