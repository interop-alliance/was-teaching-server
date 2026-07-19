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
import type { Space } from '@interop/was-client'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { startTestServer, zcapClients } from './helpers.js'

describe('Wire-contract smoke (status codes)', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    space: Space
  const spaceId = `smoke-space-${crypto.randomUUID()}`
  const collectionId = 'credentials'

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice } = await zcapClients({ serverUrl }))

    // Provision the Space + Collection the read/write smoke checks operate on.
    space = await alice.was.createSpace({
      id: spaceId,
      name: 'Smoke Space',
      controller: alice.did
    })
    await space.createCollection({
      id: collectionId,
      name: 'Verifiable Credentials'
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
    assert.equal(
      response.headers.get('location'),
      `${serverUrl}/spaces/${freshSpaceId}`
    )
    assert.match(response.headers.get('content-type')!, /application\/json/)
  })

  it('GET /space/:spaceId returns 200 with JSON content-type', async () => {
    const response = await alice.was.request({
      path: `/space/${spaceId}`,
      method: 'GET'
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type')!, /application\/json/)
  })

  it('POST /space/:spaceId/ creates a collection (201 with Location)', async () => {
    const freshCollectionId = `smoke-collection-${crypto.randomUUID()}`
    const response = await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: freshCollectionId, name: 'Smoke Collection' }
    })
    assert.equal(response.status, 201)
    assert.equal(
      response.headers.get('location'),
      `${serverUrl}/space/${spaceId}/${freshCollectionId}`
    )
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
