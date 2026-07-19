/**
 * Chunk API integration tests (Vitest, in-process): the `chunked-streams`
 * feature -- addressing one chunk of a chunked Resource at
 * `/space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex`, plus the
 * `chunks/` discovery listing. A chunk body is opaque bytes + content-type,
 * stored exactly like a binary Resource representation, so these exercise the
 * raw-bytes put/get/head/delete round-trip, the JSON-envelope reuse path, the
 * listing, conditional writes, the bad-index and parent-missing guards, the
 * per-upload cap (413), the parent-delete cascade, and export/import carry.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import type { Space, Collection } from '@interop/was-client'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { startTestServer, zcapClients } from './helpers.js'

/**
 * Resolves the HTTP status of a signed request, whether it fulfills (2xx/3xx)
 * or rejects with a raw ky error (the `request()` escape hatch does not map
 * non-2xx to typed errors, so a rejection carries `err.response.status`).
 * @param promise {Promise<{ status: number }>}
 * @returns {Promise<number>}
 */
async function statusOf(promise: Promise<{ status: number }>): Promise<number> {
  try {
    return (await promise).status
  } catch (err) {
    return (
      (err as { response?: { status?: number }; status?: number }).response
        ?.status ??
      (err as { status?: number }).status ??
      0
    )
  }
}

