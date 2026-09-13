/**
 * Wire-contract smoke test (Vitest): a thin in-process check that the key
 * operations return the right HTTP status codes and headers. The high-level
 * `WasClient` handles hide status/headers by design, so this uses the
 * `was.request()` escape hatch (raw `HttpResponse`, raw errors) to keep a
 * minimal status-code check in the `pnpm test` gate. Exhaustive wire-contract
 * coverage lives in the `*-api` suites of `@interop/was-conformance-suite`.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { startTestServer, zcapClients } from './helpers.js'

describe('Wire-contract smoke (status codes)', () => {
  let fastify: FastifyInstance, serverUrl: string, dataDir: string, alice: any
  const spaceId = `smoke-space-${crypto.randomUUID()}`
  const collectionId = 'credentials'

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice } = await zcapClients({ serverUrl }))

    // Provision the Space + Collection the read/write smoke checks operate on,
    // over the wire (the high-level handles still speak the pre-v0.5 table).
    await alice.was.request({
      path: '/spaces/',
      method: 'POST',
      json: { id: spaceId, name: 'Smoke Space', controller: alice.did }
    })
    await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, name: 'Verifiable Credentials' }
    })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('POST /spaces/ returns 201 with a Location and JSON content-type', async () => {
    const freshSpaceId = `smoke-space-${crypto.randomUUID()}`
    const response = await alice.was.request({
      path: '/spaces/',
      method: 'POST',
      json: {
        id: freshSpaceId,
        name: 'Fresh Smoke Space',
        controller: alice.did
      }
    })
    assert.equal(response.status, 201)
    // `Location` names the created Space in its canonical container form.
    assert.equal(
      response.headers.get('location'),
      `${serverUrl}/space/${freshSpaceId}/`
    )
    assert.match(response.headers.get('content-type')!, /application\/json/)
    assert.equal(response.data.url, `/space/${freshSpaceId}/`)
  })

  it('GET /space/:spaceId/meta returns the Space Metadata object with an ETag', async () => {
    const response = await alice.was.request({
      path: `/space/${spaceId}/meta`,
      method: 'GET'
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type')!, /application\/json/)
    assert.ok(response.headers.get('etag'))
    assert.equal(response.data.id, spaceId)
    assert.equal(response.data.url, `/space/${spaceId}/`)
    assert.equal(response.data.linkset, `/space/${spaceId}/linkset`)
  })

  it('PUT /space/:spaceId/meta creates a Space by id (201) then updates it (204)', async () => {
    const freshSpaceId = `smoke-space-${crypto.randomUUID()}`
    const created = await alice.was.request({
      path: `/space/${freshSpaceId}/meta`,
      method: 'PUT',
      json: { id: freshSpaceId, name: 'By Id', controller: alice.did }
    })
    assert.equal(created.status, 201)
    assert.equal(
      created.headers.get('location'),
      `${serverUrl}/space/${freshSpaceId}/`
    )
    assert.ok(created.headers.get('etag'))
    const updated = await alice.was.request({
      path: `/space/${freshSpaceId}/meta`,
      method: 'PUT',
      json: { id: freshSpaceId, name: 'Renamed', controller: alice.did }
    })
    assert.equal(updated.status, 204)
    assert.notEqual(updated.headers.get('etag'), created.headers.get('etag'))
  })

  it('GET /space/:spaceId/ lists Collections with container urls', async () => {
    const response = await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'GET'
    })
    assert.equal(response.status, 200)
    assert.equal(response.data.url, `/space/${spaceId}/`)
    const listed = response.data.items.find(
      (item: any) => item.id === collectionId
    )
    assert.equal(listed.url, `/space/${spaceId}/${collectionId}/`)
  })

  it('POST /space/:spaceId/ creates a collection (201 with Location)', async () => {
    const freshCollectionId = `smoke-collection-${crypto.randomUUID()}`
    const response = await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: freshCollectionId, name: 'Smoke Collection' }
    })
    assert.equal(response.status, 201)
    // `Location` names the created Collection in its canonical container form.
    assert.equal(
      response.headers.get('location'),
      `${serverUrl}/space/${spaceId}/${freshCollectionId}/`
    )
    assert.equal(response.data.url, `/space/${spaceId}/${freshCollectionId}/`)
  })

  it('GET /space/:spaceId/:collectionId/meta returns the merged Collection Metadata object', async () => {
    const response = await alice.was.request({
      path: `/space/${spaceId}/${collectionId}/meta`,
      method: 'GET'
    })
    assert.equal(response.status, 200)
    assert.ok(response.headers.get('etag'))
    assert.equal(response.data.id, collectionId)
    assert.equal(response.data.name, 'Verifiable Credentials')
    assert.deepStrictEqual(response.data.type, ['Collection'])
    assert.deepStrictEqual(response.data.backend, { id: 'default' })
    assert.equal(response.data.url, `/space/${spaceId}/${collectionId}/`)
    assert.equal(
      response.data.linkset,
      `/space/${spaceId}/${collectionId}/linkset`
    )
    assert.ok(response.data.createdAt)
    assert.ok(response.data.updatedAt)
    assert.equal(response.data.createdBy, alice.did)
  })

  it('PUT /space/:spaceId/:collectionId/meta creates by id (201), then is a full replacement (204)', async () => {
    const freshCollectionId = `smoke-collection-${crypto.randomUUID()}`
    const metaPath = `/space/${spaceId}/${freshCollectionId}/meta`
    const created = await alice.was.request({
      path: metaPath,
      method: 'PUT',
      json: {
        id: freshCollectionId,
        name: 'By Id',
        generator: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
        custom: { name: 'Shown', tags: { starred: 'yes' } }
      },
      headers: { 'if-none-match': '*' }
    })
    assert.equal(created.status, 201)
    assert.equal(
      created.headers.get('location'),
      `${serverUrl}/space/${spaceId}/${freshCollectionId}/`
    )
    const firstEtag = created.headers.get('etag')
    assert.ok(firstEtag)

    // Full replacement: omitting `generator` and `custom` clears them; the
    // read-only members sent back from a GET are ignored, not rejected.
    const read = await alice.was.request({ path: metaPath, method: 'GET' })
    const updated = await alice.was.request({
      path: metaPath,
      method: 'PUT',
      json: { ...read.data, name: 'Renamed', generator: undefined, custom: {} },
      headers: { 'if-match': firstEtag! }
    })
    assert.equal(updated.status, 204)
    assert.notEqual(updated.headers.get('etag'), firstEtag)
    const after = await alice.was.request({ path: metaPath, method: 'GET' })
    assert.equal(after.data.name, 'Renamed')
    assert.equal(after.data.generator, undefined)
    assert.equal(after.data.custom, undefined)
    assert.equal(after.headers.get('etag'), updated.headers.get('etag'))

    // A stale `If-Match` is a 412.
    let expectedError: any
    try {
      await alice.was.request({
        path: metaPath,
        method: 'PUT',
        json: { id: freshCollectionId, name: 'Stale' },
        headers: { 'if-match': firstEtag! }
      })
    } catch (err) {
      expectedError = err
    }
    assert.equal(expectedError?.response?.status, 412)
  })

  it('DELETE /space/:spaceId/:collectionId/ deletes the Collection (204)', async () => {
    const freshCollectionId = `smoke-collection-${crypto.randomUUID()}`
    await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: freshCollectionId }
    })
    const response = await alice.was.request({
      path: `/space/${spaceId}/${freshCollectionId}/`,
      method: 'DELETE'
    })
    assert.equal(response.status, 204)
  })

  it('POST a resource returns 201 with a Location', async () => {
    const response = await alice.was.request({
      path: `/space/${spaceId}/${collectionId}/`,
      method: 'POST',
      json: { name: 'Smoke Resource' }
    })
    assert.equal(response.status, 201)
    assert.ok(
      response.headers
        .get('location')!
        .startsWith(`${serverUrl}/space/${spaceId}/${collectionId}/`)
    )
  })

  it('PUT a resource by id returns 204, then DELETE returns 204', async () => {
    const resourcePath = `/space/${spaceId}/${collectionId}/smoke-put`
    const putResponse = await alice.was.request({
      path: resourcePath,
      method: 'PUT',
      json: { id: 'smoke-put', name: 'PUT Smoke' }
    })
    assert.equal(putResponse.status, 204)

    const deleteResponse = await alice.was.request({
      path: resourcePath,
      method: 'DELETE'
    })
    assert.equal(deleteResponse.status, 204)
  })

  it('GET a missing resource throws a 404 with problem+json', async () => {
    let expectedError: any
    try {
      await alice.was.request({
        path: `/space/${spaceId}/${collectionId}/does-not-exist`,
        method: 'GET'
      })
    } catch (err) {
      expectedError = err
    }
    assert.ok(
      expectedError,
      'expected the missing-resource read to be rejected'
    )
    assert.equal(expectedError.response.status, 404)
    assert.match(
      expectedError.response.headers.get('content-type'),
      /application\/problem\+json/
    )
  })

  // Client #4 (stored `null` crashes read) / #6 (top-level JSON primitives
  // rejected) are client bugs; these lock the server contract they depend on. A
  // *plaintext* Collection stores and returns a bare top-level JSON value
  // intact. (In an *encrypted* Collection these would be rejected 422, since the
  // stored representation must be a JWE envelope -- see encryption-enforce-api.)
  // Includes the *falsy* values (`null`, `false`, `0`, `""`) that a naive store
  // conflates with "absent" -- these are the regression the server fix guards.
  const primitives: [string, string, unknown][] = [
    ['null', 'null', null],
    ['false', 'false', false],
    ['zero', '0', 0],
    ['empty string', '""', ''],
    ['a string', '"hello"', 'hello'],
    ['a number', '42', 42],
    ['a boolean true', 'true', true]
  ]
  for (const [label, raw, expected] of primitives) {
    it(`round-trips a top-level JSON ${label} in a plaintext Collection`, async () => {
      const resourcePath = `/space/${spaceId}/${collectionId}/primitive-${label.replace(/\s+/g, '-')}`
      const putResponse = await alice.was.request({
        path: resourcePath,
        method: 'PUT',
        body: new TextEncoder().encode(raw),
        headers: { 'content-type': 'application/json' }
      })
      assert.equal(putResponse.status, 204)
      const getResponse = await alice.was.request({
        path: resourcePath,
        method: 'GET'
      })
      assert.equal(getResponse.status, 200)
      assert.deepStrictEqual(getResponse.data, expected)
    })
  }

  // Client #2 (reserved-segment routing): a reserved collection-level segment
  // (`policy`) addresses the dedicated Policy endpoint (static-beats-parametric),
  // never a Resource named `policy`. Confirm the reserved route wins end to end.
  it('reserved `policy` segment routes to the collection Policy endpoint', async () => {
    const policyPath = `/space/${spaceId}/${collectionId}/policy`
    const put = await alice.was.request({
      path: policyPath,
      method: 'PUT',
      json: { type: 'PublicCanRead' }
    })
    assert.equal([200, 201, 204].includes(put.status), true)
    // Read it back: proves the PUT hit the Policy handler (a Resource write would
    // not be retrievable at this path as a policy document).
    const get = await alice.was.request({ path: policyPath, method: 'GET' })
    assert.equal(get.status, 200)
    assert.equal(get.data.type, 'PublicCanRead')
    const del = await alice.was.request({ path: policyPath, method: 'DELETE' })
    assert.equal(del.status, 204)
  })
})
