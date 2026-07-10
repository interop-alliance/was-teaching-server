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

  it('[root] a text/plain body with multi-byte / astral characters round-trips byte-for-byte', async () => {
    // A `text/plain` body arrives at the server parsed as a string. It must be
    // written as its UTF-8 bytes, not iterated per UTF-16 code unit (which would
    // split astral-plane characters into lone surrogates and corrupt the bytes).
    const text = 'café — 𐐷 — 😀 ✅'
    const result = await aliceCredentials.add(
      new Blob([text], { type: 'text/plain' })
    )

    const fetched = await aliceCredentials.get(result.id)
    assert.ok(fetched instanceof Blob)
    assert.equal(await fetched.text(), text)
    // The stored size is the UTF-8 byte length, not the string length.
    assert.equal(
      (await fetched.arrayBuffer()).byteLength,
      new TextEncoder().encode(text).length
    )
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
    await publicCollection.configure({ name: 'Public Collection', force: true })

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

    it('[signed] GET /meta includes createdBy, the signing DID of the creator', async () => {
      const resourceId = 'meta-created-by'
      await aliceCredentials.put(resourceId, { id: resourceId })

      const { data: meta } = await alice.was.request({
        url: metaUrl(resourceId),
        method: 'GET'
      })
      assert.equal(meta.createdBy, alice.did)
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

    it('[signed] PUT /meta with a custom object does not disturb createdBy', async () => {
      const resourceId = 'meta-created-by-preserved'
      await aliceCredentials.put(resourceId, { id: resourceId })

      const putResponse = await alice.was.request({
        url: metaUrl(resourceId),
        method: 'PUT',
        json: { custom: { name: 'Some Custom Data' } }
      })
      assert.equal(putResponse.status, 204)

      const { data: meta } = await alice.was.request({
        url: metaUrl(resourceId),
        method: 'GET'
      })
      assert.equal(meta.createdBy, alice.did)
      assert.equal(meta.custom.name, 'Some Custom Data')
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

  describe('Conditional Writes (ETag / If-Match)', () => {
    // Build the absolute resource URL for a credentials-collection resource.
    const resourceUrl = (resourceId: string) =>
      `${serverUrl}/space/${alice.space1.id}/credentials/${resourceId}`

    it('surfaces an ETag on write and GET that advances on each write', async () => {
      const resourceId = 'cond-etag-roundtrip'
      const created = await alice.was.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 1 }
      })
      assert.equal(created.status, 204)
      assert.equal(created.headers.get('etag'), '"1"')

      // GET echoes the same validator.
      const got = await alice.was.request({
        url: resourceUrl(resourceId),
        method: 'GET'
      })
      assert.equal(got.headers.get('etag'), '"1"')

      // A second (unconditional) write advances the version.
      const updated = await alice.was.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 2 }
      })
      assert.equal(updated.headers.get('etag'), '"2"')
    })

    it('surfaces the ETag header on a HEAD response', async () => {
      // Use a text/plain resource: the http client auto-JSON-parses a body, and
      // a HEAD carries none, so a JSON content-type would make it choke on the
      // empty body. The ETag header path is identical to GET / `/meta`.
      const resourceId = 'cond-etag-head'
      const created = await alice.was.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        body: new Blob(['hello'], { type: 'text/plain' })
      })
      const etag = created.headers.get('etag')!
      const head = await alice.was.request({
        url: resourceUrl(resourceId),
        method: 'HEAD'
      })
      assert.equal(head.status, 200)
      assert.equal(head.headers.get('etag'), etag)
    })

    it('a matching If-Match succeeds and advances the ETag', async () => {
      const resourceId = 'cond-ifmatch-ok'
      const created = await alice.was.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 1 }
      })
      const etag = created.headers.get('etag')!

      const updated = await alice.was.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 2 },
        headers: { 'if-match': etag }
      })
      assert.equal(updated.status, 204)
      assert.equal(updated.headers.get('etag'), '"2"')
    })

    it('a stale If-Match is rejected with 412 precondition-failed', async () => {
      const resourceId = 'cond-ifmatch-stale'
      await alice.was.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 1 }
      })
      // Advance the version so the original `"1"` is now stale.
      await alice.was.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 2 }
      })

      let thrown: any
      try {
        await alice.was.request({
          url: resourceUrl(resourceId),
          method: 'PUT',
          json: { id: resourceId, n: 3 },
          headers: { 'if-match': '"1"' }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected a stale If-Match to be rejected')
      assert.equal(thrown.response.status, 412)
    })

    it('If-None-Match: * creates when absent and 412s when the target exists', async () => {
      const resourceId = 'cond-ifnonematch'
      const created = await alice.was.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 1 },
        headers: { 'if-none-match': '*' }
      })
      assert.equal(created.status, 204)
      assert.equal(created.headers.get('etag'), '"1"')

      // A second create-if-absent against the now-existing resource fails.
      let thrown: any
      try {
        await alice.was.request({
          url: resourceUrl(resourceId),
          method: 'PUT',
          json: { id: resourceId, n: 2 },
          headers: { 'if-none-match': '*' }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(
        thrown,
        'expected create-if-absent on an existing resource to be rejected'
      )
      assert.equal(thrown.response.status, 412)
    })

    it('serializes concurrent If-Match writers: exactly one wins, the other 412s', async () => {
      const resourceId = 'cond-concurrent'
      const created = await alice.was.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 0 }
      })
      const etag = created.headers.get('etag')!

      // Two writers race with the same prior ETag; the per-resource lock lets
      // only one observe the matching version, so the other gets a 412.
      const results = await Promise.allSettled([
        alice.was.request({
          url: resourceUrl(resourceId),
          method: 'PUT',
          json: { id: resourceId, n: 1 },
          headers: { 'if-match': etag }
        }),
        alice.was.request({
          url: resourceUrl(resourceId),
          method: 'PUT',
          json: { id: resourceId, n: 2 },
          headers: { 'if-match': etag }
        })
      ])
      const fulfilled = results.filter(result => result.status === 'fulfilled')
      const rejected = results.filter(result => result.status === 'rejected')
      assert.equal(fulfilled.length, 1, 'exactly one writer should win')
      assert.equal(rejected.length, 1, 'exactly one writer should be rejected')
      assert.equal(
        (rejected[0] as PromiseRejectedResult).reason.response.status,
        412
      )
    })

    it('checks authorization before the precondition: Bob gets 404, not 412', async () => {
      const resourceId = 'cond-authz-first'
      await alice.was.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 1 }
      })

      // Bob cannot write Alice's resource. Even with a bogus precondition he must
      // get the privacy-merged 404, never a 412 (a 412 would leak existence).
      let thrown: any
      try {
        await bob.was.request({
          url: resourceUrl(resourceId),
          method: 'PUT',
          json: { id: resourceId, n: 2 },
          headers: { 'if-match': '"999"' }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, "expected Bob's conditional write to be rejected")
      assert.equal(thrown.response.status, 404)
    })

    it('DELETE honors If-Match: a stale validator 412s, the matching one succeeds', async () => {
      const resourceId = 'cond-delete'
      const created = await alice.was.request({
        url: resourceUrl(resourceId),
        method: 'PUT',
        json: { id: resourceId, n: 1 }
      })
      const etag = created.headers.get('etag')!

      // A stale If-Match delete is rejected...
      let thrown: any
      try {
        await alice.was.request({
          url: resourceUrl(resourceId),
          method: 'DELETE',
          headers: { 'if-match': '"999"' }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected a stale If-Match delete to be rejected')
      assert.equal(thrown.response.status, 412)

      // ...and the matching one succeeds, removing the resource.
      const deleted = await alice.was.request({
        url: resourceUrl(resourceId),
        method: 'DELETE',
        headers: { 'if-match': etag }
      })
      assert.equal(deleted.status, 204)
      const gone = await aliceCredentials.get(resourceId)
      assert.equal(gone, null)
    })
  })

  describe('Binary / non-JSON content types (raw PUT)', () => {
    it('[signed] PUT a raw application/octet-stream blob round-trips', async () => {
      const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
      await aliceCredentials.put(
        'raw-octet',
        new Blob([bytes], { type: 'application/octet-stream' })
      )
      const got = (await aliceCredentials.get('raw-octet')) as Blob
      assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes)
      const meta = await aliceCredentials.resource('raw-octet').meta()
      assert.equal(meta!.contentType, 'application/octet-stream')
      assert.equal(meta!.size, bytes.length)
    })

    it('[signed] a binary resource under a dotted id preserves its id and content-type', async () => {
      const bytes = new Uint8Array([10, 20, 30])
      await aliceCredentials.put(
        'photo.png',
        new Blob([bytes], { type: 'image/png' })
      )
      const got = (await aliceCredentials.get('photo.png')) as Blob
      assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes)
      const meta = await aliceCredentials.resource('photo.png').meta()
      assert.equal(meta!.contentType, 'image/png')

      // The dotted id and its content-type must survive the on-disk filename
      // round-trip (the keyset is parsed back from the filename).
      const listing = await aliceCredentials.list()
      const entry = listing!.items.find(item => item.id === 'photo.png')
      assert.ok(entry, 'dotted id should appear in the Collection listing')
      assert.equal(entry!.contentType, 'image/png')
    })

    it('[signed] application/jsonl is stored as raw bytes, not parsed as JSON', async () => {
      // A JSON-Lines body is several JSON values, not one -- it must NOT be
      // routed through the JSON path (which would corrupt it).
      const body = '{"a":1}\n{"a":2}\n'
      const collection = await aliceSpace.createCollection({
        id: 'jsonl-public',
        name: 'Public JSONL'
      })
      await collection.put(
        'data.jsonl',
        new Blob([body], { type: 'application/jsonl' })
      )
      const meta = await collection.resource('data.jsonl').meta()
      assert.equal(meta!.contentType, 'application/jsonl')
      assert.equal(meta!.size, Buffer.byteLength(body))

      // Read the raw bytes back via a public read + plain fetch (a signed read
      // through the client would JSON-parse any "json"-bearing content-type).
      await collection.setPublic()
      const response = await fetch(
        new URL(`/space/${alice.space1.id}/jsonl-public/data.jsonl`, serverUrl)
      )
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type')!, /application\/jsonl/)
      assert.equal(await response.text(), body)
    })
  })
})