describe('Chunk API (chunked-streams)', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    aliceSpace: Space,
    dataCollection: Collection

  const spaceId = '426e7db8-26b5-4fdc-8068-9dcb948fd291'

  // The absolute member (one chunk) and container (listing) URLs.
  const chunkUrl = (resourceId: string, chunkIndex: number | string) =>
    `${serverUrl}/space/${spaceId}/data/${resourceId}/chunks/${chunkIndex}`
  const listUrl = (resourceId: string) =>
    `${serverUrl}/space/${spaceId}/data/${resourceId}/chunks/`
  const resourceUrl = (resourceId: string) =>
    `${serverUrl}/space/${spaceId}/data/${resourceId}`

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-chunks-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice } = await zcapClients({ serverUrl }))

    aliceSpace = await alice.was.createSpace({
      id: spaceId,
      name: "Alice's Chunk Space",
      controller: alice.did
    })
    dataCollection = await aliceSpace.createCollection({
      id: 'data',
      name: 'Chunked Data'
    })
  })

  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  describe('binary chunk round-trip', () => {
    it('[signed] PUT / GET / HEAD / DELETE a raw octet-stream chunk', async () => {
      const resourceId = 'binary-blob'
      // A chunked Resource's parent must exist before any chunk can be written.
      await dataCollection.put(resourceId, { id: resourceId, name: 'Manifest' })

      const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
      const putResponse = await alice.was.request({
        url: chunkUrl(resourceId, 0),
        method: 'PUT',
        body: new Blob([bytes], { type: 'application/octet-stream' })
      })
      assert.equal(putResponse.status, 204)
      // The chunk carries its own monotonic version (first write => "1").
      assert.equal(putResponse.headers.get('etag'), '"1"')

      // GET streams back the exact stored bytes with the stored content-type.
      const getResponse = await alice.was.request({
        url: chunkUrl(resourceId, 0),
        method: 'GET'
      })
      assert.equal(getResponse.status, 200)
      assert.match(
        getResponse.headers.get('content-type')!,
        /application\/octet-stream/
      )
      assert.equal(getResponse.headers.get('etag'), '"1"')
      assert.deepEqual(new Uint8Array(await getResponse.arrayBuffer()), bytes)

      // HEAD carries the payload headers from stored metadata, no body.
      const headResponse = await alice.was.request({
        url: chunkUrl(resourceId, 0),
        method: 'HEAD'
      })
      assert.equal(headResponse.status, 200)
      assert.match(
        headResponse.headers.get('content-type')!,
        /application\/octet-stream/
      )
      assert.equal(
        headResponse.headers.get('content-length'),
        String(bytes.length)
      )
      assert.equal(headResponse.headers.get('etag'), '"1"')
      assert.equal(await headResponse.text(), '')

      // DELETE removes the chunk; a subsequent GET 404s.
      const deleteResponse = await alice.was.request({
        url: chunkUrl(resourceId, 0),
        method: 'DELETE'
      })
      assert.equal(deleteResponse.status, 204)
      assert.equal(
        await statusOf(
          alice.was.request({
            url: chunkUrl(resourceId, 0),
            method: 'GET'
          })
        ),
        404
      )
    })

    it('[signed] a JSON-body chunk (EDV envelope reuse path) round-trips', async () => {
      const resourceId = 'json-envelope'
      await dataCollection.put(resourceId, { id: resourceId })

      const envelope = { index: 0, jwe: { ciphertext: 'AAAA' } }
      const putResponse = await alice.was.request({
        url: chunkUrl(resourceId, 0),
        method: 'PUT',
        json: envelope
      })
      assert.equal(putResponse.status, 204)

      const getResponse = await alice.was.request({
        url: chunkUrl(resourceId, 0),
        method: 'GET'
      })
      assert.equal(getResponse.status, 200)
      assert.match(
        getResponse.headers.get('content-type')!,
        /application\/json/
      )
      // A JSON content-type is auto-parsed onto `.data`.
      assert.equal(getResponse.data.jwe.ciphertext, 'AAAA')
    })
  })

  describe('listing', () => {
    it('[signed] lists multiple chunks in ascending index order with sizes', async () => {
      const resourceId = 'multi-chunk'
      await dataCollection.put(resourceId, { id: resourceId })

      const chunkBytes = [
        new Uint8Array([1]),
        new Uint8Array([2, 2]),
        new Uint8Array([3, 3, 3])
      ]
      // Write out of order to prove the listing sorts by index, not write order.
      for (const index of [2, 0, 1]) {
        const response = await alice.was.request({
          url: chunkUrl(resourceId, index),
          method: 'PUT',
          body: new Blob([chunkBytes[index]!], {
            type: 'application/octet-stream'
          })
        })
        assert.equal(response.status, 204)
      }

      const listing = await alice.was.request({
        url: listUrl(resourceId),
        method: 'GET'
      })
      assert.equal(listing.status, 200)
      assert.match(listing.headers.get('content-type')!, /application\/json/)
      assert.equal(listing.data.resourceId, resourceId)
      assert.equal(listing.data.count, 3)
      assert.deepEqual(
        listing.data.chunks.map((chunk: { index: number }) => chunk.index),
        [0, 1, 2]
      )
      assert.deepEqual(
        listing.data.chunks.map((chunk: { size: number }) => chunk.size),
        [1, 2, 3]
      )
      for (const chunk of listing.data.chunks) {
        assert.equal(chunk.contentType, 'application/octet-stream')
        assert.equal(chunk.version, 1)
      }
    })

    it('[signed] a Resource with no chunks lists count 0', async () => {
      const resourceId = 'no-chunks'
      await dataCollection.put(resourceId, { id: resourceId })

      const listing = await alice.was.request({
        url: listUrl(resourceId),
        method: 'GET'
      })
      assert.equal(listing.status, 200)
      assert.equal(listing.data.count, 0)
      assert.deepEqual(listing.data.chunks, [])
    })

    it('[signed] listing an absent Resource 404s', async () => {
      assert.equal(
        await statusOf(
          alice.was.request({
            url: listUrl('does-not-exist'),
            method: 'GET'
          })
        ),
        404
      )
    })

    it('the no-slash list URL 308-redirects to the trailing-slash form', async () => {
      const resourceId = 'redirect-list'
      await dataCollection.put(resourceId, { id: resourceId })

      // A read-reachable redirect: no auth headers needed, and it must emit the
      // concrete path with the trailing slash toggled (not the route template).
      const response = await fastify.inject({
        method: 'GET',
        url: `/space/${spaceId}/data/${resourceId}/chunks`
      })
      assert.equal(response.statusCode, 308)
      assert.equal(
        response.headers.location,
        `/space/${spaceId}/data/${resourceId}/chunks/`
      )
    })
  })

  describe('guards', () => {
    it('[signed] PUT a chunk of an absent parent Resource 404s', async () => {
      assert.equal(
        await statusOf(
          alice.was.request({
            url: chunkUrl('parent-missing', 0),
            method: 'PUT',
            body: new Blob([new Uint8Array([9])], {
              type: 'application/octet-stream'
            })
          })
        ),
        404
      )
    })

    it('[signed] a non-canonical :chunkIndex 400s', async () => {
      const resourceId = 'bad-index'
      await dataCollection.put(resourceId, { id: resourceId })

      // 'abc' non-integer, '-1' negative, '01' leading zero, '1.5' non-integer.
      for (const badIndex of ['abc', '-1', '01', '1.5']) {
        assert.equal(
          await statusOf(
            alice.was.request({
              url: chunkUrl(resourceId, badIndex),
              method: 'GET'
            })
          ),
          400,
          `expected 400 for chunk index "${badIndex}"`
        )
      }
    })

    it('[signed] the chunk index range caps at 2^31-1 (both backends agree)', async () => {
      const resourceId = 'index-range'
      await dataCollection.put(resourceId, { id: resourceId })

      // The largest addressable index is valid: it 404s as an ABSENT chunk
      // (not a 400), while one past it exceeds MAX_CHUNK_INDEX (the Postgres
      // `chunk_index` column is int4, and the shared validation keeps the
      // filesystem to the same range) and is rejected up front.
      assert.equal(
        await statusOf(
          alice.was.request({
            url: chunkUrl(resourceId, '2147483647'),
            method: 'GET'
          })
        ),
        404
      )
      assert.equal(
        await statusOf(
          alice.was.request({
            url: chunkUrl(resourceId, '2147483648'),
            method: 'GET'
          })
        ),
        400
      )
    })

    it('[signed] an orphan chunk (no parent Resource) 404s on GET / HEAD / DELETE', async () => {
      // Fabricate out-of-band state the API cannot produce (writes require the
      // parent; parent deletes cascade): a chunk file on disk for a Resource
      // that does not exist. The member handlers must gate on the parent, like
      // the listing does, instead of serving the orphan's bytes.
      const chunkDir = path.join(
        dataDir,
        'spaces',
        spaceId,
        'data',
        '.chunks.orphan-parent'
      )
      await mkdir(chunkDir, { recursive: true })
      await writeFile(
        path.join(chunkDir, 'r.0.application%2Foctet-stream.bin'),
        new Uint8Array([1, 2, 3])
      )

      for (const method of ['GET', 'HEAD', 'DELETE']) {
        assert.equal(
          await statusOf(
            alice.was.request({
              url: chunkUrl('orphan-parent', 0),
              method
            })
          ),
          404,
          `expected 404 for orphan chunk ${method}`
        )
      }
    })

    it('an unauthenticated chunk write is rejected (401)', async () => {
      const resourceId = 'no-auth-write'
      await dataCollection.put(resourceId, { id: resourceId })

      const response = await fetch(new URL(chunkUrl(resourceId, 0)), {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: 'x'
      })
      assert.equal(response.status, 401)
    })
  })

  describe('conditional writes', () => {
    it('[signed] If-Match / If-None-Match gate on the chunk version', async () => {
      const resourceId = 'conditional'
      await dataCollection.put(resourceId, { id: resourceId })

      const created = await alice.was.request({
        url: chunkUrl(resourceId, 0),
        method: 'PUT',
        body: new Blob([new Uint8Array([1])], {
          type: 'application/octet-stream'
        })
      })
      assert.equal(created.headers.get('etag'), '"1"')

      // A stale If-Match is rejected...
      assert.equal(
        await statusOf(
          alice.was.request({
            url: chunkUrl(resourceId, 0),
            method: 'PUT',
            body: new Blob([new Uint8Array([2])], {
              type: 'application/octet-stream'
            }),
            headers: { 'if-match': '"999"' }
          })
        ),
        412
      )

      // ...the matching one succeeds and advances the version.
      const updated = await alice.was.request({
        url: chunkUrl(resourceId, 0),
        method: 'PUT',
        body: new Blob([new Uint8Array([2])], {
          type: 'application/octet-stream'
        }),
        headers: { 'if-match': '"1"' }
      })
      assert.equal(updated.status, 204)
      assert.equal(updated.headers.get('etag'), '"2"')

      // If-None-Match: * on an existing chunk 412s (create-if-absent fails).
      assert.equal(
        await statusOf(
          alice.was.request({
            url: chunkUrl(resourceId, 0),
            method: 'PUT',
            body: new Blob([new Uint8Array([3])], {
              type: 'application/octet-stream'
            }),
            headers: { 'if-none-match': '*' }
          })
        ),
        412
      )
    })

    it('[signed] DELETE of an absent chunk 404s; DELETE of a present one 204s', async () => {
      const resourceId = 'delete-chunk'
      await dataCollection.put(resourceId, { id: resourceId })

      // Unlike Delete Resource, deleting an absent chunk is a 404.
      assert.equal(
        await statusOf(
          alice.was.request({
            url: chunkUrl(resourceId, 0),
            method: 'DELETE'
          })
        ),
        404
      )

      await alice.was.request({
        url: chunkUrl(resourceId, 0),
        method: 'PUT',
        body: new Blob([new Uint8Array([7])], {
          type: 'application/octet-stream'
        })
      })
      const deleted = await alice.was.request({
        url: chunkUrl(resourceId, 0),
        method: 'DELETE'
      })
      assert.equal(deleted.status, 204)
      assert.equal(
        await statusOf(
          alice.was.request({
            url: chunkUrl(resourceId, 0),
            method: 'GET'
          })
        ),
        404
      )
    })

    it('[signed] deleting the last chunk removes the on-disk chunk directory', async () => {
      const resourceId = 'dir-cleanup'
      await dataCollection.put(resourceId, { id: resourceId })
      for (const index of [0, 1]) {
        await alice.was.request({
          url: chunkUrl(resourceId, index),
          method: 'PUT',
          body: new Blob([new Uint8Array([index])], {
            type: 'application/octet-stream'
          })
        })
      }

      const chunkDir = path.join(
        dataDir,
        'spaces',
        spaceId,
        'data',
        `.chunks.${resourceId}`
      )
      await stat(chunkDir) // present while chunks remain

      await alice.was.request({
        url: chunkUrl(resourceId, 0),
        method: 'DELETE'
      })
      await stat(chunkDir) // still present: chunk 1 remains

      // The last delete removes the emptied directory itself, so it neither
      // shows up in the export walk nor counts toward the du-based quota.
      await alice.was.request({
        url: chunkUrl(resourceId, 1),
        method: 'DELETE'
      })
      await assert.rejects(stat(chunkDir), { code: 'ENOENT' })
    })
  })

  describe('changes feed', () => {
    it('[signed] chunk writes do not surface on the changes feed; the parent manifest PUT does', async () => {
      const feedCollection = await aliceSpace.createCollection({
        id: 'feed',
        name: 'Feed'
      })
      const queryUrl = `${serverUrl}/space/${spaceId}/feed/query`
      const feedChunkUrl = (index: number) =>
        `${serverUrl}/space/${spaceId}/feed/manifest/chunks/${index}`

      await feedCollection.put('manifest', { id: 'manifest', sequence: 0 })

      // Drain the feed and keep the checkpoint after the initial write.
      const initial = await alice.was.request({
        url: queryUrl,
        method: 'POST',
        json: { profile: 'changes', limit: 10 }
      })
      assert.ok(
        initial.data.documents.some(
          (document: { id: string }) => document.id === 'manifest'
        )
      )
      const checkpoint = initial.data.checkpoint

      // A chunk write and a chunk delete bump only the chunk's own version:
      // neither touches the parent Resource's feed position.
      for (const index of [0, 1]) {
        await alice.was.request({
          url: feedChunkUrl(index),
          method: 'PUT',
          body: new Blob([new Uint8Array([index])], {
            type: 'application/octet-stream'
          })
        })
      }
      await alice.was.request({ url: feedChunkUrl(1), method: 'DELETE' })
      const afterChunks = await alice.was.request({
        url: queryUrl,
        method: 'POST',
        json: { profile: 'changes', limit: 10, checkpoint }
      })
      assert.deepEqual(afterChunks.data.documents, [])

      // The intended flow -- write chunks, then PUT the parent manifest with
      // its new sequence -- is what surfaces the change to replicators.
      await feedCollection.put('manifest', { id: 'manifest', sequence: 1 })
      const afterManifest = await alice.was.request({
        url: queryUrl,
        method: 'POST',
        json: { profile: 'changes', limit: 10, checkpoint }
      })
      assert.deepEqual(
        afterManifest.data.documents.map(
          (document: { id: string }) => document.id
        ),
        ['manifest']
      )
    })
  })

  describe('parent-delete cascade', () => {
    it('[signed] deleting the parent Resource removes its chunks', async () => {
      const resourceId = 'cascade'
      await dataCollection.put(resourceId, { id: resourceId })
      for (const index of [0, 1]) {
        await alice.was.request({
          url: chunkUrl(resourceId, index),
          method: 'PUT',
          body: new Blob([new Uint8Array([index])], {
            type: 'application/octet-stream'
          })
        })
      }

      // Delete the parent Resource.
      const deleted = await alice.was.request({
        url: resourceUrl(resourceId),
        method: 'DELETE'
      })
      assert.equal(deleted.status, 204)

      // The chunks are gone (404), and the listing 404s since the parent is gone.
      assert.equal(
        await statusOf(
          alice.was.request({
            url: chunkUrl(resourceId, 0),
            method: 'GET'
          })
        ),
        404
      )
      assert.equal(
        await statusOf(
          alice.was.request({
            url: listUrl(resourceId),
            method: 'GET'
          })
        ),
        404
      )
    })
  })

  describe('export / import round-trip', () => {
    it('[signed] chunks travel through Space export and import', async () => {
      const resourceId = 'exported'
      await dataCollection.put(resourceId, { id: resourceId, name: 'Exported' })
      const chunkBytes = [
        new Uint8Array([10, 11]),
        new Uint8Array([20, 21, 22])
      ]
      for (const index of [0, 1]) {
        await alice.was.request({
          url: chunkUrl(resourceId, index),
          method: 'PUT',
          body: new Blob([chunkBytes[index]!], {
            type: 'application/octet-stream'
          })
        })
      }

      const archive = await aliceSpace.export()

      // Import into a fresh Space (merges into a pre-provisioned target).
      const targetSpaceId = '6b5be748-5f39-4936-a895-409e393c399c'
      const targetSpace = await alice.was.createSpace({
        id: targetSpaceId,
        name: 'Import Target',
        controller: alice.did
      })
      await targetSpace.import(archive)

      // The chunk bytes came back under the target Space's mirrored Collection.
      const targetChunkUrl = (index: number) =>
        `${serverUrl}/space/${targetSpaceId}/data/${resourceId}/chunks/${index}`
      for (const index of [0, 1]) {
        const response = await alice.was.request({
          url: targetChunkUrl(index),
          method: 'GET'
        })
        assert.equal(response.status, 200)
        assert.deepEqual(
          new Uint8Array(await response.arrayBuffer()),
          chunkBytes[index]
        )
      }

      // The listing round-trips too.
      const listing = await alice.was.request({
        url: `${serverUrl}/space/${targetSpaceId}/data/${resourceId}/chunks/`,
        method: 'GET'
      })
      assert.equal(listing.data.count, 2)
      assert.deepEqual(
        listing.data.chunks.map((chunk: { index: number }) => chunk.index),
        [0, 1]
      )
    })
  })

  describe('per-upload cap (413)', () => {
    let capFastify: FastifyInstance,
      capServerUrl: string,
      capDataDir: string,
      capAlice: any

    const capSpaceId = '94f03216-5ab4-4723-853c-cf837c171323'
    const maxUploadBytes = 1024

    beforeAll(async () => {
      capDataDir = await mkdtemp(path.join(tmpdir(), 'was-chunks-cap-'))
      ;({ fastify: capFastify, serverUrl: capServerUrl } =
        await startTestServer({
          backend: new FileSystemBackend({
            dataDir: capDataDir,
            maxUploadBytes
          })
        }))
      ;({ alice: capAlice } = await zcapClients({ serverUrl: capServerUrl }))

      const space = await capAlice.was.createSpace({
        id: capSpaceId,
        name: 'Chunk Upload Cap Space',
        controller: capAlice.did
      })
      await space.createCollection({ id: 'data', name: 'Data' })
    })

    afterAll(async () => {
      await capFastify.close()
      await rm(capDataDir, { recursive: true, force: true })
    })

    it('[signed] a chunk over maxUploadBytes is rejected with 413', async () => {
      const resourceId = 'too-big'
      await capAlice.was
        .space(capSpaceId)
        .collection('data')
        .put(resourceId, { id: resourceId })

      const oversized = new Uint8Array(maxUploadBytes * 2)
      assert.equal(
        await statusOf(
          capAlice.was.request({
            url: `${capServerUrl}/space/${capSpaceId}/data/${resourceId}/chunks/0`,
            method: 'PUT',
            body: new Blob([oversized], { type: 'application/octet-stream' })
          })
        ),
        413
      )
    })
  })
})
