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

  it('[root] PUT and GET an application/edv+json (structured-suffix JSON) resource', async () => {
    // Structured-suffix JSON media types (e.g. `application/edv+json` for
    // EDV-over-WAS encrypted documents) must be accepted as JSON, not rejected
    // with a 415. Send raw bytes with an explicit content type so the server's
    // `application/<suffix>+json` parser is exercised.
    const resourceId = 'edv-doc'
    const envelope = {
      id: resourceId,
      sequence: 0,
      jwe: { ciphertext: 'AAAA' }
    }
    const bytes = new TextEncoder().encode(JSON.stringify(envelope))
    await aliceCredentials.put(resourceId, bytes, {
      contentType: 'application/edv+json'
    })

    const fetched = (await aliceCredentials.get(resourceId)) as any
    assert.equal(fetched.jwe.ciphertext, 'AAAA')

    // The structured-suffix content type is preserved on read.
    const meta = await aliceCredentials.resource(resourceId).meta()
    assert.match(meta!.contentType!, /application\/edv\+json/)
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

  describe('HEAD Resource', () => {
    it('[signed] HEAD a binary resource returns its content-type + content-length, no body', async () => {
      // 'line 1\nline2\n' is exactly 13 bytes.
      const blob = new Blob(['line 1\nline2\n'], { type: 'text/plain' })
      const result = await aliceCredentials.add(blob)

      const response = await alice.was.request({
        url: result.url,
        method: 'HEAD'
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type')!, /text\/plain/)
      assert.equal(response.headers.get('content-length'), '13')
      // HEAD carries no body.
      assert.equal(await response.text(), '')
    })

    it('anonymous HEAD of a private resource 404s (conflation, no leak)', async () => {
      const resourceId = 'head-private'
      await aliceCredentials.put(resourceId, {
        id: resourceId,
        name: 'Private'
      })

      const resourceUrl = `${serverUrl}/space/${alice.space1.id}/credentials/${resourceId}`
      const response = await fetch(new URL(resourceUrl), { method: 'HEAD' })
      assert.equal(response.status, 404)
    })

    it('anonymous HEAD in a PublicCanRead collection returns headers matching a GET', async () => {
      const publicCollection = await aliceSpace.createCollection({
        id: 'head-public',
        name: 'Head Public Collection'
      })
      await publicCollection.put('readme', { id: 'readme', name: 'Read Me' })
      await publicCollection.setPublic()

      const resourceUrl = `${serverUrl}/space/${alice.space1.id}/head-public/readme`

      // The HEAD Content-Length must equal the exact byte length a GET returns,
      // and the Content-Type must equal the GET's (spec "Content Types and
      // Representations": both correspond to the Metadata `size`/`contentType`).
      const getResponse = await fetch(new URL(resourceUrl))
      const getBytes = await getResponse.arrayBuffer()

      const headResponse = await fetch(new URL(resourceUrl), { method: 'HEAD' })
      assert.equal(headResponse.status, 200)
      assert.equal(
        headResponse.headers.get('content-type'),
        getResponse.headers.get('content-type')
      )
      assert.equal(
        headResponse.headers.get('content-length'),
        String(getBytes.byteLength)
      )
      assert.equal(await headResponse.text(), '')
    })
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

    it('[signed] GET /meta carries createdAt + updatedAt timestamps', async () => {
      const resourceId = 'meta-timestamps'
      await aliceCredentials.put(resourceId, { id: resourceId })

      const { data: meta } = await alice.was.request({
        url: metaUrl(resourceId),
        method: 'GET'
      })
      assert.ok(
        !Number.isNaN(Date.parse(meta.createdAt)),
        'createdAt is an RFC3339 date-time'
      )
      assert.ok(
        !Number.isNaN(Date.parse(meta.updatedAt)),
        'updatedAt is an RFC3339 date-time'
      )
      // No user-writable metadata has been set, so `custom` is omitted.
      assert.equal(meta.custom, undefined)
    })

    it('[signed] PUT /meta sets custom, surfaced by GET /meta and the listing', async () => {
      const resourceId = 'meta-writable'
      await aliceCredentials.put(resourceId, { id: resourceId })

      const putResponse = await alice.was.request({
        url: metaUrl(resourceId),
        method: 'PUT',
        json: {
          custom: {
            name: 'Hello World greeting',
            tags: { project: 'demo', status: 'draft' }
          }
        }
      })
      assert.equal(putResponse.status, 204)

      // GET /meta reflects the new custom object (server-managed fields intact).
      const { data: meta } = await alice.was.request({
        url: metaUrl(resourceId),
        method: 'GET'
      })
      assert.equal(meta.contentType, 'application/json')
      assert.equal(meta.custom.name, 'Hello World greeting')
      assert.deepEqual(meta.custom.tags, { project: 'demo', status: 'draft' })

      // The List Collection result now shows the custom.name as the Resource name.
      const { data: listing } = await alice.was.request({
        url: `${serverUrl}/space/${alice.space1.id}/credentials/`,
        method: 'GET'
      })
      const entry = listing.items.find((item: any) => item.id === resourceId)
      assert.equal(entry.name, 'Hello World greeting')
    })

    it('[signed] PUT /meta is a full replacement; an empty body clears custom', async () => {
      const resourceId = 'meta-clear'
      await aliceCredentials.put(resourceId, { id: resourceId })

      await alice.was.request({
        url: metaUrl(resourceId),
        method: 'PUT',
        json: { custom: { name: 'Temporary' } }
      })
      // An empty body object clears all user-writable properties.
      await alice.was.request({
        url: metaUrl(resourceId),
        method: 'PUT',
        json: {}
      })

      const { data: meta } = await alice.was.request({
        url: metaUrl(resourceId),
        method: 'GET'
      })
      assert.equal(meta.custom, undefined)
    })

    it('[signed] PUT /meta ignores server-managed top-level props (roundtrip)', async () => {
      const resourceId = 'meta-roundtrip'
      await aliceCredentials.put(resourceId, { id: resourceId })

      // GET the whole Metadata object, tweak custom, and PUT it back unstripped.
      const { data: meta } = await alice.was.request({
        url: metaUrl(resourceId),
        method: 'GET'
      })
      const putResponse = await alice.was.request({
        url: metaUrl(resourceId),
        method: 'PUT',
        json: {
          ...meta,
          contentType: 'text/totally-bogus',
          size: 999999,
          custom: { name: 'Roundtripped' }
        }
      })
      assert.equal(putResponse.status, 204)

      const { data: after } = await alice.was.request({
        url: metaUrl(resourceId),
        method: 'GET'
      })
      // Server-managed fields are untouched by the roundtrip; custom updated.
      assert.equal(after.contentType, 'application/json')
      assert.notEqual(after.size, 999999)
      assert.equal(after.custom.name, 'Roundtripped')
    })

    it('[signed] PUT /meta of a nonexistent resource 404s (does not create)', async () => {
      let thrown: any
      try {
        await alice.was.request({
          url: metaUrl('does-not-exist'),
          method: 'PUT',
          json: { custom: { name: 'nope' } }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(
        thrown,
        'expected PUT /meta of a missing resource to be rejected'
      )
      assert.equal(thrown.response.status, 404)
    })

    it('[signed] PUT /meta with a non-object custom 400s', async () => {
      const resourceId = 'meta-badbody'
      await aliceCredentials.put(resourceId, { id: resourceId })

      let thrown: any
      try {
        await alice.was.request({
          url: metaUrl(resourceId),
          method: 'PUT',
          json: { custom: 'not-an-object' }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected an invalid custom body to be rejected')
      assert.equal(thrown.response.status, 400)
      assert.match(thrown.data.type, /#invalid-request-body$/)
    })

    it("[signed] Bob's PUT /meta of Alice's resource 404s (conflation)", async () => {
      const resourceId = 'meta-bob-write'
      await aliceCredentials.put(resourceId, { id: resourceId })

      let thrown: any
      try {
        await bob.was.request({
          url: metaUrl(resourceId),
          method: 'PUT',
          json: { custom: { name: 'hijack' } }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, "expected Bob's meta write to be rejected")
      assert.equal(thrown.response.status, 404)
    })
  })
})
