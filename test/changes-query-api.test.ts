/**
 * Collection `changes` query-profile tests (Vitest): the replication change feed
 * served at `POST /space/:s/:c/query` (spec "Collection-level reserved
 * endpoints").
 *
 * Signed queries use the raw `was.request` escape hatch: the high-level client
 * does not yet surface the change feed. The query parameters ride the signed
 * JSON body.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import type { Space } from '@interop/was-client'

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { zcapClients } from './helpers.js'

describe('Collection changes query profile', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    bob: any,
    aliceSpace: Space
  const PORT = 7796

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
    serverUrl = `http://localhost:${PORT}`
    ;({ alice, bob } = await zcapClients({ serverUrl }))
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    fastify = createApp({
      serverUrl,
      backend: new FileSystemBackend({ dataDir })
    })
    await fastify.listen({ port: PORT })

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
    await seedCollection('feed', ['a', 'b', 'c'])
    const { data } = await queryChanges(alice, 'feed', { limit: 10 })

    assert.deepEqual(data.documents.map((doc: any) => doc.id).sort(), [
      'a',
      'b',
      'c'
    ])
    for (const doc of data.documents) {
      assert.equal(doc._deleted, false)
      assert.equal(doc.version, 1)
      assert.deepEqual(doc.data, { n: doc.id })
      assert.ok(typeof doc.updatedAt === 'string')
    }
    const last = data.documents[data.documents.length - 1]
    assert.deepEqual(data.checkpoint, {
      id: last.id,
      updatedAt: last.updatedAt
    })
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

  it('iterates by checkpoint, returning only newer changes', async () => {
    await seedCollection('iter', ['a', 'b', 'c', 'd', 'e'])
    const seen: string[] = []
    let checkpoint: { id: string; updatedAt: string } | undefined

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

  it('rejects a malformed checkpoint with 400', async () => {
    await seedCollection('bad-checkpoint', ['a'])
    let thrown: any
    try {
      await queryChanges(alice, 'bad-checkpoint', {
        checkpoint: { id: 'a' } // missing updatedAt
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected a malformed checkpoint to be rejected')
    assert.equal(thrown.response.status, 400)
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
