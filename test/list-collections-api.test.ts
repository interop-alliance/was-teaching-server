/**
 * List Collections API unit tests (Vitest).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { startTestServer, zcapClients } from './helpers.js'

describe('List Collections API', () => {
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
