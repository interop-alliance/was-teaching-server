/**
 * A Resource whose representation file has no `.meta.` sidecar (Vitest). The
 * filesystem backend reports only what the sidecar records, so such a Resource
 * carries no timestamps, has no position in the changes feed, and serves no
 * `ETag`. No member falls back to the file's stat times.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { fileNameFor } from '@interop/space-archive'
import { isResourceChange } from '@interop/storage-core'

import type { TempFileSystemBackend } from '../src/testing.js'
import { openTempBackend, startTestServer, zcapClients } from './helpers.js'

describe('FileSystemBackend: Resource with no metadata sidecar', () => {
  const collectionId = 'bare'
  const bareId = 'no-sidecar'
  const bareBody = JSON.stringify({ n: bareId })
  let fastify: FastifyInstance,
    serverUrl: string,
    backend: TempFileSystemBackend,
    alice: any

  beforeAll(async () => {
    backend = await openTempBackend()
    ;({ fastify, serverUrl } = await startTestServer({ backend }))
    ;({ alice } = await zcapClients({ serverUrl }))

    const space = await alice.was.createSpace({
      id: alice.space1.id,
      name: "Alice's Space #1 (Home)",
      controller: alice.did
    })
    const collection = await space.createCollection({
      id: collectionId,
      name: collectionId
    })
    await collection.put('normal', { n: 'normal' })

    // The representation file alone, named as the backend names it, with no
    // `.meta.<id>.json` sidecar beside it.
    await writeFile(
      path.join(
        backend.spacesDir,
        alice.space1.id,
        collectionId,
        fileNameFor({ resourceId: bareId, contentType: 'application/json' })
      ),
      bareBody
    )
  })
  afterAll(async () => {
    await fastify.close()
  })

  function resourceUrl(resourceId: string): string {
    return new URL(
      `/space/${alice.space1.id}/${collectionId}/${resourceId}`,
      serverUrl
    ).toString()
  }

  it('reports no createdAt or updatedAt from the backend', async () => {
    const metadata = await backend.getResourceMetadata({
      spaceId: alice.space1.id,
      collectionId,
      resourceId: bareId
    })
    assert.ok(metadata, 'expected the Resource to be found')
    assert.equal(metadata.contentType, 'application/json')
    assert.equal(metadata.size, Buffer.byteLength(bareBody))
    assert.equal(metadata.createdAt, undefined)
    assert.equal(metadata.updatedAt, undefined)
  })

  it('serves /meta with no createdAt or updatedAt', async () => {
    const { data } = await alice.was.request({
      url: `${resourceUrl(bareId)}/meta`,
      method: 'GET'
    })
    assert.equal(data.contentType, 'application/json')
    assert.equal('createdAt' in data, false)
    assert.equal('updatedAt' in data, false)
  })

  it('leaves the Resource out of the changes feed', async () => {
    const { data } = await alice.was.request({
      url: new URL(
        `/space/${alice.space1.id}/${collectionId}/query`,
        serverUrl
      ).toString(),
      method: 'POST',
      json: { profile: 'changes', limit: 10 }
    })
    assert.deepEqual(
      data.documents.filter(isResourceChange).map((doc: any) => doc.id),
      ['normal']
    )
  })

  it('still serves its bytes, with no ETag', async () => {
    const response = await alice.was.request({
      url: resourceUrl(bareId),
      method: 'GET'
    })
    assert.equal(response.status, 200)
    assert.deepEqual(response.data, { n: bareId })
    assert.equal(response.headers.get('etag'), null)
  })
})
