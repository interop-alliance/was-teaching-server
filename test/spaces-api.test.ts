/**
 * Spaces Repository and Space API unit tests (Vitest).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { Space } from '@interop/was-client'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { startTestServer, zcapClients } from './helpers.js'

describe('Spaces', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    bob: any,
    aliceDelegatedApp: any

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice, aliceDelegatedApp, bob } = await zcapClients({ serverUrl }))
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  describe('Spaces Repository API', () => {
    it('GET /spaces/ without auth headers returns the empty listing (200)', async () => {
      // List Spaces is the spec's exception to 404 masking: an anonymous
      // request is not an error -- it is simply authorized to see no spaces.
      const response = await fetch(new URL('/spaces/', serverUrl))
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type')!, /application\/json/)
      assert.deepStrictEqual(await response.json(), {
        url: '/spaces/',
        totalItems: 0,
        items: []
      })
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
      const space = await alice.was.createSpace({
        id: alice.space1.id,
        name: "Alice's Space #1 (Home)",
        controller: alice.did
      })
      assert.equal(space.id, alice.space1.id)
      assert.deepStrictEqual(await space.describe(), {
        id: alice.space1.id,
        name: "Alice's Space #1 (Home)",
        type: ['Space'],
        controller: alice.did,
        createdBy: alice.did,
        url: `/space/${alice.space1.id}`,
        linkset: `/space/${alice.space1.id}/linkset`
      })
    })

    it('[root] Space linkset advertises the backends-available and quotas relations', async () => {
      const response = await alice.was.request({
        path: `/space/${alice.space1.id}/linkset`,
        method: 'GET'
      })
      assert.equal(response.status, 200)
      const [entry] = (response.data as { linkset: Array<Record<string, any>> })
        .linkset
      assert.deepStrictEqual(
        entry!['https://wallet.storage/spec#backends-available'],
        [
          {
            href: `/space/${alice.space1.id}/backends`,
            type: 'application/json'
          }
        ]
      )
      assert.deepStrictEqual(entry!['https://wallet.storage/spec#quotas'], [
        { href: `/space/${alice.space1.id}/quotas`, type: 'application/json' }
      ])
    })

    it('POST /spaces/ with an existing id yields id-conflict (409)', async () => {
      const spaceId = crypto.randomUUID()
      await alice.was.createSpace({
        id: spaceId,
        name: 'Conflict Test Space',
        controller: alice.did
      })

      let expectedError: any
      try {
        await alice.was.request({
          url: new URL('/spaces/', serverUrl).toString(),
          method: 'POST',
          json: { id: spaceId, name: 'Replacement', controller: alice.did }
        })
      } catch (error) {
        expectedError = error
      }
      assert.ok(expectedError, 'expected the duplicate-id POST to be rejected')
      assert.equal(expectedError.response.status, 409)
      assert.equal(
        expectedError.data.type,
        'https://wallet.storage/spec#id-conflict'
      )
      assert.equal(expectedError.data.errors[0].pointer, '#/id')
    })

    it("POST /spaces/ cannot overwrite another controller's Space", async () => {
      const spaceId = crypto.randomUUID()
      await alice.was.createSpace({
        id: spaceId,
        name: "Alice's Space",
        controller: alice.did
      })

      // Bob signs with his own key and supplies his own controller -- before
      // the existence check, Create Space verified against the body's
      // controller, so this request silently replaced Alice's Space
      // (controller included).
      let expectedError: any
      try {
        await bob.was.request({
          url: new URL('/spaces/', serverUrl).toString(),
          method: 'POST',
          json: { id: spaceId, name: 'Hijacked', controller: bob.did }
        })
      } catch (error) {
        expectedError = error
      }
      assert.ok(expectedError, 'expected the takeover POST to be rejected')
      assert.equal(expectedError.response.status, 409)

      // Alice's description (controller included) is untouched.
      const description = await alice.was.space(spaceId).describe()
      assert.equal(description.controller, alice.did)
      assert.equal(description.name, "Alice's Space")
    })

    it('[root] create space by id via PUT', async () => {
      const space = alice.was.space(alice.space2.id)
      // configure() upserts the space by id (PUT).
      await space.configure({
        name: "Alice's Space #2 (School)",
        controller: alice.did
      })
      assert.notEqual(await space.describe(), null)
    })

    it('[root] the Create Space 201 body carries the same createdBy a later GET returns', async () => {
      const spaceId = crypto.randomUUID()
      const response = await alice.was.request({
        url: new URL('/spaces/', serverUrl).toString(),
        method: 'POST',
        json: { id: spaceId, name: 'Created Space', controller: alice.did }
      })
      assert.equal(response.status, 201)
      assert.equal(
        (response.data as { createdBy?: string }).createdBy,
        alice.did
      )

      const description = await alice.was.space(spaceId).describe()
      assert.equal(description?.createdBy, alice.did)
    })

    it('[root] a PUT whose body carries a forged createdBy does not change the stored value', async () => {
      const spaceId = crypto.randomUUID()
      await alice.was.createSpace({
        id: spaceId,
        name: 'Forged createdBy Space',
        controller: alice.did
      })

      await alice.was.request({
        url: new URL(`/space/${spaceId}`, serverUrl).toString(),
        method: 'PUT',
        json: {
          name: 'Renamed',
          controller: alice.did,
          createdBy: 'did:key:zEVIL'
        }
      })

      const description = await alice.was.space(spaceId).describe()
      assert.equal(description?.createdBy, alice.did)
      assert.equal(description?.name, 'Renamed')
    })

    it('GET a space with no auth headers falls through to policy and 404s (no public policy)', async () => {
      // Reads no longer 401 at the hook: an anonymous read is allowed to attempt,
      // and is denied as 404 (no-leak) when no access-control policy grants it.
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

    it('describing a not-found space returns null (404 conflation)', async () => {
      const missing = await alice.was
        .space('space-id-that-does-not-exist')
        .describe()
      assert.equal(missing, null)
    })

    it('[root] read space via GET with proper authorization', async () => {
      const spaceDescription = await alice.was.space(alice.space1.id).describe()
      assert.deepStrictEqual(spaceDescription, {
        id: alice.space1.id,
        name: "Alice's Space #1 (Home)",
        type: ['Space'],
        controller: alice.did,
        createdBy: alice.did,
        url: `/space/${alice.space1.id}`,
        linkset: `/space/${alice.space1.id}/linkset`
      })
    })

    it('[delegated] authorized app should GET /space/:spaceId', async () => {
      // First, Alice (re-)provisions the Space -- via the idempotent PUT path,
      // since POSTing an existing id now yields `id-conflict` (409).
      const space = alice.was.space(alice.space1.id)
      await space.configure({
        name: "Alice's Space #1 (Home)",
        controller: alice.did
      })

      // Alice delegates GET access on the space to the app.
      const zcap = await space.grant({
        to: aliceDelegatedApp.did,
        actions: ['GET']
      })

      // Alice's app rebuilds a handle from the capability and reads the space.
      const handle = aliceDelegatedApp.was.fromCapability(zcap)
      assert.ok(handle instanceof Space)
      assert.deepStrictEqual(await handle.describe(), {
        id: alice.space1.id,
        name: "Alice's Space #1 (Home)",
        type: ['Space'],
        controller: alice.did,
        createdBy: alice.did,
        url: `/space/${alice.space1.id}`,
        linkset: `/space/${alice.space1.id}/linkset`
      })
    })

    it('[root] Bob should not be able to GET Alice space', async () => {
      // First, Alice (re-)provisions the Space -- via the idempotent PUT path,
      // since POSTing an existing id now yields `id-conflict` (409).
      await alice.was.space(alice.space1.id).configure({
        name: "Alice's Space #1 (Home)",
        controller: alice.did
      })

      // Bob reads with his own client and gets null (404 conflated: not-found
      // vs unauthorized), so the space's existence is not revealed.
      const seenByBob = await bob.was.space(alice.space1.id).describe()
      assert.equal(seenByBob, null)
    })

    it('[root] Alice should be able to DELETE her provisioned space', async () => {
      // First, create the space
      const space = await alice.was.createSpace({
        id: 'a-space-to-delete',
        name: "Alice's Test Space to be deleted",
        controller: alice.did
      })

      // Now delete the space
      await space.delete()

      // Check that the space was deleted (reads return null on 404).
      assert.equal(await space.describe(), null)
    })
  })

  describe('Create Space chain of authorization', () => {
    // The spec defines Create Space (POST and create-via-PUT) authorization as
    // *authorized by* the body's controller: signed directly by it, or via a
    // delegation chain rooted in it (delegated provisioning). A request bound
    // to neither is rejected with `controller-mismatch` (400).

    /**
     * Performs a signed request expected to fail, returning the thrown error.
     *
     * @param options {object}
     * @param options.client {WasClient}
     * @param options.request {object}   `was.request()` input
     * @returns {Promise<any>}
     */
    async function requestError({
      client,
      request
    }: {
      client: any
      request: object
    }): Promise<any> {
      try {
        await client.request(request)
      } catch (err) {
        return err
      }
      assert.fail('expected the request to be rejected')
    }

    it('[root] POST signed by a different DID than the body controller yields controller-mismatch (400)', async () => {
      // Bob signs a bare-root invocation but names Alice as the controller:
      // Alice has authorized nothing, so this must be rejected.
      const spaceId = crypto.randomUUID()
      const expectedError = await requestError({
        client: bob.was,
        request: {
          url: new URL('/spaces/', serverUrl).toString(),
          method: 'POST',
          json: { id: spaceId, name: 'Unconsented', controller: alice.did }
        }
      })
      assert.equal(expectedError.response.status, 400)
      assert.equal(
        expectedError.data.type,
        'https://wallet.storage/spec#controller-mismatch'
      )
      assert.equal(expectedError.data.errors[0].pointer, '#/controller')

      // The Space was not created: its named controller cannot read it.
      assert.equal(await alice.was.space(spaceId).describe(), null)
    })

    it("[delegated] a provisioning service creates a Space on Alice's behalf via POST", async () => {
      // Alice delegates a POST /spaces/ capability to her provisioning app...
      const spacesUrl = new URL('/spaces/', serverUrl).toString()
      const zcap = await alice.was.grant({
        to: aliceDelegatedApp.did,
        actions: ['POST'],
        target: spacesUrl
      })

      // ...and the app creates a Space that Alice controls from the start.
      const spaceId = crypto.randomUUID()
      const response = await aliceDelegatedApp.was.request({
        url: spacesUrl,
        method: 'POST',
        capability: zcap,
        json: {
          id: spaceId,
          name: 'Provisioned for Alice',
          controller: alice.did
        }
      })
      assert.equal(response.status, 201)
      assert.equal(response.data.controller, alice.did)

      // The stored controller is Alice's DID: her root key reads the Space.
      const description = await alice.was.space(spaceId).describe()
      assert.equal(description?.controller, alice.did)
      assert.equal(description?.name, 'Provisioned for Alice')
    })

    it('[delegated] a POST chain not rooted in the body controller yields controller-mismatch (400)', async () => {
      // The app holds a capability delegated by Alice, but names Bob as the
      // controller: the chain is not rooted in Bob, so Bob has consented to
      // nothing.
      const spacesUrl = new URL('/spaces/', serverUrl).toString()
      const zcap = await alice.was.grant({
        to: aliceDelegatedApp.did,
        actions: ['POST'],
        target: spacesUrl
      })

      const spaceId = crypto.randomUUID()
      const expectedError = await requestError({
        client: aliceDelegatedApp.was,
        request: {
          url: spacesUrl,
          method: 'POST',
          capability: zcap,
          json: { id: spaceId, name: 'Squatted on Bob', controller: bob.did }
        }
      })
      assert.equal(expectedError.response.status, 400)
      assert.equal(
        expectedError.data.type,
        'https://wallet.storage/spec#controller-mismatch'
      )
      assert.equal(await bob.was.space(spaceId).describe(), null)
    })

    it('[root] create-via-PUT signed by a different DID than the body controller yields controller-mismatch (400)', async () => {
      // The consent gap this closes: a PUT create used to verify against the
      // signer, never tying the invocation to the body's controller.
      const spaceId = crypto.randomUUID()
      const expectedError = await requestError({
        client: bob.was,
        request: {
          url: new URL(`/space/${spaceId}`, serverUrl).toString(),
          method: 'PUT',
          json: { name: 'Unconsented', controller: alice.did }
        }
      })
      assert.equal(expectedError.response.status, 400)
      assert.equal(
        expectedError.data.type,
        'https://wallet.storage/spec#controller-mismatch'
      )
      assert.equal(await alice.was.space(spaceId).describe(), null)
    })

    it('[root] PUT whose body id does not match the URL space id yields invalid-request-body (400)', async () => {
      // The Space `id` is immutable: a PUT body that carries a non-matching
      // `id` is rejected before any controller/capability check.
      const spaceId = crypto.randomUUID()
      const expectedError = await requestError({
        client: alice.was,
        request: {
          url: new URL(`/space/${spaceId}`, serverUrl).toString(),
          method: 'PUT',
          json: { id: crypto.randomUUID(), controller: alice.did }
        }
      })
      assert.equal(expectedError.response.status, 400)
      assert.equal(
        expectedError.data.type,
        'https://wallet.storage/spec#invalid-request-body'
      )
      assert.equal(expectedError.data.errors[0].pointer, '#/id')

      // The Space was not created.
      assert.equal(await alice.was.space(spaceId).describe(), null)
    })

    it("[delegated] a provisioning service creates a Space on Alice's behalf via PUT", async () => {
      // Alice delegates a PUT capability for the (not yet existing) Space URL.
      const spaceId = crypto.randomUUID()
      const spaceUrl = new URL(`/space/${spaceId}`, serverUrl).toString()
      const zcap = await alice.was.grant({
        to: aliceDelegatedApp.did,
        actions: ['PUT'],
        target: spaceUrl
      })

      const response = await aliceDelegatedApp.was.request({
        url: spaceUrl,
        method: 'PUT',
        capability: zcap,
        json: { name: 'Provisioned by PUT', controller: alice.did }
      })
      assert.equal(response.status, 201)

      const description = await alice.was.space(spaceId).describe()
      assert.equal(description?.controller, alice.did)
      assert.equal(description?.name, 'Provisioned by PUT')
    })

    it('[delegated] a PUT-create chain not rooted in the body controller yields controller-mismatch (400)', async () => {
      const spaceId = crypto.randomUUID()
      const spaceUrl = new URL(`/space/${spaceId}`, serverUrl).toString()
      const zcap = await alice.was.grant({
        to: aliceDelegatedApp.did,
        actions: ['PUT'],
        target: spaceUrl
      })

      const expectedError = await requestError({
        client: aliceDelegatedApp.was,
        request: {
          url: spaceUrl,
          method: 'PUT',
          capability: zcap,
          json: { name: 'Squatted on Bob', controller: bob.did }
        }
      })
      assert.equal(expectedError.response.status, 400)
      assert.equal(
        expectedError.data.type,
        'https://wallet.storage/spec#controller-mismatch'
      )
      assert.equal(await bob.was.space(spaceId).describe(), null)
    })

    it('[root] an update still verifies against the stored controller, not the body', async () => {
      // Once the Space exists, only the *stored* controller (or its delegate)
      // may update it -- the body's controller is just the proposed new value.
      // Bob cannot seize Alice's Space by PUTting it with himself as the
      // controller (masked as 404, per the error-handling privacy invariant).
      const spaceId = crypto.randomUUID()
      await alice.was.createSpace({
        id: spaceId,
        name: "Alice's Space",
        controller: alice.did
      })

      const expectedError = await requestError({
        client: bob.was,
        request: {
          url: new URL(`/space/${spaceId}`, serverUrl).toString(),
          method: 'PUT',
          json: { name: 'Seized', controller: bob.did }
        }
      })
      assert.equal(expectedError.response.status, 404)

      const description = await alice.was.space(spaceId).describe()
      assert.equal(description?.controller, alice.did)
      assert.equal(description?.name, "Alice's Space")
    })
  })

  describe('List Spaces (GET /spaces/)', () => {
    // The suite's server is shared across tests, so the listings below assert
    // containment / exclusion of known spaces rather than exact contents.

    it('[root] a controller lists only their own spaces', async () => {
      const aliceSpaceId = crypto.randomUUID()
      const bobSpaceId = crypto.randomUUID()
      await alice.was.createSpace({
        id: aliceSpaceId,
        name: 'Alice Listing Test',
        controller: alice.did
      })
      await bob.was.createSpace({
        id: bobSpaceId,
        name: 'Bob Listing Test',
        controller: bob.did
      })

      const listing = await alice.was.listSpaces()
      assert.equal(listing.url, '/spaces/')
      assert.equal(listing.totalItems, listing.items.length)
      assert.deepStrictEqual(
        listing.items.find((item: any) => item.id === aliceSpaceId),
        {
          id: aliceSpaceId,
          name: 'Alice Listing Test',
          url: `/space/${aliceSpaceId}`
        }
      )
      // Bob's space is invisible to Alice...
      assert.ok(!listing.items.some((item: any) => item.id === bobSpaceId))

      // ...and vice versa.
      const bobListing = await bob.was.listSpaces()
      assert.ok(bobListing.items.some((item: any) => item.id === bobSpaceId))
      assert.ok(!bobListing.items.some((item: any) => item.id === aliceSpaceId))
    })

    it('[root] a signer controlling no spaces gets the empty listing', async () => {
      // The delegated app's own DID controls no Space (it only ever acts via
      // delegation), so its bare-root listing is empty -- not an error.
      const listing = await aliceDelegatedApp.was.listSpaces()
      assert.deepStrictEqual(listing, {
        url: '/spaces/',
        totalItems: 0,
        items: []
      })
    })

    it("[delegated] an app with a GET /spaces/ capability lists the delegator's spaces", async () => {
      const aliceSpaceId = crypto.randomUUID()
      const bobSpaceId = crypto.randomUUID()
      await alice.was.createSpace({
        id: aliceSpaceId,
        name: 'Delegated Listing Test',
        controller: alice.did
      })
      await bob.was.createSpace({
        id: bobSpaceId,
        name: 'Bob Bystander Space',
        controller: bob.did
      })

      // Alice delegates List Spaces to her app...
      const spacesUrl = new URL('/spaces/', serverUrl).toString()
      const zcap = await alice.was.grant({
        to: aliceDelegatedApp.did,
        actions: ['GET'],
        target: spacesUrl
      })

      // ...and the app sees the spaces of the chain's root (Alice), no others.
      const response = await aliceDelegatedApp.was.request({
        url: spacesUrl,
        method: 'GET',
        capability: zcap
      })
      assert.equal(response.status, 200)
      const listing = response.data
      assert.equal(listing.totalItems, listing.items.length)
      assert.ok(listing.items.some((item: any) => item.id === aliceSpaceId))
      assert.ok(
        !listing.items.some((item: any) => item.id === bobSpaceId),
        "a chain rooted in Alice must not reveal Bob's spaces"
      )
    })
  })

  describe('Space Backends (/backends)', () => {
    // The single server-configured filesystem backend, registered as `default`.
    const defaultBackendDescriptor = {
      id: 'default',
      name: 'Server Filesystem',
      managedBy: 'server',
      storageMode: ['document', 'blob'],
      persistence: 'durable',
      features: [
        'conditional-writes',
        'changes-query',
        'blinded-index-query',
        'equality-query',
        'key-epochs',
        'chunked-streams'
      ]
    }

    it('[signed] GET /backends lists the default backend descriptor', async () => {
      const spaceId = crypto.randomUUID()
      await alice.was.createSpace({
        id: spaceId,
        name: 'Backends Test Space',
        controller: alice.did
      })

      const response = await alice.was.request({
        url: `${serverUrl}/space/${spaceId}/backends`,
        method: 'GET'
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type')!, /application\/json/)
      assert.deepStrictEqual(response.data, [defaultBackendDescriptor])
    })

    it('[signed] GET /backends surfaces the conditional-writes features array', async () => {
      const spaceId = crypto.randomUUID()
      await alice.was.createSpace({
        id: spaceId,
        name: 'Backends Feature Space',
        controller: alice.did
      })

      const response = await alice.was.request({
        url: `${serverUrl}/space/${spaceId}/backends`,
        method: 'GET'
      })
      assert.equal(response.status, 200)
      // The filesystem backend implements the conditional-writes affordance
      // (ETag / If-Match optimistic concurrency), the `changes-query`
      // replication change feed, the `blinded-index-query` EDV query profile,
      // the `equality-query` plaintext equality profile, and the `key-epochs`
      // multi-recipient-encryption affordance; it advertises every token.
      assert.ok(Array.isArray(response.data[0].features))
      assert.deepStrictEqual(response.data[0].features, [
        'conditional-writes',
        'changes-query',
        'blinded-index-query',
        'equality-query',
        'key-epochs',
        'chunked-streams'
      ])
    })

    it('anonymous GET /backends of a private space 404s (no leak)', async () => {
      const spaceId = crypto.randomUUID()
      await alice.was.createSpace({
        id: spaceId,
        name: 'Private Backends Space',
        controller: alice.did
      })

      const response = await fetch(
        new URL(`/space/${spaceId}/backends`, serverUrl)
      )
      assert.equal(response.status, 404)
    })

    it('anonymous GET /backends of a PublicCanRead space succeeds', async () => {
      const spaceId = crypto.randomUUID()
      const space = await alice.was.createSpace({
        id: spaceId,
        name: 'Public Backends Space',
        controller: alice.did
      })
      await space.setPublic()

      const response = await fetch(
        new URL(`/space/${spaceId}/backends`, serverUrl)
      )
      assert.equal(response.status, 200)
      const backends = (await response.json()) as unknown[]
      assert.deepStrictEqual(backends, [defaultBackendDescriptor])
    })
  })
})
