/**
 * GET List Collection `filter[attr]=value` equality-filter tests (Vitest): the
 * anonymous-cacheable sibling of the `equality` POST query profile. A
 * `filter[<attr>]=<value>` query parameter on the List Collection endpoint maps
 * to a single-element string-valued `equals` conjunction over the same
 * machinery, answering the same `{documents, hasMore, cursor?}` page.
 *
 * The key case is anonymous access: a `PublicCanRead` Collection answers a
 * filter query without authorization (so an HTTP cache can serve it), which
 * these tests exercise with a bare `fetch()` (no signing). They also cover
 * multi-attribute AND, pagination, percent-encoded bracket keys, and the
 * fail-closed validation (undeclared attribute, repeated attribute).
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

describe('GET Collection equality filter', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    aliceSpace: Space

  const spaceId = () => alice.space1.id

  /** Creates a public, indexed Collection and seeds JSON Resources into it. */
  async function seedPublicCollection(
    collectionId: string,
    indexes: unknown,
    documents: Array<{ id: string } & Record<string, unknown>>
  ): Promise<void> {
    // `indexes` is honored on the Collection PUT path (create-by-id), not the
    // POST create path, so declare via PUT.
    await alice.was.request({
      path: `/space/${spaceId()}/${collectionId}`,
      method: 'PUT',
      json: { id: collectionId, name: collectionId, indexes }
    })
    for (const document of documents) {
      await alice.was.request({
        path: `/space/${spaceId()}/${collectionId}/${document.id}`,
        method: 'PUT',
        json: document
      })
    }
    // PublicCanRead so an anonymous GET (with a filter) is served.
    await alice.was.request({
      path: `/space/${spaceId()}/${collectionId}/policy`,
      method: 'PUT',
      json: { type: 'PublicCanRead' }
    })
  }

  /** Anonymous GET of a raw List Collection URL (query string included). */
  async function anonGet(
    collectionId: string,
    rawQuery: string
  ): Promise<Response> {
    return fetch(`${serverUrl}/space/${spaceId()}/${collectionId}/${rawQuery}`)
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice } = await zcapClients({ serverUrl }))

    aliceSpace = await alice.was.createSpace({
      id: alice.space1.id,
      name: "Alice's Space #1 (Home)",
      controller: alice.did
    })
    assert.ok(aliceSpace)
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('anonymously filters a PublicCanRead Collection (200) and returns the page shape', async () => {
    await seedPublicCollection(
      'f-public',
      ['parentId'],
      [
        { id: 'c1', parentId: 'first-post', text: 'Great post!' },
        { id: 'c2', parentId: 'second-post', text: 'Nope' },
        { id: 'c3', parentId: 'first-post', text: 'Agreed' }
      ]
    )

    const response = await anonGet('f-public', '?filter[parentId]=first-post')
    assert.equal(response.status, 200)
    const body = (await response.json()) as {
      documents: Array<{ id: string; data?: any }>
      hasMore: boolean
      cursor?: string
    }
    assert.deepEqual(
      body.documents.map(doc => doc.id),
      ['c1', 'c3']
    )
    assert.equal(body.hasMore, false)
    assert.equal(body.cursor, undefined)
    // The matching JSON content rides along under `data`.
    assert.deepEqual(body.documents[0]!.data, {
      id: 'c1',
      parentId: 'first-post',
      text: 'Great post!'
    })
  })

  it('percent-encoded bracket keys work identically to literal brackets', async () => {
    // Same Collection as above; both encodings resolve the key `filter[parentId]`.
    const literal = await anonGet('f-public', '?filter[parentId]=first-post')
    const encoded = await anonGet(
      'f-public',
      '?filter%5BparentId%5D=first-post'
    )
    assert.equal(encoded.status, 200)
    const literalBody = (await literal.json()) as {
      documents: Array<{ id: string }>
    }
    const encodedBody = (await encoded.json()) as {
      documents: Array<{ id: string }>
    }
    assert.deepEqual(
      encodedBody.documents.map(doc => doc.id),
      literalBody.documents.map(doc => doc.id)
    )
    assert.deepEqual(
      encodedBody.documents.map(doc => doc.id),
      ['c1', 'c3']
    )
  })

  it('ANDs multiple distinct filter attributes', async () => {
    await seedPublicCollection(
      'f-and',
      ['parentId', 'author'],
      [
        { id: 'r1', parentId: 'p1', author: 'alice' },
        { id: 'r2', parentId: 'p1', author: 'bob' },
        { id: 'r3', parentId: 'p2', author: 'alice' }
      ]
    )
    const response = await anonGet(
      'f-and',
      '?filter[parentId]=p1&filter[author]=alice'
    )
    assert.equal(response.status, 200)
    const body = (await response.json()) as { documents: Array<{ id: string }> }
    assert.deepEqual(
      body.documents.map(doc => doc.id),
      ['r1']
    )
  })

  it('paginates with limit and the opaque cursor', async () => {
    await seedPublicCollection(
      'f-page',
      ['parentId'],
      [
        { id: 'a', parentId: 'p1' },
        { id: 'b', parentId: 'p1' },
        { id: 'c', parentId: 'p1' }
      ]
    )

    const page1Response = await anonGet(
      'f-page',
      '?filter[parentId]=p1&limit=2'
    )
    assert.equal(page1Response.status, 200)
    const page1 = (await page1Response.json()) as {
      documents: Array<{ id: string }>
      hasMore: boolean
      cursor?: string
    }
    assert.deepEqual(
      page1.documents.map(doc => doc.id),
      ['a', 'b']
    )
    assert.equal(page1.hasMore, true)
    assert.ok(page1.cursor)

    const page2Response = await anonGet(
      'f-page',
      `?filter[parentId]=p1&limit=2&cursor=${encodeURIComponent(page1.cursor!)}`
    )
    const page2 = (await page2Response.json()) as {
      documents: Array<{ id: string }>
      hasMore: boolean
    }
    assert.deepEqual(
      page2.documents.map(doc => doc.id),
      ['c']
    )
    assert.equal(page2.hasMore, false)
  })

  it('a string filter matches only string-typed content (strict typing)', async () => {
    await seedPublicCollection(
      'f-strict',
      ['count'],
      [
        { id: 'num', count: 1 },
        { id: 'str', count: '1' }
      ]
    )
    // A `filter[...]` value is always a string, so it matches the string-typed
    // Resource only -- never the numeric one.
    const response = await anonGet('f-strict', '?filter[count]=1')
    const body = (await response.json()) as { documents: Array<{ id: string }> }
    assert.deepEqual(
      body.documents.map(doc => doc.id),
      ['str']
    )
  })

  it('rejects an undeclared filter attribute (fail-closed 400)', async () => {
    await seedPublicCollection(
      'f-undeclared',
      ['parentId'],
      [{ id: 'r1', parentId: 'p1' }]
    )
    const response = await anonGet('f-undeclared', '?filter[author]=alice')
    assert.equal(response.status, 400)
    const body = (await response.json()) as { type: string }
    assert.match(body.type, /#invalid-request-body/)
  })

  it('rejects a repeated same filter attribute (400)', async () => {
    await seedPublicCollection(
      'f-repeat',
      ['parentId'],
      [{ id: 'r1', parentId: 'p1' }]
    )
    const response = await anonGet(
      'f-repeat',
      '?filter[parentId]=p1&filter[parentId]=p2'
    )
    assert.equal(response.status, 400)
  })

  it('a filter on an encrypted Collection is a 400 (it can never declare indexes)', async () => {
    await alice.was.request({
      path: `/space/${spaceId()}/f-encrypted`,
      method: 'PUT',
      json: { id: 'f-encrypted', encryption: { scheme: 'edv' } }
    })
    await alice.was.request({
      path: `/space/${spaceId()}/f-encrypted/policy`,
      method: 'PUT',
      json: { type: 'PublicCanRead' }
    })
    const response = await anonGet('f-encrypted', '?filter[parentId]=p1')
    assert.equal(response.status, 400)
  })

  it('with no filter parameter the ordinary listing is unchanged', async () => {
    await seedPublicCollection(
      'f-plainlist',
      ['parentId'],
      [
        { id: 'r1', parentId: 'p1' },
        { id: 'r2', parentId: 'p2' }
      ]
    )
    const response = await anonGet('f-plainlist', '')
    assert.equal(response.status, 200)
    const body = (await response.json()) as {
      totalItems: number
      items: Array<{ id: string }>
    }
    // The ordinary List Collection envelope (items/totalItems), not a query page.
    assert.equal(body.totalItems, 2)
    assert.deepEqual(body.items.map(item => item.id).sort(), ['r1', 'r2'])
  })

  it('an authenticated controller may also use the filter (signed request path)', async () => {
    await seedPublicCollection(
      'f-authed',
      ['parentId'],
      [
        { id: 'r1', parentId: 'p1' },
        { id: 'r2', parentId: 'p2' }
      ]
    )
    const response = await alice.was.request({
      path: `/space/${spaceId()}/f-authed/?filter[parentId]=p1`,
      method: 'GET'
    })
    assert.equal(response.status, 200)
    assert.deepEqual(
      response.data.documents.map((doc: any) => doc.id),
      ['r1']
    )
  })
})
