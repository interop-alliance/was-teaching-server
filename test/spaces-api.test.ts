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
        controller: alice.did
      })
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

    it('GET /space/:spaceId should 401 error when no authorization headers', async () => {
      const spaceUrl = new URL(
        `/space/${alice.space1.id}`,
        serverUrl
      ).toString()
      const response = await fetch(spaceUrl, { method: 'GET' })
      assert.equal(response.status, 401)
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
        controller: alice.did
      })
    })

    it('[delegated] authorized app should GET /space/:spaceId', async () => {
      // First, Alice (re-)creates the Space
      const space = await alice.was.createSpace({
        id: alice.space1.id,
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
        controller: alice.did
      })
    })

    it('[root] Bob should not be able to GET Alice space', async () => {
      // First, Alice (re-)creates the Space
      await alice.was.createSpace({
        id: alice.space1.id,
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
})
