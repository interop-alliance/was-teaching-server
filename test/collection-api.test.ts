/**
 * Collections API unit tests (Vitest).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { NotFoundError } from '@interop/was-client'
import type { Space } from '@interop/was-client'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { startTestServer, zcapClients } from './helpers.js'

describe('Collections API', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    bob: any,
    aliceSpace: Space

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice, bob } = await zcapClients({ serverUrl }))

    // Provision the Space this suite operates on. This suite uses its own
    // temp dataDir, so it must create the Space here rather than relying on
    // filesystem state left behind by other test files.
    aliceSpace = await alice.was.createSpace({
      id: alice.space1.id,
      name: "Alice's Space #1 (Home)",
      controller: alice.did
    })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('POST /space/:spaceId/ should 401 error when no authorization headers', async () => {
    const response = await fetch(new URL('/space/any-space-id/', serverUrl), {
      method: 'POST'
    })
    assert.equal(response.status, 401)
    assert.match(
      response.headers.get('content-type')!,
      /application\/problem\+json/
    )
  })

  it('POST /space/:spaceId/ should fail (NotFoundError) on not found space id', async () => {
    // Adding a collection to a missing space is a write -- WAS does not
    // auto-create parents, so it surfaces as NotFoundError (server 404).
    await assert.rejects(
      alice.was
        .space('space-id-that-does-not-exist')
        .createCollection({ name: 'Test Collection' }),
      (err: unknown) => err instanceof NotFoundError
    )
  })

  it('[root] create collection via POST', async () => {
    const collection = await aliceSpace.createCollection({
      id: 'credentials',
      name: 'Verifiable Credentials'
    })
    assert.equal(collection.id, 'credentials')
    assert.deepStrictEqual(await collection.describe(), {
      id: 'credentials',
      name: 'Verifiable Credentials',
      type: ['Collection'],
      backend: { id: 'default' },
      createdBy: alice.did,
      url: `/space/${alice.space1.id}/credentials`,
      linkset: `/space/${alice.space1.id}/credentials/linkset`
    })
  })

  it('POST with an existing collection id yields id-conflict (409)', async () => {
    const collectionId = crypto.randomUUID()
    await aliceSpace.createCollection({
      id: collectionId,
      name: 'Conflict Test Collection'
    })

    let expectedError: any
    try {
      await alice.was.request({
        url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
        method: 'POST',
        json: { id: collectionId, name: 'Replacement' }
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

    // The description is untouched.
    const description = await aliceSpace.collection(collectionId).describe()
    assert.equal(description!.name, 'Conflict Test Collection')
  })

  it('[root] list collection items via GET :collectionId/', async () => {
    const listing = await aliceSpace.collection('credentials').list()
    assert.ok(listing)
    assert.equal(listing.id, 'credentials')
    assert.equal(listing.url, `/space/${alice.space1.id}/credentials`)
    assert.equal(listing.name, 'Verifiable Credentials')
    assert.deepStrictEqual(listing.type, ['Collection'])
    assert.equal(typeof listing.totalItems, 'number')
    assert.ok(Array.isArray(listing.items))
    assert.equal(listing.totalItems, listing.items.length)
  })

  it('[root] space.collections() lists the Space collections with the listing shape', async () => {
    // A fresh Space so the listing holds exactly the one Collection created
    // here, letting the full List Collections shape be asserted exactly (the
    // high-level client path; the raw wire form is pinned by the pagination
    // suite). This is the only place the `space.collections()` listing shape --
    // its `url`, `totalItems`, and per-entry `{ id, url, name, public }` -- is
    // asserted. `public` is `false` here (no `PublicCanRead` policy attached).
    const spaceId = crypto.randomUUID()
    const collectionId = crypto.randomUUID()
    const resourceId = crypto.randomUUID()
    const space = await alice.was.createSpace({
      id: spaceId,
      name: 'List Collections Test Space',
      controller: alice.did
    })
    const collection = await space.createCollection({
      id: collectionId,
      name: 'List Collections Test Collection'
    })
    await collection.put(resourceId, {
      id: resourceId,
      name: 'List Collections Test Resource'
    })

    assert.deepStrictEqual(await space.collections(), {
      url: `/space/${spaceId}/collections/`,
      totalItems: 1,
      items: [
        {
          id: collectionId,
          url: `/space/${spaceId}/${collectionId}`,
          name: 'List Collections Test Collection',
          public: false
        }
      ]
    })
  })

  it('[root] get collection description via GET :collectionId', async () => {
    assert.deepStrictEqual(
      await aliceSpace.collection('credentials').describe(),
      {
        id: 'credentials',
        name: 'Verifiable Credentials',
        type: ['Collection'],
        backend: { id: 'default' },
        createdBy: alice.did,
        url: `/space/${alice.space1.id}/credentials`,
        linkset: `/space/${alice.space1.id}/credentials/linkset`
      }
    )
  })

  it('[root] a PUT whose body carries a forged createdBy does not change the stored value', async () => {
    const collectionId = crypto.randomUUID()
    await aliceSpace.createCollection({
      id: collectionId,
      name: 'Forged createdBy Collection'
    })

    await alice.was.request({
      url: new URL(
        `/space/${alice.space1.id}/${collectionId}`,
        serverUrl
      ).toString(),
      method: 'PUT',
      json: { name: 'Renamed', createdBy: 'did:key:zEVIL' }
    })

    const description = await aliceSpace.collection(collectionId).describe()
    assert.equal(description?.createdBy, alice.did)
    assert.equal(description?.name, 'Renamed')
  })

  it('[root] create and delete a collection by id', async () => {
    const collection = aliceSpace.collection('new-collection')

    // Create new collection by id (upsert via configure -> PUT).
    await collection.configure({ name: 'New Collection', force: true })

    // Check it was created
    assert.notEqual(await collection.describe(), null)

    // Now delete collection
    await collection.delete()

    // Ensure it was deleted (reads return null on 404).
    assert.equal(await collection.describe(), null)

    // Delete is idempotent: deleting an already-gone Collection resolves (204),
    // it does not 500 with an underlying ENOENT.
    await collection.delete()
    assert.equal(await collection.describe(), null)
  })

  it('[root] DELETE a never-created collection is idempotent (204, not 500)', async () => {
    const collection = aliceSpace.collection('never-existed-collection')
    await collection.delete()
    assert.equal(await collection.describe(), null)
  })

  it('PUT whose body id does not match the URL collection id yields invalid-request-body (400)', async () => {
    const collectionId = crypto.randomUUID()
    let expectedError: any
    try {
      await alice.was.request({
        url: new URL(
          `/space/${alice.space1.id}/${collectionId}`,
          serverUrl
        ).toString(),
        method: 'PUT',
        json: { id: crypto.randomUUID(), name: 'Mismatch' }
      })
    } catch (error) {
      expectedError = error
    }
    assert.ok(expectedError, 'expected the id-mismatch PUT to be rejected')
    assert.equal(expectedError.response.status, 400)
    assert.equal(
      expectedError.data.type,
      'https://wallet.storage/spec#invalid-request-body'
    )
    assert.equal(expectedError.data.errors[0].pointer, '#/id')

    // The Collection was not created.
    assert.equal(await aliceSpace.collection(collectionId).describe(), null)
  })

  describe('Collection backend selection', () => {
    it('POST with backend { id: "default" } persists and echoes it', async () => {
      const collectionId = crypto.randomUUID()
      const response = await alice.was.request({
        url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
        method: 'POST',
        json: {
          id: collectionId,
          name: 'Explicit Backend',
          backend: { id: 'default' }
        }
      })
      assert.equal(response.status, 201)
      assert.deepStrictEqual(response.data.backend, { id: 'default' })

      // And it is reflected in the Collection description.
      const description = await aliceSpace.collection(collectionId).describe()
      assert.deepStrictEqual(description!.backend, { id: 'default' })
    })

    it('POST with an unknown backend id yields unsupported-backend (409)', async () => {
      let expectedError: any
      try {
        await alice.was.request({
          url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
          method: 'POST',
          json: {
            id: crypto.randomUUID(),
            name: 'Bad Backend',
            backend: { id: 'no-such-backend' }
          }
        })
      } catch (error) {
        expectedError = error
      }
      assert.ok(
        expectedError,
        'expected the unknown-backend POST to be rejected'
      )
      assert.equal(expectedError.response.status, 409)
      assert.equal(
        expectedError.data.type,
        'https://wallet.storage/spec#unsupported-backend'
      )
      assert.equal(expectedError.data.errors[0].pointer, '#/backend')
    })

    it('POST with a malformed backend yields invalid-request-body (400)', async () => {
      let expectedError: any
      try {
        await alice.was.request({
          url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
          method: 'POST',
          json: {
            id: crypto.randomUUID(),
            name: 'Malformed Backend',
            backend: 'default'
          }
        })
      } catch (error) {
        expectedError = error
      }
      assert.ok(
        expectedError,
        'expected the malformed-backend POST to be rejected'
      )
      assert.equal(expectedError.response.status, 400)
      assert.equal(
        expectedError.data.type,
        'https://wallet.storage/spec#invalid-request-body'
      )
      assert.equal(expectedError.data.errors[0].pointer, '#/backend')
    })

    it('GET :collectionId/backend returns the full backend descriptor', async () => {
      const response = await alice.was.request({
        url: new URL(
          `/space/${alice.space1.id}/credentials/backend`,
          serverUrl
        ).toString(),
        method: 'GET'
      })
      assert.equal(response.status, 200)
      assert.deepStrictEqual(response.data, {
        id: 'default',
        name: 'Server Filesystem',
        managedBy: 'server',
        storageMode: ['document', 'blob'],
        persistence: 'durable',
        features: [
          'conditional-writes',
          'changes-query',
          'blinded-index-query',
          'equality-query',
          'key-epochs',
          'chunked-streams'
        ]
      })
    })

    it('GET :collectionId/backend surfaces the conditional-writes features array', async () => {
      const response = await alice.was.request({
        url: new URL(
          `/space/${alice.space1.id}/credentials/backend`,
          serverUrl
        ).toString(),
        method: 'GET'
      })
      assert.equal(response.status, 200)
      // The filesystem backend implements the conditional-writes affordance
      // (ETag / If-Match optimistic concurrency), the `changes-query`
      // replication change feed, the `blinded-index-query` EDV query profile,
      // the `equality-query` plaintext equality profile, and the `key-epochs`
      // multi-recipient-encryption affordance; it advertises every token.
      assert.ok(Array.isArray(response.data.features))
      assert.deepStrictEqual(response.data.features, [
        'conditional-writes',
        'changes-query',
        'blinded-index-query',
        'equality-query',
        'key-epochs',
        'chunked-streams'
      ])
    })

    it('GET :collectionId/backend on a missing collection yields 404', async () => {
      let expectedError: any
      try {
        await alice.was.request({
          url: new URL(
            `/space/${alice.space1.id}/no-such-collection/backend`,
            serverUrl
          ).toString(),
          method: 'GET'
        })
      } catch (error) {
        expectedError = error
      }
      assert.ok(expectedError, 'expected a 404 for the missing collection')
      assert.equal(expectedError.response.status, 404)
    })

    it('PUT create-by-id default-fills the backend', async () => {
      const collection = aliceSpace.collection(crypto.randomUUID())
      await collection.configure({ name: 'PUT Default Backend', force: true })
      const description = await collection.describe()
      assert.deepStrictEqual(description!.backend, { id: 'default' })
    })

    it('Collection linkset advertises the backend and quota relations', async () => {
      const response = await alice.was.request({
        url: new URL(
          `/space/${alice.space1.id}/credentials/linkset`,
          serverUrl
        ).toString(),
        method: 'GET'
      })
      assert.equal(response.status, 200)
      const [entry] = response.data.linkset
      assert.deepStrictEqual(entry['https://wallet.storage/spec#backend'], [
        {
          href: `/space/${alice.space1.id}/credentials/backend`,
          type: 'application/json'
        }
      ])
      assert.deepStrictEqual(entry['https://wallet.storage/spec#quota'], [
        {
          href: `/space/${alice.space1.id}/credentials/quota`,
          type: 'application/json'
        }
      ])
    })
  })

  describe('Collection Metadata (/meta)', () => {
    // Build the absolute Collection `/meta` URL.
    const metaUrl = (collectionId: string) =>
      `${serverUrl}/space/${alice.space1.id}/${collectionId}/meta`

    /** Creates a fresh Collection with a random id and returns that id. */
    async function freshCollection(): Promise<string> {
      const collectionId = crypto.randomUUID()
      await aliceSpace.createCollection({
        id: collectionId,
        name: 'Meta Collection'
      })
      return collectionId
    }

    it('[signed] GET /meta of a collection with no metadata yet 200s without an ETag', async () => {
      const collectionId = await freshCollection()
      const response = await alice.was.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type')!, /application\/json/)
      // No metadata has been written, so there is no `metaVersion` validator...
      assert.equal(response.headers.get('etag'), null)
      // ...but the server-managed creator (recorded on the description) shows.
      assert.equal(response.data.createdBy, alice.did)
      assert.equal(response.data.custom, undefined)
      assert.equal(response.data.metaVersion, undefined)
    })

    it('[signed] GET /meta of a nonexistent collection 404s', async () => {
      let thrown: any
      try {
        await alice.was.request({
          url: metaUrl('collection-that-does-not-exist'),
          method: 'GET'
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(
        thrown,
        'expected a missing collection meta read to be rejected'
      )
      assert.equal(thrown.response.status, 404)
    })

    it("[signed] Bob's GET /meta of Alice's collection 404s (conflation)", async () => {
      const collectionId = await freshCollection()
      let thrown: any
      try {
        await bob.was.request({ url: metaUrl(collectionId), method: 'GET' })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, "expected Bob's collection meta read to be rejected")
      assert.equal(thrown.response.status, 404)
    })

    it('anonymous GET /meta of a PublicCanRead collection succeeds', async () => {
      const collectionId = await freshCollection()
      const collection = aliceSpace.collection(collectionId)

      // Before any policy: an anonymous /meta read is denied (404, no leak).
      const before = await fetch(new URL(metaUrl(collectionId)))
      assert.equal(before.status, 404)

      await collection.setPublic()

      const after = await fetch(new URL(metaUrl(collectionId)))
      assert.equal(after.status, 200)
      const meta = (await after.json()) as { createdBy?: string }
      assert.equal(meta.createdBy, alice.did)
    })

    it('[signed] PUT /meta sets custom, round-tripped by GET with ETag "1"', async () => {
      const collectionId = await freshCollection()
      const put = await alice.was.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: {
          custom: { name: 'Trip Photos', tags: { app: 'gallery' } }
        }
      })
      assert.equal(put.status, 204)
      assert.equal(put.headers.get('etag'), '"1"')

      const got = await alice.was.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(got.status, 200)
      assert.equal(got.headers.get('etag'), '"1"')
      assert.equal(got.data.custom.name, 'Trip Photos')
      assert.deepEqual(got.data.custom.tags, { app: 'gallery' })
      assert.equal(got.data.createdBy, alice.did)
      assert.ok(!Number.isNaN(Date.parse(got.data.createdAt)))
      assert.ok(!Number.isNaN(Date.parse(got.data.updatedAt)))
    })

    it('[signed] PUT /meta is a full replacement; an empty body clears custom', async () => {
      const collectionId = await freshCollection()
      await alice.was.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: { custom: { name: 'Temporary', tags: { a: 'b' } } }
      })
      // A body with no `custom` clears every user-writable property.
      const cleared = await alice.was.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: {}
      })
      assert.equal(cleared.headers.get('etag'), '"2"')

      const got = await alice.was.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(got.data.custom, undefined)
    })

    it('[signed] PUT /meta ignores server-managed top-level props (roundtrip)', async () => {
      const collectionId = await freshCollection()
      await alice.was.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: { custom: { name: 'Before' } }
      })
      // GET the whole Metadata object, tweak custom, and PUT it back unstripped.
      const { data: meta } = await alice.was.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      const put = await alice.was.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: {
          ...meta,
          createdBy: 'did:key:zSomeoneElse',
          createdAt: '1999-01-01T00:00:00.000Z',
          custom: { name: 'After' }
        }
      })
      assert.equal(put.status, 204)

      const { data: after } = await alice.was.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(after.createdBy, alice.did)
      assert.notEqual(after.createdAt, '1999-01-01T00:00:00.000Z')
      assert.equal(after.custom.name, 'After')
    })

    it('[signed] PUT /meta of a nonexistent collection 404s (does not create)', async () => {
      let thrown: any
      try {
        await alice.was.request({
          url: metaUrl('collection-that-does-not-exist'),
          method: 'PUT',
          json: { custom: { name: 'nope' } }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected PUT /meta of a missing collection to reject')
      assert.equal(thrown.response.status, 404)
    })

    it('[signed] PUT /meta with a non-object custom 400s', async () => {
      const collectionId = await freshCollection()
      let thrown: any
      try {
        await alice.was.request({
          url: metaUrl(collectionId),
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

    it("[signed] Bob's PUT /meta of Alice's collection 404s (conflation)", async () => {
      const collectionId = await freshCollection()
      let thrown: any
      try {
        await bob.was.request({
          url: metaUrl(collectionId),
          method: 'PUT',
          json: { custom: { name: 'hijack' } }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, "expected Bob's collection meta write to be rejected")
      assert.equal(thrown.response.status, 404)
    })

    it('[signed] a stale If-Match on /meta is rejected with 412', async () => {
      const collectionId = await freshCollection()
      await alice.was.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: { custom: { name: 'One' } }
      })
      let thrown: any
      try {
        await alice.was.request({
          url: metaUrl(collectionId),
          method: 'PUT',
          json: { custom: { name: 'Two' } },
          headers: { 'if-match': '"99"' }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected a stale If-Match to be rejected')
      assert.equal(thrown.response.status, 412)
    })

    it('[signed] If-None-Match: * writes once, then 412s', async () => {
      const collectionId = await freshCollection()
      const created = await alice.was.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: { custom: { name: 'First' } },
        headers: { 'if-none-match': '*' }
      })
      assert.equal(created.status, 204)
      assert.equal(created.headers.get('etag'), '"1"')

      let thrown: any
      try {
        await alice.was.request({
          url: metaUrl(collectionId),
          method: 'PUT',
          json: { custom: { name: 'Second' } },
          headers: { 'if-none-match': '*' }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected create-if-absent on written metadata to fail')
      assert.equal(thrown.response.status, 412)
    })

    it('[signed] an omitted epoch CLEARS the stored stamp', async () => {
      const collectionId = await freshCollection()
      await alice.was.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: { custom: { name: 'Stamped' }, epoch: 'epoch-1' }
      })
      const stamped = await alice.was.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(stamped.data.epoch, 'epoch-1')

      // Unlike the Resource-level rule, omitting `epoch` clears it: the write
      // replaced the whole `custom` envelope the stamp described.
      await alice.was.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: { custom: { name: 'Restamped' } }
      })
      const cleared = await alice.was.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(cleared.data.epoch, undefined)
    })

    it('[signed] metaVersion and descriptionVersion are independent ETags', async () => {
      const collectionId = await freshCollection()
      const collectionUrl = `${serverUrl}/space/${alice.space1.id}/${collectionId}`

      const described = await alice.was.request({
        url: collectionUrl,
        method: 'GET'
      })
      const descriptionEtag = described.headers.get('etag')
      assert.ok(descriptionEtag, 'the description carries its own ETag')

      // A metadata write does not disturb the description ETag.
      await alice.was.request({
        url: metaUrl(collectionId),
        method: 'PUT',
        json: { custom: { name: 'Independent' } }
      })
      const afterMeta = await alice.was.request({
        url: collectionUrl,
        method: 'GET'
      })
      assert.equal(afterMeta.headers.get('etag'), descriptionEtag)

      // ...and a description write does not disturb the metadata ETag.
      await alice.was.request({
        url: collectionUrl,
        method: 'PUT',
        json: { id: collectionId, type: ['Collection'], name: 'Renamed' }
      })
      const afterDescription = await alice.was.request({
        url: collectionUrl,
        method: 'GET'
      })
      assert.notEqual(afterDescription.headers.get('etag'), descriptionEtag)
      const meta = await alice.was.request({
        url: metaUrl(collectionId),
        method: 'GET'
      })
      assert.equal(meta.headers.get('etag'), '"1"')
      assert.equal(meta.data.custom.name, 'Independent')
    })

    it('a Resource named "meta" is rejected as a reserved id (409)', () => {
      // The Collection Metadata route occupies the `:resourceId` position, so
      // `meta` is a reserved Resource id. The GET/PUT verbs at that URL are the
      // Metadata route itself; DELETE still falls through to the Resource route,
      // where the reserved-id check rejects it.
      const collectionId = 'credentials'
      return alice.was
        .request({
          url: `${serverUrl}/space/${alice.space1.id}/${collectionId}/meta`,
          method: 'DELETE'
        })
        .then(
          () => assert.fail('expected a Resource named `meta` to be rejected'),
          (thrown: any) => {
            assert.equal(thrown.response.status, 409)
            assert.match(thrown.data.type, /#reserved-id$/)
          }
        )
    })
  })
})
