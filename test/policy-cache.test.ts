/**
 * Access-control policy cache tests (Vitest): the memoized `resolveEffectivePolicy`
 * reads (`src/lib/policyCache.ts`) must never keep serving a stale grant or a
 * stale "no policy" negative after a write. Each case reads first (to populate
 * the cache with whatever is currently true), writes, then reads again --
 * without waiting for the TTL -- to prove the write invalidated the entry it
 * touched.
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

describe('Access-control policy cache', () => {
  let fastify: FastifyInstance, serverUrl: string, dataDir: string, alice: any

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice } = await zcapClients({ serverUrl }))
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('a policy PUT is visible on the next anonymous read (no TTL wait)', async () => {
    const spaceId = crypto.randomUUID()
    const space = await alice.was.createSpace({
      id: spaceId,
      name: 'Cache Test Space',
      controller: alice.did
    })
    const collection = await space.createCollection({
      id: 'docs',
      name: 'Docs'
    })
    await collection.put('readme', { id: 'readme', name: 'Read Me' })
    const resourceUrl = new URL(`/space/${spaceId}/docs/readme`, serverUrl)

    // A prior anonymous read populates the cache with "no policy" at every
    // level (Space, Collection, Resource).
    const before = await fetch(resourceUrl)
    assert.equal(before.status, 404)

    await collection.setPublic()

    // The next anonymous read must see the write, not the cached negative.
    const after = await fetch(resourceUrl)
    assert.equal(after.status, 200)
  })

  it('a policy DELETE stops granting on the next anonymous read (no TTL wait)', async () => {
    const spaceId = crypto.randomUUID()
    const space = await alice.was.createSpace({
      id: spaceId,
      name: 'Cache Test Space 2',
      controller: alice.did
    })
    const collection = await space.createCollection({
      id: 'docs',
      name: 'Docs'
    })
    await collection.put('readme', { id: 'readme', name: 'Read Me' })
    await collection.setPublic()
    const resourceUrl = new URL(`/space/${spaceId}/docs/readme`, serverUrl)

    // A prior anonymous read populates the cache with the current grant.
    const before = await fetch(resourceUrl)
    assert.equal(before.status, 200)

    await collection.clearPolicy()

    // The next anonymous read must see the removal, not the cached grant.
    const after = await fetch(resourceUrl)
    assert.equal(after.status, 404)
  })

  it('Delete Collection drops its cached policy, so a re-created Collection of the same id starts private', async () => {
    const spaceId = crypto.randomUUID()
    const space = await alice.was.createSpace({
      id: spaceId,
      name: 'Cache Test Space 3',
      controller: alice.did
    })
    let collection = await space.createCollection({
      id: 'docs',
      name: 'Docs'
    })
    await collection.put('readme', { id: 'readme', name: 'Read Me' })
    await collection.setPublic()
    const resourceUrl = new URL(`/space/${spaceId}/docs/readme`, serverUrl)

    // Populate the cache with the grant, then delete the Collection outright.
    const beforeDelete = await fetch(resourceUrl)
    assert.equal(beforeDelete.status, 200)
    await collection.delete()

    // Re-create the Collection under the same id, with no policy this time.
    collection = await space.createCollection({ id: 'docs', name: 'Docs' })
    await collection.put('readme', { id: 'readme', name: 'Read Me' })

    // The stale cached grant from the deleted Collection must not leak
    // forward into the re-created one.
    const afterRecreate = await fetch(resourceUrl)
    assert.equal(afterRecreate.status, 404)
  })

  it("a Resource named like its Collection has its own policy, separate from the Collection's", async () => {
    const spaceId = crypto.randomUUID()
    const space = await alice.was.createSpace({
      id: spaceId,
      name: 'Cache Test Space 5',
      controller: alice.did
    })
    const collection = await space.createCollection({
      id: 'docs',
      name: 'Docs'
    })
    await collection.put('docs', { id: 'docs', name: 'Same name' })
    await collection.put('other', { id: 'other', name: 'Other' })
    const sameNameUrl = new URL(`/space/${spaceId}/docs/docs`, serverUrl)
    const otherUrl = new URL(`/space/${spaceId}/docs/other`, serverUrl)

    // A Resource-level grant on `docs/docs` must not open the Collection.
    await collection.resource('docs').setPublic()
    assert.equal((await fetch(sameNameUrl)).status, 200)
    assert.equal((await fetch(otherUrl)).status, 404)

    // Clearing the Resource's policy must not touch a Collection-level grant.
    await collection.setPublic()
    await collection.resource('docs').clearPolicy()
    assert.equal((await fetch(sameNameUrl)).status, 200)
    assert.equal((await fetch(otherUrl)).status, 200)

    // And clearing the Collection's policy closes both.
    await collection.clearPolicy()
    assert.equal((await fetch(sameNameUrl)).status, 404)
    assert.equal((await fetch(otherUrl)).status, 404)
  })

  it('a Space-level policy write and delete are each visible immediately', async () => {
    const spaceId = crypto.randomUUID()
    const space: Space = await alice.was.createSpace({
      id: spaceId,
      name: 'Cache Test Space 4',
      controller: alice.did
    })
    const collection = await space.createCollection({
      id: 'docs',
      name: 'Docs'
    })
    await collection.put('readme', { id: 'readme', name: 'Read Me' })
    const resourceUrl = new URL(`/space/${spaceId}/docs/readme`, serverUrl)

    // Populate the cache with "no policy" at the Space level.
    const before = await fetch(resourceUrl)
    assert.equal(before.status, 404)

    await space.setPublic()
    const afterSet = await fetch(resourceUrl)
    assert.equal(afterSet.status, 200)

    await space.clearPolicy()
    const afterClear = await fetch(resourceUrl)
    assert.equal(afterClear.status, 404)
  })
})
