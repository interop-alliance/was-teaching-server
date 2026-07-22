/**
 * List Collection cursor-based pagination tests (Vitest, spec "Pagination").
 *
 * Signed paginated reads use the raw `was.request` escape hatch with a full URL
 * carrying `?limit`/`cursor`; the high-level `Collection.list()` does not yet
 * surface pagination parameters. Authorization tolerance for the query string is
 * exercised here too (the `next` URL is followed with the same authorization).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import type { Space } from '@interop/was-client'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { signedGet, startTestServer, zcapClients } from './helpers.js'

describe('List Collection pagination', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    bob: any,
    aliceSpace: Space

  /** GETs an absolute or server-relative URL with Alice's signed capability. */
  const aliceGet = (url: string): Promise<any> =>
    signedGet({ identity: alice, serverUrl, url })

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

  /**
   * Creates a fresh Collection and PUTs resources at the given ids (in the given
   * insertion order). Returns the Collection's relative listing path.
   */
  async function seedCollection(
    collectionId: string,
    ids: string[]
  ): Promise<string> {
    const collection = await aliceSpace.createCollection({
      id: collectionId,
      name: collectionId
    })
    for (const id of ids) {
      await collection.put(id, { value: id })
    }
    return `/space/${alice.space1.id}/${collectionId}/`
  }

  it('returns the whole Collection (no next) when it fits in one page', async () => {
    const listPath = await seedCollection('fits', ['a', 'b', 'c'])
    const { data } = await aliceGet(listPath)
    assert.equal(data.totalItems, 3)
    assert.deepStrictEqual(
      data.items.map((item: any) => item.id),
      ['a', 'b', 'c']
    )
    assert.equal(data.next, undefined)
  })

  it('an empty Collection has no next', async () => {
    const listPath = await seedCollection('empty', [])
    const { data } = await aliceGet(listPath)
    assert.equal(data.totalItems, 0)
    assert.deepStrictEqual(data.items, [])
    assert.equal(data.next, undefined)
  })

  it('pages through a multi-page Collection, each id exactly once, in order', async () => {
    // Insert in shuffled order to prove the listing order is by id, not insertion.
    const ids = ['e05', 'e01', 'e04', 'e02', 'e00', 'e03']
    const listPath = await seedCollection('paged', ids)

    const seen: string[] = []
    let url: string | undefined = `${listPath}?limit=2`
    let pages = 0
    while (url) {
      const { data }: any = await aliceGet(url)
      pages++
      assert.ok(
        data.items.length <= 2,
        'page never exceeds the requested limit'
      )
      seen.push(...data.items.map((item: any) => item.id))
      url = data.next
    }

    // 6 items at limit 2 -> 3 pages (2, 2, 2); the last page omits `next` even
    // though it exactly filled (no spurious empty trailing page).
    assert.equal(pages, 3)
    assert.deepStrictEqual(seen, ['e00', 'e01', 'e02', 'e03', 'e04', 'e05'])
    // Every id appears exactly once across pages.
    assert.equal(new Set(seen).size, seen.length)
  })

  it('the final page (exactly filling the limit) omits next', async () => {
    const listPath = await seedCollection('exact', ['x1', 'x2', 'x3', 'x4'])
    // First page of 2, follow next to the second page of 2 -> no further page.
    const { data: page1 } = await aliceGet(`${listPath}?limit=2`)
    assert.deepStrictEqual(
      page1.items.map((item: any) => item.id),
      ['x1', 'x2']
    )
    assert.ok(page1.next)
    const { data: page2 } = await aliceGet(page1.next)
    assert.deepStrictEqual(
      page2.items.map((item: any) => item.id),
      ['x3', 'x4']
    )
    assert.equal(page2.next, undefined)
  })

  it('a cursor past the end returns an empty page with no next', async () => {
    const listPath = await seedCollection('pastend', ['p1', 'p2'])
    // Walk to the last page, then build a request continuing past it: follow the
    // page-1 next (limit 1) to page 2 (its next points past the end).
    const { data: page1 } = await aliceGet(`${listPath}?limit=1`)
    const { data: page2 } = await aliceGet(page1.next)
    assert.deepStrictEqual(
      page2.items.map((item: any) => item.id),
      ['p2']
    )
    // page2 is the last page (p2 is the final id), so it has no next.
    assert.equal(page2.next, undefined)
  })

  it('default page size applies when limit is absent or non-positive', async () => {
    const listPath = await seedCollection('defaulted', ['d1', 'd2', 'd3'])
    for (const query of ['', '?limit=0', '?limit=-5', '?limit=notanumber']) {
      const { data } = await aliceGet(`${listPath}${query}`)
      assert.deepStrictEqual(
        data.items.map((item: any) => item.id),
        ['d1', 'd2', 'd3'],
        `query "${query}" should fall back to the default page`
      )
      assert.equal(data.next, undefined)
    }
  })

  it('an oversized limit is clamped (returns everything, no next)', async () => {
    const listPath = await seedCollection('oversized', ['o1', 'o2', 'o3'])
    const { data } = await aliceGet(`${listPath}?limit=999999`)
    assert.deepStrictEqual(
      data.items.map((item: any) => item.id),
      ['o1', 'o2', 'o3']
    )
    assert.equal(data.next, undefined)
  })

  it('deterministic order regardless of insertion order', async () => {
    const listPath = await seedCollection('ordered', [
      'm03',
      'm00',
      'm02',
      'm01'
    ])
    const { data } = await aliceGet(listPath)
    assert.deepStrictEqual(
      data.items.map((item: any) => item.id),
      ['m00', 'm01', 'm02', 'm03']
    )
  })

  it('a garbage cursor yields invalid-cursor (400) for an authorized caller', async () => {
    const listPath = await seedCollection('badcursor', ['c1', 'c2'])
    let expectedError: any
    try {
      await aliceGet(`${listPath}?cursor=not-valid-base64url-%%%`)
    } catch (error) {
      expectedError = error
    }
    assert.ok(expectedError, 'expected the garbage cursor to be rejected')
    assert.equal(expectedError.response.status, 400)
    assert.equal(
      expectedError.data.type,
      'https://wallet.storage/spec#invalid-cursor'
    )
  })

  it('a syntactically valid but wrong-shape cursor yields invalid-cursor (400)', async () => {
    const listPath = await seedCollection('badshape', ['s1', 's2'])
    // base64url of `{"foo":"bar"}` -- valid base64url + JSON, but no `after`.
    const cursor = Buffer.from(JSON.stringify({ foo: 'bar' })).toString(
      'base64url'
    )
    let expectedError: any
    try {
      await aliceGet(`${listPath}?cursor=${cursor}`)
    } catch (error) {
      expectedError = error
    }
    assert.ok(expectedError, 'expected the wrong-shape cursor to be rejected')
    assert.equal(expectedError.response.status, 400)
    assert.equal(
      expectedError.data.type,
      'https://wallet.storage/spec#invalid-cursor'
    )
  })

  it('keyset stability: deleting the cursor anchor mid-traversal still pages correctly', async () => {
    const collectionId = 'stability'
    const collection = await aliceSpace.createCollection({
      id: collectionId,
      name: collectionId
    })
    for (const id of ['k1', 'k2', 'k3', 'k4']) {
      await collection.put(id, { value: id })
    }
    const listPath = `/space/${alice.space1.id}/${collectionId}/`

    // Page 1 (limit 2) -> [k1, k2]; its cursor anchor is k2.
    const { data: page1 } = await aliceGet(`${listPath}?limit=2`)
    assert.deepStrictEqual(
      page1.items.map((item: any) => item.id),
      ['k1', 'k2']
    )
    assert.ok(page1.next)

    // Delete the anchor (k2) before following next; the keyset scan resumes at
    // the first id strictly greater than k2, so the remaining items are intact.
    await collection.resource('k2').delete()

    const { data: page2 } = await aliceGet(page1.next)
    assert.deepStrictEqual(
      page2.items.map((item: any) => item.id),
      ['k3', 'k4']
    )
    assert.equal(page2.next, undefined)
  })

  it('an unauthorized caller with a (garbage) cursor still gets 404, never 400', async () => {
    const listPath = await seedCollection('private', ['z1', 'z2'])
    // Bob is not the Space controller and the Collection is not public-readable,
    // so authorization fails (merged 404) BEFORE any cursor validation.
    let expectedError: any
    try {
      await bob.was.request({
        url: new URL(`${listPath}?cursor=garbage%%%`, serverUrl).toString(),
        method: 'GET'
      })
    } catch (error) {
      expectedError = error
    }
    assert.ok(expectedError, 'expected the unauthorized read to be rejected')
    assert.equal(expectedError.response.status, 404)
  })

  it('next is followed under the same capability (query does not change the target)', async () => {
    const listPath = await seedCollection('authfollow', ['f1', 'f2', 'f3'])
    const { data: page1 } = await aliceGet(`${listPath}?limit=1`)
    assert.ok(page1.next, 'first page should advertise a next link')
    // Following `next` (a query-bearing URL) verifies against the bare-collection
    // capability -- it must not 404/403 on the query string.
    const { status, data: page2 } = await aliceGet(page1.next)
    assert.equal(status, 200)
    assert.equal(page2.items[0].id, 'f2')
  })
})
