/**
 * Collection tombstones over HTTP. Delete Collection leaves a stamped
 * tombstone that reads as absent: Read Collection and a second Delete answer
 * the masked 404, and the Space listing leaves it out unless a capability
 * holder asks for `?include=deleted`. A re-create under the same id starts a
 * new life: a new generation, nothing inherited from the old one.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import type { FastifyInstance } from 'fastify'

import type { Space } from '@interop/was-client'
import { isCollectionTombstoneSummary } from '@interop/storage-core'

import {
  openTempBackend,
  parseEtagSegments,
  startTestServer,
  zcapClients
} from './helpers.js'
import { compareStamps } from '../src/lib/hlc.js'

describe('Collection tombstones (HTTP)', () => {
  let fastify: FastifyInstance, serverUrl: string, alice: any, aliceSpace: Space
  let spaceId: string

  /**
   * Sends a signed request as Alice; a non-2xx answer resolves its response
   * rather than throwing.
   */
  async function aliceRequest({
    url,
    method = 'GET',
    json,
    headers
  }: {
    url: string
    method?: string
    json?: unknown
    headers?: Record<string, string>
  }): Promise<{ status: number; data: any; headers: Headers }> {
    try {
      const response = await alice.was.request({
        url: new URL(url, serverUrl).toString(),
        method,
        ...(json !== undefined && { json }),
        ...(headers !== undefined && { headers })
      })
      return {
        status: response.status,
        data: response.data,
        headers: response.headers
      }
    } catch (err: any) {
      if (!err.response) {
        throw err
      }
      return {
        status: err.response.status,
        data: err.data ?? err.response.data,
        headers: err.response.headers
      }
    }
  }

  /**
   * Creates a Collection holding one Resource and returns its create ETag.
   */
  async function createWithResource(collectionId: string): Promise<string> {
    const created = await aliceRequest({
      url: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, name: collectionId }
    })
    assert.equal(created.status, 201)
    await aliceSpace.collection(collectionId).put('doc', { life: 'old' })
    return created.headers.get('etag')!
  }

  beforeAll(async () => {
    ;({ fastify, serverUrl } = await startTestServer({
      backend: await openTempBackend()
    }))
    ;({ alice } = await zcapClients({ serverUrl }))
    spaceId = alice.space1.id
    aliceSpace = await alice.was.createSpace({
      id: spaceId,
      name: 'Tombstones',
      controller: alice.did
    })
  })
  afterAll(async () => {
    await fastify.close()
  })

  it('a deleted Collection reads as absent; a second DELETE is 404, a never-created one 204', async () => {
    await createWithResource('gone')
    const before = await aliceRequest({ url: `/space/${spaceId}/` })

    const deleted = await aliceRequest({
      url: `/space/${spaceId}/gone/`,
      method: 'DELETE'
    })
    assert.equal(deleted.status, 204)

    const read = await aliceRequest({ url: `/space/${spaceId}/gone/meta` })
    const neverRead = await aliceRequest({
      url: `/space/${spaceId}/never/meta`
    })
    assert.equal(read.status, 404)
    assert.match(read.data?.type, /not-found/)
    assert.deepEqual(read.data, neverRead.data)

    const resource = await aliceRequest({ url: `/space/${spaceId}/gone/doc` })
    assert.equal(resource.status, 404)

    // A second DELETE finds a tombstone: 404, the masked body an absent
    // Collection's read gets. An id with no record at all stays 204.
    const again = await aliceRequest({
      url: `/space/${spaceId}/gone/`,
      method: 'DELETE'
    })
    assert.equal(again.status, 404)
    assert.match(again.data?.type, /not-found/)
    assert.equal(again.data.detail, neverRead.data.detail)
    const neverDeleted = await aliceRequest({
      url: `/space/${spaceId}/never/`,
      method: 'DELETE'
    })
    assert.equal(neverDeleted.status, 204)

    const after = await aliceRequest({ url: `/space/${spaceId}/` })
    assert.equal(after.data.totalItems, before.data.totalItems - 1)
    assert.ok(after.data.items.every((item: any) => item.id !== 'gone'))
  })

  it('?include=deleted lists the tombstone with the stored stamp', async () => {
    const liveEtag = await createWithResource('listed')
    await aliceRequest({ url: `/space/${spaceId}/listed/`, method: 'DELETE' })

    const plain = await aliceRequest({ url: `/space/${spaceId}/` })
    const listing = await aliceRequest({
      url: `/space/${spaceId}/?include=deleted`
    })
    assert.equal(listing.status, 200)
    const item = listing.data.items.find((entry: any) => entry.id === 'listed')
    assert.deepEqual(Object.keys(item).sort(), [
      'deleted',
      'id',
      'originId',
      'updatedAt',
      'updatedAtCounter',
      'url'
    ])
    assert.equal(item.deleted, true)
    assert.equal(item.url, `/space/${spaceId}/listed/`)
    assert.ok(isCollectionTombstoneSummary(item))
    assert.equal(
      listing.data.totalItems,
      plain.data.totalItems +
        listing.data.items.filter((entry: any) => entry.deleted === true).length
    )

    // The stamp is the one the store holds.
    const stored = await fastify.storage.listCollections({
      spaceId,
      includeDeleted: true,
      limit: 1000
    })
    const storedItem = stored.items.find(entry => entry.id === 'listed')
    assert.deepEqual(item, storedItem)

    // And it sorts above the live Collection's last write.
    const live = parseEtagSegments(liveEtag, { container: true })
    assert.ok(compareStamps(item, live.stamp) > 0)

    // An unknown `include` section is ignored.
    const unknown = await aliceRequest({
      url: `/space/${spaceId}/?include=everything`
    })
    assert.deepEqual(unknown.data, plain.data)
  })

  it('pagination carries the flag forward, and the next link verifies', async () => {
    const pagedSpaceId = crypto.randomUUID()
    const space = await alice.was.createSpace({
      id: pagedSpaceId,
      name: 'Paged',
      controller: alice.did
    })
    for (const id of ['p1', 'p2', 'p3']) {
      await space.createCollection({ id, name: id })
    }
    await aliceRequest({ url: `/space/${pagedSpaceId}/p2/`, method: 'DELETE' })

    const seen: Array<[string, boolean]> = []
    let url: string | undefined =
      `/space/${pagedSpaceId}/?include=deleted&limit=1`
    while (url !== undefined) {
      const page = await aliceRequest({ url })
      assert.equal(page.status, 200)
      assert.equal(page.data.totalItems, 3)
      for (const item of page.data.items) {
        seen.push([item.id, item.deleted === true])
      }
      if (page.data.next !== undefined) {
        assert.ok(page.data.next.includes('include=deleted'))
      }
      url = page.data.next
    }
    assert.deepEqual(seen, [
      ['p1', false],
      ['p2', true],
      ['p3', false]
    ])
  })

  it('a listing served by the public-read policy ignores the flag', async () => {
    const publicSpaceId = crypto.randomUUID()
    const space = await alice.was.createSpace({
      id: publicSpaceId,
      name: 'Public',
      controller: alice.did
    })
    await space.createCollection({ id: 'kept', name: 'kept' })
    await space.createCollection({ id: 'dropped', name: 'dropped' })
    await aliceRequest({
      url: `/space/${publicSpaceId}/dropped/`,
      method: 'DELETE'
    })
    await space.setPublic()

    const anonymous = await fetch(
      new URL(`/space/${publicSpaceId}/?include=deleted`, serverUrl)
    )
    assert.equal(anonymous.status, 200)
    const body = (await anonymous.json()) as any
    assert.equal(body.totalItems, 1)
    assert.deepEqual(
      body.items.map((item: any) => item.id),
      ['kept']
    )

    // The controller still sees it.
    const signed = await aliceRequest({
      url: `/space/${publicSpaceId}/?include=deleted`
    })
    assert.equal(signed.data.totalItems, 2)
  })

  it('a re-create over a tombstone starts a new life', async () => {
    const oldEtag = await createWithResource('again')
    const oldMeta = await aliceRequest({ url: `/space/${spaceId}/again/meta` })
    await aliceRequest({ url: `/space/${spaceId}/again/`, method: 'DELETE' })
    const tombstone = (
      await aliceRequest({ url: `/space/${spaceId}/?include=deleted` })
    ).data.items.find((entry: any) => entry.id === 'again')

    // The old life's ETag does not match the tombstone.
    const stale = await aliceRequest({
      url: `/space/${spaceId}/again/meta`,
      method: 'PUT',
      json: { id: 'again', name: 'again' },
      headers: { 'If-Match': oldEtag }
    })
    assert.equal(stale.status, 412)

    // The guarded create succeeds over it.
    const recreated = await aliceRequest({
      url: `/space/${spaceId}/again/meta`,
      method: 'PUT',
      json: { id: 'again', name: 'again' },
      headers: { 'If-None-Match': '*' }
    })
    assert.equal(recreated.status, 201)
    const newEtag = recreated.headers.get('etag')!
    const before = parseEtagSegments(oldEtag, { container: true })
    const after = parseEtagSegments(newEtag, { container: true })
    assert.notEqual(after.generation, before.generation)
    assert.ok(compareStamps(after.stamp, tombstone) > 0)

    const meta = await aliceRequest({ url: `/space/${spaceId}/again/meta` })
    assert.notEqual(meta.data.createdAt, oldMeta.data.createdAt)
    assert.equal(meta.data.createdAt, after.stamp.updatedAt)
    const resource = await aliceRequest({ url: `/space/${spaceId}/again/doc` })
    assert.equal(resource.status, 404)

    // The old ETag still fails If-Match against the new life.
    const staleAgain = await aliceRequest({
      url: `/space/${spaceId}/again/meta`,
      method: 'PUT',
      json: { id: 'again', name: 'again' },
      headers: { 'If-Match': oldEtag }
    })
    assert.equal(staleAgain.status, 412)
  })

  it('Create Collection over a tombstone is no id-conflict', async () => {
    await createWithResource('posted')
    await aliceRequest({ url: `/space/${spaceId}/posted/`, method: 'DELETE' })
    const created = await aliceRequest({
      url: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: 'posted', name: 'posted' }
    })
    assert.equal(created.status, 201)
  })
})
