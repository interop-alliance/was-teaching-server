/**
 * End-to-end request-validation tests (Vitest): path-traversal ids,
 * malformed request bodies, and a missing Content-Type all yield typed 4xx
 * responses (never a bare 500 and never a filesystem escape).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { startTestServer, zcapClients } from './helpers.js'

describe('Request validation API', () => {
  let fastify: FastifyInstance, serverUrl: string, dataDir: string, alice: any

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice } = await zcapClients({ serverUrl }))

    // Provision a Space for the body/traversal tests to operate against.
    await alice.was.createSpace({
      id: alice.space1.id,
      name: "Alice's Space #1 (Home)",
      controller: alice.did
    })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  describe('Path traversal', () => {
    it('rejects a traversal spaceId with a typed 400, no filesystem escape', async () => {
      // `%2e%2e%2f` decodes to `../` in the route param, never splitting the
      // route -- the handler sees a spaceId of `../../pwned`. The Space is
      // written at its `meta` sub-resource, so that is the write the id
      // validation must refuse.
      const traversalUrl = `${serverUrl}/space/%2e%2e%2f%2e%2e%2fpwned/meta`
      let expectedError: any
      try {
        await alice.was.request({
          url: traversalUrl,
          method: 'PUT',
          json: { name: 'pwned', controller: alice.did }
        })
      } catch (error) {
        expectedError = error
      }
      assert.ok(expectedError, 'expected the traversal request to be rejected')
      assert.equal(expectedError.response.status, 400)
      assert.ok(expectedError.data.title, 'expected a problem+json title')
      assert.equal(
        expectedError.data.type,
        'https://wallet.storage/spec#invalid-id',
        'expected a spec-required problem type'
      )

      // Defense in depth: nothing was written outside the spaces/ root.
      const dataEntries = await readdir(dataDir)
      assert.deepStrictEqual(dataEntries, ['spaces'])
      const parentEntries = await readdir(path.dirname(dataDir))
      assert.ok(
        !parentEntries.includes('pwned'),
        'a traversal id must not write outside the data dir'
      )
    })

    it('rejects a traversal collectionId with a typed 400', async () => {
      const url = `${serverUrl}/space/${alice.space1.id}/%2e%2e%2fevil/meta`
      let expectedError: any
      try {
        await alice.was.request({
          url,
          method: 'PUT',
          json: { name: 'evil' }
        })
      } catch (error) {
        expectedError = error
      }
      assert.ok(expectedError)
      assert.equal(expectedError.response.status, 400)
      assert.ok(expectedError.data.title)
    })
  })

  describe('Reserved path segments', () => {
    it('PUT /space/:spaceId/export/meta cannot create a Collection named "export" (409)', async () => {
      // No static PUT route exists at /export/meta (export is POST-only), so
      // the request falls through to the parametric Collection Metadata route
      // -- which must reject the reserved id rather than create the Collection.
      let expectedError: any
      try {
        await alice.was.request({
          url: `${serverUrl}/space/${alice.space1.id}/export/meta`,
          method: 'PUT',
          json: { name: 'export' }
        })
      } catch (error) {
        expectedError = error
      }
      assert.ok(expectedError, 'expected the reserved id to be rejected')
      assert.equal(expectedError.response.status, 409)
      assert.equal(
        expectedError.data.type,
        'https://wallet.storage/spec#reserved-id',
        'expected the spec reserved-id problem type'
      )
    })

    it('PUT at the reserved "quota" segment creates no Resource (405)', async () => {
      // `quota` is reserved at the Collection level (the per-Collection quota
      // report). The URL is that endpoint, not a Resource, and it implements
      // only `GET`, so a `PUT` is refused as a method the endpoint lacks. It
      // used to fall through to Update Resource and answer a reserved-id 409;
      // either way no Resource named `quota` can be written.
      let expectedError: any
      try {
        await alice.was.request({
          url: `${serverUrl}/space/${alice.space1.id}/stuff/quota`,
          method: 'PUT',
          json: { hello: 'world' }
        })
      } catch (error) {
        expectedError = error
      }
      assert.ok(expectedError, 'expected the PUT to be refused')
      assert.equal(expectedError.response.status, 405)
      assert.equal(expectedError.response.headers.get('allow'), 'GET, HEAD')
    })
  })

  describe('Malformed request body', () => {
    it('POST /spaces/ without a name succeeds (name is optional)', async () => {
      // The Space Description `name` property is optional per the spec, so a
      // create request that omits it must succeed.
      const response = await alice.was.request({
        url: new URL('/spaces/', serverUrl).toString(),
        method: 'POST',
        json: { controller: alice.did }
      })
      assert.equal(response.status, 201)
      assert.equal(response.data.name, undefined)
      assert.equal(response.data.controller, alice.did)
    })

    it('POST /spaces/ without a controller yields 400 with a title', async () => {
      let expectedError: any
      try {
        await alice.was.request({
          url: new URL('/spaces/', serverUrl).toString(),
          method: 'POST',
          json: { name: 'No controller' }
        })
      } catch (error) {
        expectedError = error
      }
      assert.ok(expectedError)
      assert.equal(expectedError.response.status, 400)
      assert.ok(expectedError.data.title)
      assert.equal(expectedError.data.errors[0].pointer, '#/controller')
    })

    it('PUT /space/:spaceId/meta without a name succeeds (name is optional)', async () => {
      // The Space Metadata object's `name` property is optional per the spec,
      // so an update request that omits it must succeed.
      const spaceMetaUrl = new URL(
        `/space/${alice.space1.id}/meta`,
        serverUrl
      ).toString()
      const response = await alice.was.request({
        url: spaceMetaUrl,
        method: 'PUT',
        json: { controller: alice.did }
      })
      assert.equal(response.status, 204)
    })
  })
})
