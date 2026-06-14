/**
 * WAS conformance tests — Spaces Repository and Space API
 * Using Node.js test runner
 * @see https://nodejs.org/api/test.html
 */
import { it, describe, before, after } from 'node:test'
import assert from 'node:assert'

import {
  buildZcapClients,
  createSpace,
  generateId,
  zcapClient,
  serverUrl
} from './helpers.js'

describe('Spaces', () => {
  let alice: any, aliceDelegatedApp: any, bob: any

  before(async () => {
    ;({ alice, aliceDelegatedApp, bob } = await buildZcapClients())
    alice.space1 = { id: generateId() }
    alice.space2 = { id: generateId() }
    alice.space3 = { id: generateId() }
    // Pre-create alice.space1 so tests that need an existing space are not
    // implicitly coupled to the creation test's ordering
    await createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Space #1 (Home)",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
  })

  after(async () => {
    for (const spaceId of [alice.space1.id, alice.space2.id, alice.space3.id]) {
      try {
        await alice.rootClient.request({
          url: new URL(`/space/${spaceId}`, serverUrl).toString(),
          method: 'DELETE'
        })
      } catch {
        /* best-effort cleanup */
      }
    }
  })

  describe('Spaces Repository API', () => {
    it('GET /spaces/ without auth headers returns the empty listing (200)', async () => {
      // List Spaces is the spec's exception to 404 masking: an anonymous
      // request is not an error -- it is simply authorized to see no spaces.
      const response = await fetch(new URL('/spaces/', serverUrl))
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type')!, /application\/json/)
      const listing = (await response.json()) as any
      assert.equal(listing.url, '/spaces/')
      assert.equal(listing.totalItems, 0)
      assert.deepStrictEqual(listing.items, [])
    })

    it('[root] GET /spaces/ lists only spaces controlled by the requester', async () => {
      // A persistent external server may hold any number of spaces for Alice
      // from earlier runs, so assert containment / exclusion, not contents.
      const bobSpaceId = generateId()
      await createSpace({
        spaceDescription: {
          id: bobSpaceId,
          name: "Bob's Listing Space",
          controller: bob.did
        },
        rootClient: bob.rootClient
      })

      try {
        const response = await alice.rootClient.request({
          url: new URL('/spaces/', serverUrl).toString(),
          method: 'GET'
        })
        assert.equal(response.status, 200)
        const listing = response.data
        assert.equal(listing.url, '/spaces/')
        assert.equal(listing.totalItems, listing.items.length)
        const aliceItem = listing.items.find(
          (item: any) => item.id === alice.space1.id
        )
        assert.ok(aliceItem, "Alice's listing includes her pre-created space")
        assert.equal(aliceItem.url, `/space/${alice.space1.id}`)
        assert.ok(
          !listing.items.some((item: any) => item.id === bobSpaceId),
          "Alice's listing must not reveal Bob's space"
        )
      } finally {
        await bob.rootClient.request({
          url: new URL(`/space/${bobSpaceId}`, serverUrl).toString(),
          method: 'DELETE'
        })
      }
    })

    it('POST /spaces/ should 401 error when no authorization headers', async () => {
      const response = await fetch(new URL('/spaces/', serverUrl), {
        method: 'POST'
      })
      assert.equal(response.status, 401)
      assert.match(
        response.headers.get('content-type')!,
        /application\/problem\+json/
      )
    })
  })

  describe('Space API', () => {
    it('[root] create space via POST', async () => {
      const freshSpaceId = generateId()
      const spaceDescription = {
        id: freshSpaceId,
        name: 'Conformance Test Space',
        controller: alice.did
      }
      const response = await createSpace({
        spaceDescription,
        rootClient: alice.rootClient
      })
      assert.equal(response.status, 201)
      assert.deepStrictEqual(response.data, {
        id: freshSpaceId,
        name: 'Conformance Test Space',
        type: ['Space'],
        controller: alice.did
      })
      assert.match(response.headers.get('content-type')!, /application\/json/)
      assert.equal(
        response.headers.get('location'),
        `${serverUrl}/spaces/${freshSpaceId}`
      )

      // Clean up the space created by this test
      await alice.rootClient.request({
        url: new URL(`/space/${freshSpaceId}`, serverUrl).toString(),
        method: 'DELETE'
      })
    })

    it('[root] POST /spaces/ with an existing id yields id-conflict (409)', async () => {
      // alice.space1 was pre-created in before(). The onboarding-token path of
      // createSpace() returns the status; the zcap path throws on non-2xx --
      // capture either shape.
      let status: number | undefined, problem: any
      try {
        const response = await createSpace({
          spaceDescription: {
            id: alice.space1.id,
            name: 'Duplicate Space',
            controller: alice.did
          },
          rootClient: alice.rootClient
        })
        status = response.status
        problem = response.data
      } catch (err: any) {
        status = err.response?.status
        problem = err.data
      }
      assert.equal(status, 409)
      assert.equal(problem.type, 'https://wallet.storage/spec#id-conflict')
    })

    it('[root] create space by id via PUT', async () => {
      const spaceDescription = {
        id: alice.space2.id,
        name: "Alice's Space #2 (School)",
        controller: alice.did
      }
      const spaceUrl = new URL(
        `/space/${alice.space2.id}`,
        serverUrl
      ).toString()
      const response = await alice.rootClient.request({
        url: spaceUrl,
        method: 'PUT',
        json: spaceDescription
      })

      assert.equal(response.headers.get('location'), spaceUrl)

      const checkResponse = await alice.rootClient.request({
        url: spaceUrl,
        method: 'GET'
      })
      assert.equal(checkResponse.status, 200)
    })

    it('GET a space with no auth headers falls through to policy and 404s (no public policy)', async () => {
      // Reads no longer 401 at the hook: an anonymous read is allowed to
      // attempt, and is denied as 404 (no-leak) when no policy grants it.
      const spaceUrl = new URL(
        `/space/${alice.space1.id}`,
        serverUrl
      ).toString()
      const response = await fetch(spaceUrl, { method: 'GET' })
      assert.equal(response.status, 404)
      assert.match(
        response.headers.get('content-type')!,
        /application\/problem\+json/
      )
    })

    it('GET /space/:spaceId should 404 error on not found space id', async () => {
      const spaceUrl = new URL(
        '/space/space-id-that-does-not-exist',
        serverUrl
      ).toString()
      let expectedError: any
      try {
        await alice.rootClient.request({
          url: spaceUrl,
          method: 'GET',
          action: 'GET'
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

    it('[root] read space via GET with proper authorization', async () => {
      const spaceUrl = new URL(
        `/space/${alice.space1.id}`,
        serverUrl
      ).toString()
      const response = await alice.rootClient.request({
        url: spaceUrl,
        method: 'GET',
        action: 'GET'
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /application\/json/)
      assert.deepStrictEqual(response.data, {
        id: alice.space1.id,
        name: "Alice's Space #1 (Home)",
        type: ['Space'],
        controller: alice.did,
        url: `/space/${alice.space1.id}`,
        linkset: `/space/${alice.space1.id}/linkset`
      })
    })

    it('[delegated] authorized app should GET /space/:spaceId', async () => {
      const aliceAppClient = zcapClient({ signer: aliceDelegatedApp.signer })
      const spaceUrl = new URL(
        `/space/${alice.space1.id}`,
        serverUrl
      ).toString()

      const delegatedSpaceCapability = await alice.rootClient.delegate({
        allowedActions: ['GET'],
        invocationTarget: spaceUrl,
        controller: aliceDelegatedApp.did
      })

      const appResponse = await aliceAppClient.request({
        url: spaceUrl,
        capability: delegatedSpaceCapability,
        method: 'GET',
        action: 'GET'
      })
      assert.equal(appResponse.status, 200)
      assert.match(
        appResponse.headers.get('content-type')!,
        /application\/json/
      )
      assert.deepStrictEqual(appResponse.data, {
        id: alice.space1.id,
        name: "Alice's Space #1 (Home)",
        type: ['Space'],
        controller: alice.did,
        url: `/space/${alice.space1.id}`,
        linkset: `/space/${alice.space1.id}/linkset`
      })
    })

    it('[root] Bob should not be able to GET Alice space', async () => {
      const spaceUrl = new URL(
        `/space/${alice.space1.id}`,
        serverUrl
      ).toString()
      let expectedError: any
      try {
        await bob.rootClient.request({ url: spaceUrl, action: 'GET' })
      } catch (err) {
        expectedError = err
      }
      // Bob gets a 404 instead of a 403 to avoid revealing the space's existence
      assert.equal(expectedError.response.status, 404)
      assert.match(
        expectedError.response.headers.get('content-type'),
        /application\/problem\+json/
      )
    })

    it('[root] Alice should be able to DELETE her provisioned space', async () => {
      const spaceId = generateId()
      await createSpace({
        spaceDescription: {
          id: spaceId,
          name: 'Space to Delete',
          controller: alice.did
        },
        rootClient: alice.rootClient
      })

      const spaceUrl = new URL(`/space/${spaceId}`, serverUrl).toString()
      const deleteResponse = await alice.rootClient.request({
        url: spaceUrl,
        method: 'DELETE'
      })
      assert.equal(deleteResponse.status, 204)

      let checkResponse: any
      try {
        await alice.rootClient.request({ url: spaceUrl, method: 'GET' })
      } catch (err: any) {
        checkResponse = err.response
      }
      assert.equal(checkResponse.status, 404)
    })
  })

  describe('Collections API', () => {
    let collectionId: string, resourceId: string

    before(async () => {
      collectionId = generateId()
      resourceId = generateId()

      await createSpace({
        spaceDescription: {
          id: alice.space3.id,
          name: "Alice's Space #3 (Collections Test)",
          controller: alice.did
        },
        rootClient: alice.rootClient
      })

      await alice.rootClient.request({
        url: new URL(
          `/space/${alice.space3.id}/${collectionId}`,
          serverUrl
        ).toString(),
        method: 'PUT',
        json: { id: collectionId, name: 'Test Collection' }
      })

      await alice.rootClient.request({
        url: new URL(
          `/space/${alice.space3.id}/${collectionId}/${resourceId}`,
          serverUrl
        ).toString(),
        method: 'PUT',
        json: { id: resourceId, name: 'Test Resource' }
      })
    })

    it('[root] GET /space/:spaceId/collections/ lists collections for a space', async () => {
      const collectionsUrl = new URL(
        `/space/${alice.space3.id}/collections/`,
        serverUrl
      ).toString()

      const response = await alice.rootClient.request({
        url: collectionsUrl,
        method: 'GET'
      })

      assert.equal(response.status, 200)
      assert.deepStrictEqual(response.data, {
        url: `/space/${alice.space3.id}/collections/`,
        totalItems: 1,
        items: [
          {
            id: collectionId,
            name: 'Test Collection',
            url: `/space/${alice.space3.id}/${collectionId}`
          }
        ]
      })
    })
  })
})
