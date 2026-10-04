/**
 * Access-control policies as versioned records, over HTTP. At each level
 * (Space, Collection, Resource) a policy read serves the write stamp members
 * and a four-segment `ETag`, answers a conditional read 304, and a write or
 * delete takes `If-Match` / `If-None-Match: *`. Delete Policy leaves a
 * tombstone: a plain read answers it 404, the same as no policy, it grants
 * nothing (the policy cache included), and `?include=deleted` reads it. A
 * write over it starts a new generation. A Collection- or Resource-level
 * policy and its tombstone appear in the Collection's `changes` feed.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import type { FastifyInstance } from 'fastify'

import type { Space } from '@interop/was-client'

import {
  assertEtagAdvanced,
  openTempBackend,
  parseEtagSegments,
  startTestServer,
  zcapClients
} from './helpers.js'
import { compareStamps } from '../src/lib/hlc.js'

describe('Access-control policy validators and tombstones (HTTP)', () => {
  let fastify: FastifyInstance, serverUrl: string, alice: any, aliceSpace: Space
  let spaceId: string
  const collectionId = 'docs'
  const resourceId = 'doc'

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
   * An `ETag` naming the same record with a later counter, which no stored
   * record carries.
   */
  function staleEtag(etag: string): string {
    const { generation, stamp } = parseEtagSegments(etag)
    return `"${generation}.${Date.parse(stamp.updatedAt)}.${
      stamp.updatedAtCounter + 1
    }.${stamp.originId}"`
  }

  /**
   * An anonymous read of the Resource, the read a `PublicCanRead` policy at
   * any level grants.
   */
  async function anonymousRead(): Promise<number> {
    const response = await fetch(
      new URL(`/space/${spaceId}/${collectionId}/${resourceId}`, serverUrl)
    )
    await response.body?.cancel()
    return response.status
  }

  beforeAll(async () => {
    ;({ fastify, serverUrl } = await startTestServer({
      backend: await openTempBackend()
    }))
    ;({ alice } = await zcapClients({ serverUrl }))
    spaceId = alice.space1.id
    aliceSpace = await alice.was.createSpace({
      id: spaceId,
      name: 'Policy versioning',
      controller: alice.did
    })
    const collection = await aliceSpace.createCollection({
      id: collectionId,
      name: 'Docs'
    })
    await collection.put(resourceId, { id: resourceId })
  })
  afterAll(async () => {
    await fastify.close()
  })

  const levels = [
    { name: 'Space', path: () => `/space/${spaceId}/policy` },
    {
      name: 'Collection',
      path: () => `/space/${spaceId}/${collectionId}/policy`
    },
    {
      name: 'Resource',
      path: () => `/space/${spaceId}/${collectionId}/${resourceId}/policy`
    }
  ]

  for (const level of levels) {
    describe(`${level.name} policy`, () => {
      it('serves the stamp members and the ETag, and answers a conditional read 304', async () => {
        const created = await aliceRequest({
          url: level.path(),
          method: 'PUT',
          json: {
            type: 'PublicCanRead',
            updatedAt: '2001-01-01T00:00:00.000Z',
            updatedAtCounter: 7,
            originId: 'forged',
            deleted: true,
            _feedPosition: 999
          }
        })
        assert.equal(created.status, 201)
        const etag = created.headers.get('etag')
        const { stamp } = parseEtagSegments(etag)
        assert.equal(
          created.headers.get('location'),
          new URL(level.path(), serverUrl).toString()
        )
        // The body's stamp members, `deleted` and `_feedPosition` are
        // ignored, and no read serves the stored `_feedPosition`.
        assert.deepEqual(created.data, { type: 'PublicCanRead', ...stamp })

        const read = await aliceRequest({ url: level.path() })
        assert.equal(read.status, 200)
        assert.equal(read.headers.get('etag'), etag)
        assert.deepEqual(read.data, created.data)

        const conditional = await aliceRequest({
          url: level.path(),
          headers: { 'if-none-match': etag! }
        })
        assert.equal(conditional.status, 304)
        assert.equal(conditional.headers.get('etag'), etag)
      })

      it('takes If-None-Match: * and If-Match on a write', async () => {
        const { headers } = await aliceRequest({ url: level.path() })
        const etag = headers.get('etag')!

        const guarded = await aliceRequest({
          url: level.path(),
          method: 'PUT',
          json: { type: 'PublicCanRead' },
          headers: { 'if-none-match': '*' }
        })
        assert.equal(guarded.status, 412)
        const stale = await aliceRequest({
          url: level.path(),
          method: 'PUT',
          json: { type: 'PublicCanRead' },
          headers: { 'if-match': staleEtag(etag) }
        })
        assert.equal(stale.status, 412)

        const updated = await aliceRequest({
          url: level.path(),
          method: 'PUT',
          json: { type: 'PublicCanRead' },
          headers: { 'if-match': etag }
        })
        assert.equal(updated.status, 204)
        assertEtagAdvanced({ before: etag, after: updated.headers.get('etag') })
      })

      it('tombstones on delete: no grant, a 404 like no policy, and readable with ?include=deleted', async () => {
        // The grant is in force, and cached by the policy fallback.
        assert.equal(await anonymousRead(), 200)
        const { headers } = await aliceRequest({ url: level.path() })
        const liveEtag = headers.get('etag')!

        const stale = await aliceRequest({
          url: level.path(),
          method: 'DELETE',
          headers: { 'if-match': staleEtag(liveEtag) }
        })
        assert.equal(stale.status, 412)

        const deleted = await aliceRequest({
          url: level.path(),
          method: 'DELETE',
          headers: { 'if-match': liveEtag }
        })
        assert.equal(deleted.status, 204)
        const tombstoneEtag = deleted.headers.get('etag')
        assertEtagAdvanced({ before: liveEtag, after: tombstoneEtag })

        // No grant from the tombstone, through the policy cache too.
        assert.equal(await anonymousRead(), 404)

        // A plain read answers the tombstone exactly as no policy at all.
        const plain = await aliceRequest({ url: level.path() })
        const neverWritten = await aliceRequest({
          url: `/space/${spaceId}/${collectionId}/never-written/policy`
        })
        assert.equal(plain.status, 404)
        assert.equal(neverWritten.status, 404)
        assert.equal(
          JSON.stringify(plain.data),
          JSON.stringify(neverWritten.data)
        )
        assert.equal(
          plain.headers.get('content-type'),
          neverWritten.headers.get('content-type')
        )
        assert.equal(plain.headers.get('etag'), null)

        const tombstone = await aliceRequest({
          url: `${level.path()}?include=deleted`
        })
        assert.equal(tombstone.status, 200)
        assert.equal(tombstone.headers.get('etag'), tombstoneEtag)
        assert.deepEqual(tombstone.data, {
          deleted: true,
          ...parseEtagSegments(tombstoneEtag).stamp
        })
        const conditional = await aliceRequest({
          url: `${level.path()}?include=deleted`,
          headers: { 'if-none-match': tombstoneEtag! }
        })
        assert.equal(conditional.status, 304)

        // A second delete writes nothing, and answers no ETag.
        const again = await aliceRequest({
          url: level.path(),
          method: 'DELETE'
        })
        assert.equal(again.status, 204)
        assert.equal(again.headers.get('etag'), null)
        const unchanged = await aliceRequest({
          url: `${level.path()}?include=deleted`
        })
        assert.equal(unchanged.headers.get('etag'), tombstoneEtag)
      })

      it('re-creates over the tombstone under a new generation', async () => {
        const tombstone = await aliceRequest({
          url: `${level.path()}?include=deleted`
        })
        const tombstoneEtag = parseEtagSegments(tombstone.headers.get('etag'))
        const recreated = await aliceRequest({
          url: level.path(),
          method: 'PUT',
          json: { type: 'PublicCanRead' },
          headers: { 'if-none-match': '*' }
        })
        assert.equal(recreated.status, 201)
        const fresh = parseEtagSegments(recreated.headers.get('etag'))
        assert.notEqual(fresh.generation, tombstoneEtag.generation)
        assert.ok(compareStamps(fresh.stamp, tombstoneEtag.stamp) > 0)
        assert.equal(await anonymousRead(), 200)

        // Leave the level without a live policy for the next one.
        await aliceRequest({ url: level.path(), method: 'DELETE' })
        assert.equal(await anonymousRead(), 404)
      })
    })
  }

  it('drops the policy relation from the Collection linkset once deleted', async () => {
    const policyUrl = `/space/${spaceId}/${collectionId}/policy`
    const linkset = async () =>
      (await aliceRequest({ url: `/space/${spaceId}/${collectionId}/linkset` }))
        .data.linkset[0]
    await aliceRequest({
      url: policyUrl,
      method: 'PUT',
      json: { type: 'PublicCanRead' }
    })
    assert.ok((await linkset())['https://w3id.org/pws#policy'])
    await aliceRequest({ url: policyUrl, method: 'DELETE' })
    assert.equal((await linkset())['https://w3id.org/pws#policy'], undefined)
  })

  it('carries Collection and Resource policies in the changes feed, tombstones included', async () => {
    const response = await aliceRequest({
      url: `/space/${spaceId}/${collectionId}/query`,
      method: 'POST',
      json: { profile: 'changes' }
    })
    assert.equal(response.status, 200)
    const policies = response.data.documents.filter(
      (document: any) => document.kind === 'policy'
    )
    const collectionPolicyUrl = new URL(
      `/space/${spaceId}/${collectionId}/policy`,
      serverUrl
    ).toString()
    const resourcePolicyUrl = new URL(
      `/space/${spaceId}/${collectionId}/${resourceId}/policy`,
      serverUrl
    ).toString()
    assert.deepEqual(
      policies.map((document: any) => document.id).sort(),
      [collectionPolicyUrl, resourcePolicyUrl].sort()
    )
    for (const document of policies) {
      // Both policies were deleted last, so each document is its tombstone,
      // with the validator `?include=deleted` serves.
      assert.equal(document.deleted, true)
      assert.equal('target' in document, false)
      assert.equal('data' in document, false)
      const tombstone = await aliceRequest({
        url: `${document.id}?include=deleted`
      })
      assert.equal(document.etag, tombstone.headers.get('etag'))
      const { generation, stamp } = parseEtagSegments(document.etag)
      assert.equal(document.generation, generation)
      assert.equal(document.updatedAt, stamp.updatedAt)
      assert.equal(document.updatedAtCounter, stamp.updatedAtCounter)
      assert.equal(document.originId, stamp.originId)
      assert.equal(typeof document.checkpoint, 'string')
    }
    // The Space policy is in no Collection's feed.
    assert.ok(
      response.data.documents.every(
        (document: any) =>
          document.id !== `${serverUrl}/space/${spaceId}/policy`
      )
    )
  })
})
