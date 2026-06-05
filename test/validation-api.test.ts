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

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { zcapClients } from './helpers.js'

describe('Request validation API', () => {
  let fastify: FastifyInstance, serverUrl: string, dataDir: string, alice: any
  const PORT = 7771

  beforeAll(async () => {
    ;({ alice } = await zcapClients())
    serverUrl = `http://localhost:${PORT}`
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    fastify = createApp({
      serverUrl,
      backend: new FileSystemBackend({ dataDir })
    })
    await fastify.listen({ port: PORT })

    // Provision a Space for the body/traversal tests to operate against.
    await alice.rootClient.request({
      url: new URL(`/space/${alice.space1.id}`, serverUrl).toString(),
      method: 'PUT',
      json: {
        id: alice.space1.id,
        name: "Alice's Space #1 (Home)",
        controller: alice.did
      }
    })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  describe('Path traversal (1a)', () => {
    it('rejects a traversal spaceId with a typed 400, no filesystem escape', async () => {
      // `%2e%2e%2f` decodes to `../` in the route param, never splitting the
      // route -- the handler sees a spaceId of `../../pwned`.
      const traversalUrl = `${serverUrl}/space/%2e%2e%2f%2e%2e%2fpwned`
      let expectedError: any
      try {
        await alice.rootClient.request({
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
      const url = `${serverUrl}/space/${alice.space1.id}/%2e%2e%2fevil`
      let expectedError: any
      try {
        await alice.rootClient.request({
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

  describe('Malformed request body (1c)', () => {
    it('POST /spaces/ without a name yields 400 with a title (not a bare 500)', async () => {
      let expectedError: any
      try {
        await alice.rootClient.request({
          url: new URL('/spaces/', serverUrl).toString(),
          method: 'POST',
          json: { controller: alice.did }
        })
      } catch (error) {
        expectedError = error
      }
      assert.ok(expectedError)
      assert.equal(expectedError.response.status, 400)
      assert.ok(expectedError.data.title)
      assert.match(
        expectedError.response.headers.get('content-type'),
        /application\/problem\+json/
      )
    })

    it('POST /spaces/ without a controller yields 400 with a title', async () => {
      let expectedError: any
      try {
        await alice.rootClient.request({
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
    })

    it('PUT /space/:spaceId without a name yields 400 with a title', async () => {
      const spaceUrl = new URL(
        `/space/${alice.space1.id}`,
        serverUrl
      ).toString()
      let expectedError: any
      try {
        await alice.rootClient.request({
          url: spaceUrl,
          method: 'PUT',
          json: { controller: alice.did }
        })
      } catch (error) {
        expectedError = error
      }
      assert.ok(expectedError)
      assert.equal(expectedError.response.status, 400)
      assert.ok(expectedError.data.title)
    })
  })
})
