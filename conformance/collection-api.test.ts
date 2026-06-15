/**
 * WAS conformance tests — Collections API
 * Using Node.js test runner
 * @see https://nodejs.org/api/test.html
 */
import { it, describe, before, after } from 'node:test'
import assert from 'node:assert'

import {
  buildZcapClients,
  createSpace,
  generateId,
  serverUrl
} from './helpers.js'

describe('Collections API', () => {
  let alice: any

  before(async () => {
    ;({ alice } = await buildZcapClients())
    alice.space1 = { id: generateId() }
    await createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Space #1",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
  })

  after(async () => {
    try {
      await alice.rootClient.request({
        url: new URL(`/space/${alice.space1.id}`, serverUrl).toString(),
        method: 'DELETE'
      })
    } catch {
      /* best-effort cleanup */
    }
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

  it('POST /space/:spaceId/ should 404 error on not found space id', async () => {
    const spaceUrl = new URL(
      '/space/space-id-that-does-not-exist/',
      serverUrl
    ).toString()
    let expectedError: any
    try {
      await alice.rootClient.request({
        url: spaceUrl,
        method: 'POST',
        action: 'POST'
      })
    } catch (err) {
      expectedError = err
    }
    assert.equal(expectedError.response.status, 404)
    assert.match(
      expectedError.response.headers.get('content-type'),
      /application\/problem\+json/
    )
  })

  it('[root] create collection via POST', async () => {
    const body = { id: 'credentials', name: 'Verifiable Credentials' }
    const response = await alice.rootClient.request({
      url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
      method: 'POST',
      action: 'POST',
      json: body
    })
    assert.equal(response.status, 201)
    assert.deepStrictEqual(response.data, {
      id: 'credentials',
      name: 'Verifiable Credentials',
      type: ['Collection'],
      backend: { id: 'default' }
    })
    assert.match(response.headers.get('content-type'), /application\/json/)
    assert.equal(
      response.headers.get('location'),
      `${serverUrl}/space/${alice.space1.id}/${body.id}`
    )
  })

  it('[root] POST with an existing collection id yields id-conflict (409)', async () => {
    // 'credentials' was created by the POST test above.
    let expectedError: any
    try {
      await alice.rootClient.request({
        url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
        method: 'POST',
        action: 'POST',
        json: { id: 'credentials', name: 'Replacement' }
      })
    } catch (err) {
      expectedError = err
    }
    assert.ok(expectedError, 'expected the duplicate-id POST to be rejected')
    assert.equal(expectedError.response.status, 409)
    assert.equal(
      expectedError.data.type,
      'https://wallet.storage/spec#id-conflict'
    )
  })

  it('[root] list collection items via GET :collectionId/', async () => {
    const response = await alice.rootClient.request({
      url: new URL(
        `/space/${alice.space1.id}/credentials/`,
        serverUrl
      ).toString(),
      method: 'GET'
    })
    assert.equal(response.status, 200)
    const listResponse = response.data
    assert.equal(listResponse.id, 'credentials')
    assert.equal(listResponse.url, `/space/${alice.space1.id}/credentials`)
    assert.equal(listResponse.name, 'Verifiable Credentials')
    assert.deepStrictEqual(listResponse.type, ['Collection'])
    assert.equal(typeof listResponse.totalItems, 'number')
    assert.ok(Array.isArray(listResponse.items))
    assert.equal(listResponse.totalItems, listResponse.items.length)
  })

  it('[root] get collection description via GET :collectionId', async () => {
    const response = await alice.rootClient.request({
      url: new URL(
        `/space/${alice.space1.id}/credentials`,
        serverUrl
      ).toString(),
      method: 'GET',
      action: 'GET'
    })
    assert.equal(response.status, 200)
    assert.deepStrictEqual(response.data, {
      id: 'credentials',
      name: 'Verifiable Credentials',
      type: ['Collection'],
      backend: { id: 'default' },
      url: `/space/${alice.space1.id}/credentials`,
      linkset: `/space/${alice.space1.id}/credentials/linkset`
    })
  })

  it('[root] paginates List Collection via ?limit and follows next (spec Pagination)', async () => {
    // Fresh Collection seeded with > one page of Resources, inserted out of order
    // to prove the listing order is by id, not insertion.
    const collectionId = generateId()
    // WAS does not auto-create parent Collections, so provision it first.
    await alice.rootClient.request({
      url: new URL(
        `/space/${alice.space1.id}/${collectionId}`,
        serverUrl
      ).toString(),
      method: 'PUT',
      json: { id: collectionId, name: 'Paginated Collection' }
    })
    const ids = ['g05', 'g01', 'g04', 'g02', 'g00', 'g03']
    for (const id of ids) {
      await alice.rootClient.request({
        url: new URL(
          `/space/${alice.space1.id}/${collectionId}/${id}`,
          serverUrl
        ).toString(),
        method: 'PUT',
        json: { value: id }
      })
    }

    const seen: string[] = []
    let nextUrl: string | undefined = new URL(
      `/space/${alice.space1.id}/${collectionId}/?limit=2`,
      serverUrl
    ).toString()
    let pages = 0
    while (nextUrl) {
      const response: any = await alice.rootClient.request({
        url: nextUrl,
        method: 'GET'
      })
      assert.equal(response.status, 200)
      pages++
      assert.ok(response.data.items.length <= 2, 'page respects the limit')
      seen.push(...response.data.items.map((item: any) => item.id))
      // `next` is server-relative; follow it verbatim, resolved against serverUrl.
      nextUrl = response.data.next
        ? new URL(response.data.next, serverUrl).toString()
        : undefined
    }

    // 6 items at limit 2 -> 3 pages; the last omits `next` (end-of-list signal).
    assert.equal(pages, 3)
    assert.deepStrictEqual(seen, ['g00', 'g01', 'g02', 'g03', 'g04', 'g05'])
  })

  it('[root] a malformed cursor yields invalid-cursor (400)', async () => {
    let expectedError: any
    try {
      await alice.rootClient.request({
        url: new URL(
          `/space/${alice.space1.id}/credentials/?cursor=not-valid-%%%`,
          serverUrl
        ).toString(),
        method: 'GET'
      })
    } catch (err) {
      expectedError = err
    }
    assert.ok(expectedError, 'expected the malformed cursor to be rejected')
    assert.equal(expectedError.response.status, 400)
    assert.equal(
      expectedError.data.type,
      'https://wallet.storage/spec#invalid-cursor'
    )
  })

  it('[root] create and delete a collection by id', async () => {
    const collectionId = 'new-collection'
    const collectionUrl = new URL(
      `/space/${alice.space1.id}/${collectionId}`,
      serverUrl
    ).toString()
    const body = { id: collectionId, name: 'New Collection' }

    await alice.rootClient.request({
      url: collectionUrl,
      method: 'PUT',
      json: body
    })

    const existResponse = await alice.rootClient.request({
      url: collectionUrl,
      method: 'GET'
    })
    assert.equal(existResponse.status, 200)

    const deleteResponse = await alice.rootClient.request({
      url: collectionUrl,
      method: 'DELETE'
    })
    assert.equal(deleteResponse.status, 204)

    let checkResponse: any
    try {
      await alice.rootClient.request({ url: collectionUrl, method: 'GET' })
    } catch (err: any) {
      checkResponse = err.response
    }
    assert.equal(checkResponse.status, 404)
  })
})
