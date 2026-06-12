/**
 * Spaces Repository and Space API unit tests (Vitest).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { Space } from '@interop/was-client'

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { zcapClients } from './helpers.js'

describe('Spaces', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    bob: any,
    aliceDelegatedApp: any
  const PORT = 7766

  beforeAll(async () => {
    serverUrl = `http://localhost:${PORT}` // fastify.server.address().port
    ;({ alice, aliceDelegatedApp, bob } = await zcapClients({ serverUrl }))
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    fastify = createApp({
      serverUrl,
      backend: new FileSystemBackend({ dataDir })
    })
    await fastify.listen({ port: PORT })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  describe('Spaces Repository API', () => {
    it('GET /spaces/ should 401 error when no authorization headers', async () => {
      const response = await fetch(new URL('/spaces/', serverUrl))
      assert.equal(response.status, 401)
      assert.match(
        response.headers.get('content-type')!,
        /application\/problem\+json/
      )
    })
    it('POST /spaces/ should 401 error when no authorization headers', async () => {
      const response = await fetch(new URL('/spaces/', serverUrl), {
        method: 'POST'
      })
      assert.equal(response.status, 401)
      assert.match(
        response.headers.get('content-type')!,
        /application\/problem\+json/
      )
    })
  })

  describe('Space API', () => {
    it('[root] create space via POST', async () => {
      const space = await alice.was.createSpace({
        id: alice.space1.id,
        name: "Alice's Space #1 (Home)",
        controller: alice.did
      })
      assert.equal(space.id, alice.space1.id)
      assert.deepStrictEqual(await space.describe(), {
        id: alice.space1.id,
        name: "Alice's Space #1 (Home)",
        type: ['Space'],
        controller: alice.did,
        linkset: `/space/${alice.space1.id}/linkset`
      })
    })

    it('POST /spaces/ with an existing id yields id-conflict (409)', async () => {
      const spaceId = crypto.randomUUID()
      await alice.was.createSpace({
        id: spaceId,
        name: 'Conflict Test Space',
        controller: alice.did
      })

      let expectedError: any
      try {
        await alice.was.request({
          url: new URL('/spaces/', serverUrl).toString(),
          method: 'POST',
          json: { id: spaceId, name: 'Replacement', controller: alice.did }
        })
      } catch (error) {
        expectedError = error
      }
      assert.ok(expectedError, 'expected the duplicate-id POST to be rejected')
      assert.equal(expectedError.response.status, 409)
      assert.equal(
        expectedError.data.type,
        'https://wallet.storage/spec#id-conflict'
      )
      assert.equal(expectedError.data.errors[0].pointer, '#/id')
    })

    it("POST /spaces/ cannot overwrite another controller's Space", async () => {
      const spaceId = crypto.randomUUID()
      await alice.was.createSpace({
        id: spaceId,
        name: "Alice's Space",
        controller: alice.did
      })

      // Bob signs with his own key and supplies his own controller -- before
      // the existence check, Create Space verified against the body's
      // controller, so this request silently replaced Alice's Space
      // (controller included).
      let expectedError: any
      try {
        await bob.was.request({
          url: new URL('/spaces/', serverUrl).toString(),
          method: 'POST',
          json: { id: spaceId, name: 'Hijacked', controller: bob.did }
        })
      } catch (error) {
        expectedError = error
      }
      assert.ok(expectedError, 'expected the takeover POST to be rejected')
      assert.equal(expectedError.response.status, 409)

      // Alice's description (controller included) is untouched.
      const description = await alice.was.space(spaceId).describe()
      assert.equal(description.controller, alice.did)
      assert.equal(description.name, "Alice's Space")
    })

    it('[root] create space by id via PUT', async () => {
      const space = alice.was.space(alice.space2.id)
      // configure() upserts the space by id (PUT).
      await space.configure({
        name: "Alice's Space #2 (School)",
        controller: alice.did
      })
      assert.notEqual(await space.describe(), null)
    })

    it('GET a space with no auth headers falls through to policy and 404s (no public policy)', async () => {
      // Reads no longer 401 at the hook: an anonymous read is allowed to attempt,
      // and is denied as 404 (no-leak) when no access-control policy grants it.
      const spaceUrl = new URL(
        `/space/${alice.space1.id}`,
        serverUrl
      ).toString()
      const response = await fetch(spaceUrl, { method: 'GET' })
      assert.equal(response.status, 404)
      assert.match(
        response.headers.get('content-type')!,
        /application\/problem\+json/
      )
    })

    it('describing a not-found space returns null (404 conflation)', async () => {
      const missing = await alice.was
        .space('space-id-that-does-not-exist')
        .describe()
      assert.equal(missing, null)
    })

    it('[root] read space via GET with proper authorization', async () => {
      const spaceDescription = await alice.was.space(alice.space1.id).describe()
      assert.deepStrictEqual(spaceDescription, {
        id: alice.space1.id,
        name: "Alice's Space #1 (Home)",
        type: ['Space'],
        controller: alice.did,
        linkset: `/space/${alice.space1.id}/linkset`
      })
    })

    it('[delegated] authorized app should GET /space/:spaceId', async () => {
      // First, Alice (re-)provisions the Space -- via the idempotent PUT path,
      // since POSTing an existing id now yields `id-conflict` (409).
      const space = alice.was.space(alice.space1.id)
      await space.configure({
        name: "Alice's Space #1 (Home)",
        controller: alice.did
      })

      // Alice delegates GET access on the space to the app.
      const zcap = await space.grant({
        to: aliceDelegatedApp.did,
        actions: ['GET']
      })

      // Alice's app rebuilds a handle from the capability and reads the space.
      const handle = aliceDelegatedApp.was.fromCapability(zcap)
      assert.ok(handle instanceof Space)
      assert.deepStrictEqual(await handle.describe(), {
        id: alice.space1.id,
        name: "Alice's Space #1 (Home)",
        type: ['Space'],
        controller: alice.did,
        linkset: `/space/${alice.space1.id}/linkset`
      })
    })

    it('[root] Bob should not be able to GET Alice space', async () => {
      // First, Alice (re-)provisions the Space -- via the idempotent PUT path,
      // since POSTing an existing id now yields `id-conflict` (409).
      await alice.was.space(alice.space1.id).configure({
        name: "Alice's Space #1 (Home)",
        controller: alice.did
      })

      // Bob reads with his own client and gets null (404 conflated: not-found
      // vs unauthorized), so the space's existence is not revealed.
      const seenByBob = await bob.was.space(alice.space1.id).describe()
      assert.equal(seenByBob, null)
    })

    it('[root] Alice should be able to DELETE her provisioned space', async () => {
      // First, create the space
      const space = await alice.was.createSpace({
        id: 'a-space-to-delete',
        name: "Alice's Test Space to be deleted",
        controller: alice.did
      })

      // Now delete the space
      await space.delete()

      // Check that the space was deleted (reads return null on 404).
      assert.equal(await space.describe(), null)
    })
  })

  describe('Space Backends (/backends)', () => {
    // The single server-configured filesystem backend, registered as `default`.
    const defaultBackendDescriptor = {
      id: 'default',
      name: 'Server Filesystem',
      managedBy: 'server',
      storageMode: ['document', 'blob'],
      persistence: 'durable'
    }

    it('[signed] GET /backends lists the default backend descriptor', async () => {
      const spaceId = crypto.randomUUID()
      await alice.was.createSpace({
        id: spaceId,
        name: 'Backends Test Space',
        controller: alice.did
      })

      const response = await alice.was.request({
        url: `${serverUrl}/space/${spaceId}/backends`,
        method: 'GET'
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type')!, /application\/json/)
      assert.deepStrictEqual(response.data, [defaultBackendDescriptor])
    })

    it('anonymous GET /backends of a private space 404s (no leak)', async () => {
      const spaceId = crypto.randomUUID()
      await alice.was.createSpace({
        id: spaceId,
        name: 'Private Backends Space',
        controller: alice.did
      })

      const response = await fetch(
        new URL(`/space/${spaceId}/backends`, serverUrl)
      )
      assert.equal(response.status, 404)
    })

    it('anonymous GET /backends of a PublicCanRead space succeeds', async () => {
      const spaceId = crypto.randomUUID()
      const space = await alice.was.createSpace({
        id: spaceId,
        name: 'Public Backends Space',
        controller: alice.did
      })
      await space.setPublic()

      const response = await fetch(
        new URL(`/space/${spaceId}/backends`, serverUrl)
      )
      assert.equal(response.status, 200)
      const backends = (await response.json()) as unknown[]
      assert.deepStrictEqual(backends, [defaultBackendDescriptor])
    })
  })
})
