/**
 * Collection `blinded-index` query-profile tests (Vitest): the EDV
 * blinded-attribute query served at `POST /space/:s/:c/query` (spec
 * "Collection-level reserved endpoints"; the `blinded-index-query` backend
 * feature).
 *
 * Signed queries use the raw `was.request` escape hatch, like the `changes`
 * profile tests. The stored documents are EDV encrypted-document envelopes
 * whose `indexed` attributes stand in for the client's HMAC-blinded base64url
 * strings -- the server matches them opaquely, so no real crypto is needed.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import type { JsonObject, Space } from '@interop/was-client'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { startTestServer, zcapClients } from './helpers.js'

const HMAC_ID = 'did:key:zHmacKeyA'

/**
 * A stored EDV encrypted-document envelope carrying one blinded `indexed`
 * entry (structurally what `@interop/edv-client` produces).
 */
function envelope(
  docId: string,
  attributes: Array<{ name: string; value: string; unique?: boolean }>
): JsonObject {
  return {
    id: docId,
    sequence: 0,
    indexed: [
      {
        hmac: { id: HMAC_ID, type: 'Sha256HmacKey2019' },
        sequence: 0,
        attributes
      }
    ],
    jwe: {
      protected: 'eyJlbmMiOiJYQzIwUCJ9',
      iv: 'aXY',
      ciphertext: 'Y2lwaGVydGV4dA',
      tag: 'dGFn'
    }
  }
}

