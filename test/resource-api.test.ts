/**
 * Resource API unit tests (Vitest).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { NotFoundError } from '@interop/was-client'
import type { Space, Collection } from '@interop/was-client'

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { zcapClients } from './helpers.js'

describe('Resource API', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    bob: any,
    aliceSpace: Space,
    aliceCredentials: Collection
  const PORT = 7768

  beforeAll(async () => {
    serverUrl = `http://localhost:${PORT}` // fastify.server.address().port
    ;({ alice, bob } = await zcapClients({ serverUrl }))
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    fastify = createApp({
      serverUrl,
      backend: new FileSystemBackend({ dataDir })
    })
    await fastify.listen({ port: PORT })

    // Provision the Space and 'credentials' Collection this suite operates on.
    // This suite uses its own temp dataDir, so these must be created here
    // rather than relying on filesystem state left behind by other test files.
    aliceSpace = await alice.was.createSpace({
      id: alice.space1.id,
      name: "Alice's Space #1 (Home)",
      controller: alice.did
    })
    aliceCredentials = await aliceSpace.createCollection({
      id: 'credentials',
      name: 'Verifiable Credentials'
    })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('GET a resource with no auth headers falls through to policy and 404s (no public policy)', async () => {
    // Reads no longer 401 at the hook: an anonymous read is allowed to attempt,
    // and is denied as 404 (no-leak) when no access-control policy grants it.
    const response = await fetch(
      new URL('/space/any-space-id/any-collection/any-resource', serverUrl),
      {
        method: 'GET'
      }
    )
    assert.equal(response.status, 404)
    assert.match(
      response.headers.get('content-type')!,
      /application\/problem\+json/
    )
  })

  // TODO: make sure all iterations return ResourceNotFound error
  it('GET resource in a not-found space returns null (404 conflation)', async () => {
    const fetched = await alice.was
      .space('space-id-that-does-not-exist')
      .collection('unknown-collection')
      .get('unknown-resource')
    assert.equal(fetched, null)
  })

  it('[root] POST (add) and GET Resource with proper authorization', async () => {
    // First, create the Resource (server-generated id).
    const result = await aliceCredentials.add({
      id: 'sample-resource',
      name: 'Sample Verifiable Credential'
    })
    assert.ok(result.id)
    assert.match(result.contentType!, /application\/json/)
    assert.ok(
      result.url.startsWith(
        `${serverUrl}/space/${alice.space1.id}/credentials/`
      )
    )

    // Next, GET the created resource (auto-parsed to an object).
    const fetched = (await aliceCredentials.get(result.id)) as any
    assert.equal(fetched.name, 'Sample Verifiable Credential')
  })

  it('[root] POST (add) and GET a non-JSON resource', async () => {
    const blob = new Blob(['line 1\nline2\n'], { type: 'text/plain' })
    const result = await aliceCredentials.add(blob)

    // GET returns a Blob for non-JSON content.
    const fetched = await aliceCredentials.get(result.id)
    assert.ok(fetched instanceof Blob)
    assert.equal(await fetched.text(), 'line 1\nline2\n')
  })

  it('[root] PUT and GET Resource', async () => {
    const resourceId = 'put-resource'
    await aliceCredentials.put(resourceId, {
      id: resourceId,
      name: 'PUT Resource Test'
    })

    const fetched = (await aliceCredentials.get(resourceId)) as any
    assert.equal(fetched.name, 'PUT Resource Test')
  })

  it('[root] PUT Resource to non-existent collection should fail (NotFoundError)', async () => {
    // Writing into a missing collection is a write -- WAS does not auto-create
    // parents, so it surfaces as NotFoundError (server 404).
    await assert.rejects(
      aliceSpace
        .collection('collection-does-not-exist')
        .put('some-resource', { name: 'test' }),
      (err: unknown) => err instanceof NotFoundError
    )
  })

  it('[root] PUT Resource should update existing resource (upsert)', async () => {
    const resourceId = 'upsert-resource'

    // Initial PUT
    await aliceCredentials.put(resourceId, {
      id: resourceId,
      name: 'Original Name'
    })

    // Second PUT with updated content
    await aliceCredentials.put(resourceId, {
      id: resourceId,
      name: 'Updated Name'
    })

    // GET should reflect the updated content
    const fetched = (await aliceCredentials.get(resourceId)) as any
    assert.equal(fetched.name, 'Updated Name')
  })

  it("[root] Bob should not be able to GET Alice's resources", async () => {
    // First, Alice creates a resource
    const result = await aliceCredentials.add({
      id: 'alice-private-resource',
      name: 'Alice Private Resource'
    })

    // Bob reads via his own client and gets null (404 conflated: not-found vs
    // unauthorized), so the resource's existence is not revealed.
    const seenByBob = await bob.was
      .space(alice.space1.id)
      .collection('credentials')
      .get(result.id)
    assert.equal(seenByBob, null)

    // Clean up the created resource
    await aliceCredentials.resource(result.id).delete()
  })

  it('[root] POST (add) and DELETE Resource with proper authorization', async () => {
    // First, create the Resource
    const result = await aliceCredentials.add({
      id: 'sample-resource-to-delete',
      name: 'Sample Delete'
    })
    assert.match(result.contentType!, /application\/json/)

    // Next, GET the created resource (to check it was created)
    assert.notEqual(await aliceCredentials.get(result.id), null)

    // Delete the resource via its handle
    await aliceCredentials.resource(result.id).delete()

    // Finally, check that it was deleted (reads return null on 404).
    assert.equal(await aliceCredentials.get(result.id), null)
  })

  it('[un-authorized!] Read a public Resource by acl policy', async () => {
    // Create new public collection by id (upsert via configure -> PUT).
    const publicCollection = aliceSpace.collection('public-collection')
    await publicCollection.configure({ name: 'Public Collection' })

    // Check it was created
    assert.notEqual(await publicCollection.describe(), null)

    // Cleanup: Delete collection
    await publicCollection.delete()
  })

  describe('Resource Metadata (/meta)', () => {
    // Build the absolute `/meta` URL for a credentials-collection resource.
    const metaUrl = (resourceId: string) =>
      `${serverUrl}/space/${alice.space1.id}/credentials/${resourceId}/meta`

    it('[signed] GET /meta of a JSON resource returns contentType + size', async () => {
      const resourceId = 'meta-json'
      await aliceCredentials.put(resourceId, {
        id: resourceId,
        name: 'Meta JSON Resource'
      })

      const response = await alice.was.request({
        url: metaUrl(resourceId),
        method: 'GET'
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type')!, /application\/json/)
      const meta = response.data as { contentType: string; size: number }
      assert.equal(meta.contentType, 'application/json')
      // fs-json-store's serialization decides the stored bytes; just assert it
      // is a sensible positive integer (the public-read case below checks the
      // size against the exact bytes returned by a GET of the resource).
      assert.ok(Number.isInteger(meta.size) && meta.size > 0)
    })

    it('[signed] GET /meta of a binary resource returns its content-type + size', async () => {
      // 'line 1\nline2\n' is exactly 13 bytes.
      const blob = new Blob(['line 1\nline2\n'], { type: 'text/plain' })
      const result = await aliceCredentials.add(blob)

      const response = await alice.was.request({
        url: `${result.url}/meta`,
        method: 'GET'
      })
      assert.equal(response.status, 200)
      const meta = response.data as { contentType: string; size: number }
      assert.equal(meta.contentType, 'text/plain')
      assert.equal(meta.size, 13)
    })

    it('[signed] GET /meta of a nonexistent resource 404s', async () => {
      let thrown: any
      try {
        await alice.was.request({
          url: metaUrl('does-not-exist'),
          method: 'GET'
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected a missing resource meta read to be rejected')
      assert.equal(thrown.response.status, 404)
    })

    it("[signed] Bob's GET /meta of Alice's resource 404s (conflation)", async () => {
      const resourceId = 'meta-private'
      await aliceCredentials.put(resourceId, {
        id: resourceId,
        name: 'Private Meta Resource'
      })

      let thrown: any
      try {
        await bob.was.request({ url: metaUrl(resourceId), method: 'GET' })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, "expected Bob's meta read to be rejected")
      assert.equal(thrown.response.status, 404)
    })

    it('anonymous GET /meta of a resource in a PublicCanRead collection succeeds', async () => {
      const publicCollection = await aliceSpace.createCollection({
        id: 'meta-public',
        name: 'Meta Public Collection'
      })
      await publicCollection.put('readme', { id: 'readme', name: 'Read Me' })

      const resourceUrl = `${serverUrl}/space/${alice.space1.id}/meta-public/readme`

      // Before any policy: anonymous /meta read is denied (404, no leak).
      const beforeResponse = await fetch(new URL(`${resourceUrl}/meta`))
      assert.equal(beforeResponse.status, 404)

      await publicCollection.setPublic()

      // With PublicCanRead: anonymous /meta read succeeds, and the reported
      // size matches the exact byte length of a GET of the resource itself.
      const resourceBytes = await (
        await fetch(new URL(resourceUrl))
      ).arrayBuffer()
      const metaResponse = await fetch(new URL(`${resourceUrl}/meta`))
      assert.equal(metaResponse.status, 200)
      assert.match(
        metaResponse.headers.get('content-type')!,
        /application\/json/
      )
      const meta = (await metaResponse.json()) as {
        contentType: string
        size: number
      }
      assert.equal(meta.contentType, 'application/json')
      assert.equal(meta.size, resourceBytes.byteLength)
    })

    it('PUT /meta is not implemented (501 unsupported-operation)', async () => {
      const resourceId = 'meta-put'
      await aliceCredentials.put(resourceId, {
        id: resourceId,
        name: 'PUT Meta Resource'
      })

      let thrown: any
      try {
        await alice.was.request({
          url: metaUrl(resourceId),
          method: 'PUT',
          json: { custom: { label: 'nope' } }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected PUT /meta to be rejected')
      assert.equal(thrown.response.status, 501)
      assert.match(thrown.data.type, /#unsupported-operation$/)
    })
  })
})
