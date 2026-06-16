/**
 * WAS conformance tests — Collection `changes` query profile (the replication
 * change feed served at `POST /space/:s/:c/query`; spec "Collection-level
 * reserved endpoints").
 * Using Node.js test runner
 * @see https://nodejs.org/api/test.html
 */
import { it, describe, before, after } from 'node:test'
import assert from 'node:assert'

import {
  buildZcapClients,
  createSpace,
  generateId,
  serverUrl
} from './helpers.js'

describe('Collection changes query profile', () => {
  let alice: any
  const collectionId = 'feed'

  /** Absolute URL for this Space's `feed` collection query endpoint. */
  function queryUrl(): string {
    return new URL(
      `/space/${alice.space1.id}/${collectionId}/query`,
      serverUrl
    ).toString()
  }

  before(async () => {
    ;({ alice } = await buildZcapClients())
    alice.space1 = { id: generateId() }
    await createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Space #1",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    await alice.rootClient.request({
      url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
      method: 'POST',
      action: 'POST',
      json: { id: collectionId, name: 'Feed' }
    })
    // Three JSON documents by id; the middle one is then soft-deleted.
    for (const id of ['r1', 'r2', 'r3']) {
      await alice.rootClient.request({
        url: new URL(
          `/space/${alice.space1.id}/${collectionId}/${id}`,
          serverUrl
        ).toString(),
        method: 'PUT',
        action: 'PUT',
        json: { id }
      })
    }
    await alice.rootClient.request({
      url: new URL(
        `/space/${alice.space1.id}/${collectionId}/r2`,
        serverUrl
      ).toString(),
      method: 'DELETE'
    })
  })

  after(async () => {
    try {
      await alice.rootClient.request({
        url: new URL(`/space/${alice.space1.id}`, serverUrl).toString(),
        method: 'DELETE'
      })
    } catch {
      /* best-effort cleanup */
    }
  })

  it('[root] returns live documents and a tombstone, with a checkpoint', async () => {
    const response = await alice.rootClient.request({
      url: queryUrl(),
      method: 'POST',
      action: 'POST',
      json: { profile: 'changes', limit: 100 }
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /application\/json/)

    const byId = new Map(
      response.data.documents.map((doc: any) => [doc.id, doc])
    )
    assert.deepEqual([...byId.keys()].sort(), ['r1', 'r2', 'r3'])

    // Live documents carry their body under `data` and `_deleted: false`.
    assert.equal((byId.get('r1') as any)._deleted, false)
    assert.deepEqual((byId.get('r1') as any).data, { id: 'r1' })

    // The deleted document is a tombstone: `_deleted: true`, no `data`.
    const tombstone = byId.get('r2') as any
    assert.equal(tombstone._deleted, true)
    assert.equal(tombstone.data, undefined)

    // The checkpoint is the last returned document's keyset position.
    assert.ok(response.data.checkpoint)
    assert.equal(typeof response.data.checkpoint.id, 'string')
    assert.equal(typeof response.data.checkpoint.updatedAt, 'string')
  })

  it('[root] rejects an unknown query profile with 501', async () => {
    let thrown: any
    try {
      await alice.rootClient.request({
        url: queryUrl(),
        method: 'POST',
        action: 'POST',
        json: { profile: 'no-such-profile' }
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected an unknown profile to be rejected')
    assert.equal(thrown.response.status, 501)
    assert.match(
      thrown.response.headers.get('content-type'),
      /application\/problem\+json/
    )
  })
})