describe('Collection blinded-index query profile', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    bob: any,
    aliceSpace: Space

  /** POSTs a `blinded-index` query body to a Collection's `/query` with `signer`. */
  async function queryIndex(
    signer: any,
    collectionId: string,
    body: Record<string, unknown>
  ): Promise<any> {
    const url = new URL(
      `/space/${alice.space1.id}/${collectionId}/query`,
      serverUrl
    ).toString()
    return signer.was.request({
      url,
      method: 'POST',
      json: { profile: 'blinded-index', index: HMAC_ID, ...body }
    })
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice, bob } = await zcapClients({ serverUrl }))

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

  /** Creates a Collection and PUTs each envelope at its id. */
  async function seedCollection(collectionId: string, documents: JsonObject[]) {
    const collection = await aliceSpace.createCollection({
      id: collectionId,
      name: collectionId
    })
    for (const document of documents) {
      await collection.put(document.id as string, document)
    }
    return collection
  }

  it('returns matching envelope documents verbatim with hasMore', async () => {
    await seedCollection('vault', [
      envelope('alpha', [
        { name: 'n1', value: 'v1' },
        { name: 'n2', value: 'v2' }
      ]),
      envelope('beta', [{ name: 'n1', value: 'v1' }]),
      envelope('gamma', [{ name: 'n1', value: 'vX' }])
    ])

    const { data } = await queryIndex(alice, 'vault', {
      equals: [{ n1: 'v1' }]
    })
    assert.deepEqual(
      data.documents.map((doc: any) => doc.id),
      ['alpha', 'beta']
    )
    assert.equal(data.hasMore, false)
    assert.equal(data.cursor, undefined)
    // The stored envelope round-trips untouched.
    assert.deepEqual(
      data.documents[1],
      envelope('beta', [{ name: 'n1', value: 'v1' }])
    )
  })

  it('serves has queries and count queries', async () => {
    await seedCollection('vault-has', [
      envelope('a', [
        { name: 'n1', value: 'v1' },
        { name: 'n2', value: 'v2' }
      ]),
      envelope('b', [{ name: 'n1', value: 'v9' }])
    ])

    const { data: hasPage } = await queryIndex(alice, 'vault-has', {
      has: ['n1', 'n2']
    })
    assert.deepEqual(
      hasPage.documents.map((doc: any) => doc.id),
      ['a']
    )

    const { data: counted } = await queryIndex(alice, 'vault-has', {
      equals: [{ n1: 'v1' }, { n1: 'v9' }],
      count: true
    })
    assert.deepEqual(counted, { count: 2 })
  })

  it('paginates with the opaque cursor riding the signed body', async () => {
    await seedCollection('vault-pages', [
      envelope('a', [{ name: 'n1', value: 'v1' }]),
      envelope('b', [{ name: 'n1', value: 'v1' }]),
      envelope('c', [{ name: 'n1', value: 'v1' }])
    ])

    const { data: page1 } = await queryIndex(alice, 'vault-pages', {
      equals: [{ n1: 'v1' }],
      limit: 2
    })
    assert.deepEqual(
      page1.documents.map((doc: any) => doc.id),
      ['a', 'b']
    )
    assert.equal(page1.hasMore, true)
    assert.ok(page1.cursor, 'expected a cursor on a non-final page')

    const { data: page2 } = await queryIndex(alice, 'vault-pages', {
      equals: [{ n1: 'v1' }],
      limit: 2,
      cursor: page1.cursor
    })
    assert.deepEqual(
      page2.documents.map((doc: any) => doc.id),
      ['c']
    )
    assert.equal(page2.hasMore, false)
  })

  it('rejects a malformed query body with 400', async () => {
    await seedCollection('vault-bad', [
      envelope('a', [{ name: 'n1', value: 'v1' }])
    ])

    // Neither equals nor has.
    let thrown: any
    try {
      await queryIndex(alice, 'vault-bad', {})
    } catch (err) {
      thrown = err
    }
    assert.equal(thrown?.response?.status, 400)

    // Both equals and has.
    thrown = undefined
    try {
      await queryIndex(alice, 'vault-bad', {
        equals: [{ n1: 'v1' }],
        has: ['n1']
      })
    } catch (err) {
      thrown = err
    }
    assert.equal(thrown?.response?.status, 400)

    // Non-string equals value.
    thrown = undefined
    try {
      await queryIndex(alice, 'vault-bad', { equals: [{ n1: 5 }] })
    } catch (err) {
      thrown = err
    }
    assert.equal(thrown?.response?.status, 400)

    // Missing index.
    thrown = undefined
    try {
      await queryIndex(alice, 'vault-bad', { index: '', has: ['n1'] })
    } catch (err) {
      thrown = err
    }
    assert.equal(thrown?.response?.status, 400)
  })

  it('rejects a malformed cursor with 400 invalid-cursor', async () => {
    await seedCollection('vault-cursor', [
      envelope('a', [{ name: 'n1', value: 'v1' }])
    ])
    let thrown: any
    try {
      await queryIndex(alice, 'vault-cursor', {
        has: ['n1'],
        cursor: 'not!!valid'
      })
    } catch (err) {
      thrown = err
    }
    assert.equal(thrown?.response?.status, 400)
  })

  it('returns 404 to a caller not authorized to read the Collection', async () => {
    await seedCollection('vault-private', [
      envelope('a', [{ name: 'n1', value: 'v1' }])
    ])
    let thrown: any
    try {
      await queryIndex(bob, 'vault-private', { has: ['n1'] })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, "expected Bob's query to be rejected")
    assert.equal(thrown.response.status, 404)
  })

  it('advertises blinded-index-query in the default backend features', async () => {
    const backend = new FileSystemBackend({ dataDir })
    assert.ok(backend.describe().features.includes('blinded-index-query'))
  })

  it('rejects a write claiming a held unique blinded attribute with 409', async () => {
    const holder = envelope('holder', [
      { name: 'n1', value: 'v1', unique: true }
    ])
    const collection = await seedCollection('vault-unique', [holder])
    const resourceUrl = (resourceId: string) =>
      new URL(
        `/space/${alice.space1.id}/vault-unique/${resourceId}`,
        serverUrl
      ).toString()

    // A second document claiming the same unique triple: 409 id-conflict.
    let thrown: any
    try {
      await alice.was.request({
        url: resourceUrl('claimant'),
        method: 'PUT',
        json: envelope('claimant', [{ name: 'n1', value: 'v1', unique: true }])
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected the conflicting claim to be rejected')
    assert.equal(thrown.response.status, 409)

    // The holder updating itself (keeping its claim) is not a self-conflict...
    await collection.put('holder', holder)
    // ...and the same pair without `unique` coexists (both-sides rule).
    await collection.put(
      'bystander',
      envelope('bystander', [{ name: 'n1', value: 'v1' }])
    )
  })
})
