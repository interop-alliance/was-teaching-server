/**
 * List Collections API unit tests (Vitest).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { zcapClients } from './helpers.js'

describe('List Collections API', () => {
  let fastify: FastifyInstance, serverUrl: string, dataDir: string, alice: any
  const PORT = 7777

  beforeAll(async () => {
    serverUrl = `http://localhost:${PORT}`
    ;({ alice } = await zcapClients({ serverUrl }))
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

  it('[root] lists collections for a space', async () => {
    const spaceId = `list-collections-space-${crypto.randomUUID()}`
    const collectionId = `list-collections-collection-${crypto.randomUUID()}`
    const resourceId = `list-collections-resource-${crypto.randomUUID()}`

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

    const listing = await space.collections()
    assert.deepStrictEqual(listing, {
      url: `/space/${spaceId}/collections/`,
      totalItems: 1,
      items: [
        {
          id: collectionId,
          url: `/space/${spaceId}/${collectionId}`,
          name: 'List Collections Test Collection'
        }
      ]
    })
  })
})
