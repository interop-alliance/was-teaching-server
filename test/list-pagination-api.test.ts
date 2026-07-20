/**
 * Cursor-based pagination tests for the List Collections (`GET
 * /space/:spaceId/collections/`) and List Spaces (`GET /spaces/`) operations
 * (Vitest, spec "Pagination").
 *
 * Signed paginated reads use the raw `was.request` escape hatch with a full URL
 * carrying `?limit`/`cursor`. Authorization tolerance for the query string is
 * exercised too: a `next` link is followed with the same root capability, so it
 * must verify against the bare list target (`allowTargetQuery`).
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

describe('List Collections pagination', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    bob: any,
    aliceSpace: Space

  /** GETs an absolute or server-relative URL with Alice's signed capability. */
  async function aliceGet(url: string): Promise<any> {
    const absolute = new URL(url, serverUrl).toString()
    return alice.was.request({ url: absolute, method: 'GET' })
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

  /**
   * Creates a fresh Space and, in it, a Collection per id (in the given
   * insertion order). Returns the collections-listing path for that Space.
   */
  async function seedSpaceWithCollections(
    spaceId: string,
    collectionIds: string[]
  ): Promise<string> {
    const space = await alice.was.createSpace({
      id: spaceId,
      name: spaceId,
      controller: alice.did
    })
    for (const id of collectionIds) {
      await space.createCollection({ id, name: id })
    }
    return `/space/${spaceId}/collections/`
  }

  it('returns every Collection (no next) when it fits in one page', async () => {
    const listPath = await seedSpaceWithCollections(crypto.randomUUID(), [
      'c-a',
      'c-b',
      'c-c'
    ])
    const { data } = await aliceGet(listPath)
    assert.equal(data.totalItems, 3)
    assert.deepStrictEqual(
      data.items.map((item: any) => item.id),
      ['c-a', 'c-b', 'c-c']
    )
    assert.equal(data.next, undefined)
  })

  it('pages through a multi-page Space, each id exactly once, in order', async () => {
    // Insert shuffled to prove the order is by id, not insertion order.
    const ids = ['g05', 'g01', 'g04', 'g02', 'g00', 'g03']
    const listPath = await seedSpaceWithCollections(crypto.randomUUID(), ids)

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
      // totalItems (when present) is the FULL count, not the page length.
      if (data.totalItems !== undefined) {
        assert.equal(data.totalItems, 6)
      }
      seen.push(...data.items.map((item: any) => item.id))
      url = data.next
    }

    assert.equal(pages, 3)
    assert.deepStrictEqual(seen, ['g00', 'g01', 'g02', 'g03', 'g04', 'g05'])
    assert.equal(new Set(seen).size, seen.length)
  })

  it('the final page (exactly filling the limit) omits next', async () => {
    const listPath = await seedSpaceWithCollections(crypto.randomUUID(), [
      'x1',
      'x2',
      'x3',
      'x4'
    ])
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

  it('default page size applies when limit is absent or non-positive; oversized is clamped', async () => {
    const listPath = await seedSpaceWithCollections(crypto.randomUUID(), [
      'd1',
      'd2',
      'd3'
    ])
    for (const query of [
      '',
      '?limit=0',
      '?limit=-5',
      '?limit=notanumber',
      '?limit=999999'
    ]) {
      const { data } = await aliceGet(`${listPath}${query}`)
      assert.deepStrictEqual(
        data.items.map((item: any) => item.id),
        ['d1', 'd2', 'd3'],
        `query "${query}" should return the whole single page`
      )
      assert.equal(data.next, undefined)
    }
  })

  it('a garbage cursor yields invalid-cursor (400) for an authorized caller', async () => {
    const listPath = await seedSpaceWithCollections(crypto.randomUUID(), [
      'c1',
      'c2'
    ])
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

  it('an unauthorized caller with a (garbage) cursor still gets 404, never 400', async () => {
    const spaceId = crypto.randomUUID()
    await seedSpaceWithCollections(spaceId, ['z1', 'z2'])
    // Bob is not the Space controller and the Space is not public-readable, so
    // authorization fails (merged 404) BEFORE any cursor validation.
    let expectedError: any
    try {
      await bob.was.request({
        url: new URL(
          `/space/${spaceId}/collections/?cursor=garbage%%%`,
          serverUrl
        ).toString(),
        method: 'GET'
      })
    } catch (error) {
      expectedError = error
    }
    assert.ok(expectedError, 'expected the unauthorized read to be rejected')
    assert.equal(expectedError.response.status, 404)
  })

  it('next is followed under the same capability (query does not change the target)', async () => {
    // Prove the `aliceSpace` from beforeAll works too (a distinct target).
    for (const id of ['f1', 'f2', 'f3']) {
      await aliceSpace.createCollection({ id, name: id })
    }
    const listPath = `/space/${alice.space1.id}/collections/`
    const { data: page1 } = await aliceGet(`${listPath}?limit=1`)
    assert.ok(page1.next, 'first page should advertise a next link')
    const { status, data: page2 } = await aliceGet(page1.next)
    assert.equal(status, 200)
    assert.equal(page2.items.length, 1)
  })
})

describe('List Spaces pagination', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    bob: any

  /** GETs an absolute or server-relative URL with the given identity's cap. */
  async function signedGet(identity: any, url: string): Promise<any> {
    return identity.was.request({
      url: new URL(url, serverUrl).toString(),
      method: 'GET'
    })
  }

  // Interleave Alice's and Bob's Spaces by id so the authorized-only scan must
  // skip Bob's between Alice's: Alice owns the even positions, Bob the odd.
  const aliceIds = ['sp-0-alice', 'sp-2-alice', 'sp-4-alice', 'sp-6-alice']
  const bobIds = ['sp-1-bob', 'sp-3-bob', 'sp-5-bob']

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice, bob } = await zcapClients({ serverUrl }))

    for (const id of aliceIds) {
      await alice.was.createSpace({ id, name: id, controller: alice.did })
    }
    for (const id of bobIds) {
      await bob.was.createSpace({ id, name: id, controller: bob.did })
    }
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('a complete unpaginated listing includes totalItems and only the caller own Spaces', async () => {
    const { data } = await signedGet(alice, '/spaces/')
    assert.deepStrictEqual(
      data.items.map((item: any) => item.id),
      aliceIds
    )
    // Complete listing: full count present, no continuation link.
    assert.equal(data.totalItems, aliceIds.length)
    assert.equal(data.next, undefined)
    // Bob's Spaces are invisible to Alice.
    assert.ok(!data.items.some((item: any) => bobIds.includes(item.id)))
  })

  it('pages across interleaved controllers, counting only authorized Spaces', async () => {
    const seen: string[] = []
    let url: string | undefined = '/spaces/?limit=2'
    let pages = 0
    while (url) {
      const { data }: any = await signedGet(alice, url)
      pages++
      assert.ok(
        data.items.length <= 2,
        'page never exceeds the requested limit'
      )
      // Every returned item is Alice's -- Bob's interleaved Spaces never appear.
      assert.ok(data.items.every((item: any) => aliceIds.includes(item.id)))
      seen.push(...data.items.map((item: any) => item.id))
      url = data.next
    }
    // 4 authorized Spaces at limit 2 -> 2 pages, in id order, each once.
    assert.equal(pages, 2)
    assert.deepStrictEqual(seen, aliceIds)
    assert.equal(new Set(seen).size, seen.length)
  })

  it('totalItems is omitted whenever a cursor was used or a next is present', async () => {
    // First page (paginated): next present, totalItems omitted.
    const { data: page1 } = await signedGet(alice, '/spaces/?limit=2')
    assert.ok(page1.next, 'first page should advertise a next link')
    assert.equal(page1.totalItems, undefined)

    // Following the cursor to the final page: no next, but a cursor was used,
    // so totalItems is still omitted.
    const { data: page2 } = await signedGet(alice, page1.next)
    assert.equal(page2.next, undefined)
    assert.equal(page2.totalItems, undefined)
    assert.deepStrictEqual(
      [...page1.items, ...page2.items].map((item: any) => item.id),
      aliceIds
    )
  })

  it('next is followed under the same root capability (query does not change the target)', async () => {
    const { data: page1 } = await signedGet(alice, '/spaces/?limit=1')
    assert.ok(page1.next)
    const { status, data: page2 } = await signedGet(alice, page1.next)
    assert.equal(status, 200)
    assert.equal(page2.items[0].id, aliceIds[1])
  })

  it('an authenticated caller with a garbage cursor gets invalid-cursor (400)', async () => {
    let expectedError: any
    try {
      await signedGet(alice, '/spaces/?cursor=not-valid-base64url-%%%')
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

  it('an anonymous caller with a garbage cursor gets the empty 200, never 400', async () => {
    // No signature at all: the anonymous early-return precedes cursor
    // validation, so a bad cursor is never observed by an unauthorized caller.
    const response = await fetch(
      new URL('/spaces/?cursor=garbage%%%', serverUrl).toString()
    )
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepStrictEqual(body, {
      url: '/spaces/',
      totalItems: 0,
      items: []
    })
  })
})
