/**
 * Access-control policy API tests (Vitest): public-read fallback, hierarchical
 * (most-specific-wins) resolution, fail-closed unknown types, the privileged
 * policy CRUD endpoints, linkset discovery, and reserved-name guarding.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import type { Space, Collection } from '@interop/was-client'

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { zcapClients } from './helpers.js'

describe('Access-control policy API', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    bob: any,
    aliceSpace: Space,
    publicCollection: Collection
  const PORT = 7769

  // Path of a JSON resource that lives inside the public collection.
  const publicResourcePath = () =>
    `/space/${alice.space1.id}/public-credentials/public-vc`

  beforeAll(async () => {
    serverUrl = `http://localhost:${PORT}`
    ;({ alice, bob } = await zcapClients({ serverUrl }))
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    fastify = createApp({
      serverUrl,
      backend: new FileSystemBackend({ dataDir })
    })
    await fastify.listen({ port: PORT })

    // Provision the Space + a 'public-credentials' Collection with one resource.
    aliceSpace = await alice.was.createSpace({
      id: alice.space1.id,
      name: "Alice's Space #1 (Home)",
      controller: alice.did
    })
    publicCollection = await aliceSpace.createCollection({
      id: 'public-credentials',
      name: 'Public Credentials'
    })
    await publicCollection.put('public-vc', {
      id: 'public-vc',
      name: 'A shared Verifiable Credential'
    })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('anonymous GET of a resource with no policy is denied (404)', async () => {
    const response = await fetch(new URL(publicResourcePath(), serverUrl))
    assert.equal(response.status, 404)
  })

  it('[controller] collection.setPublic() sets a PublicCanRead policy', async () => {
    await publicCollection.setPublic()
    assert.deepEqual(await publicCollection.getPolicy(), {
      type: 'PublicCanRead'
    })
  })

  it('anonymous GET of a resource in a PublicCanRead collection succeeds (200)', async () => {
    const response = await fetch(new URL(publicResourcePath(), serverUrl))
    assert.equal(response.status, 200)
    const body = (await response.json()) as { name: string }
    assert.equal(body.name, 'A shared Verifiable Credential')
  })

  it('a caller whose capability does not authorize falls back to policy (200)', async () => {
    // Bob signs the request, but he is not the Space controller, so his
    // capability does not verify. The PublicCanRead policy grants the read.
    const response = await bob.was.request({
      path: publicResourcePath(),
      method: 'GET'
    })
    assert.equal(response.status, 200)
  })

  it('anonymous write is still rejected (401) even on a public collection', async () => {
    const response = await fetch(new URL(publicResourcePath(), serverUrl), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'anon write' })
    })
    assert.equal(response.status, 401)
  })

  it('PublicCanRead does not make collection writes public (anonymous POST 401)', async () => {
    const response = await fetch(
      new URL(`/space/${alice.space1.id}/public-credentials/`, serverUrl),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'anon create' })
      }
    )
    assert.equal(response.status, 401)
  })

  it('an unknown policy type is fail-closed (anonymous GET 404)', async () => {
    // Set a private collection with an unrecognized policy type.
    const closed = await aliceSpace.createCollection({
      id: 'closed-collection',
      name: 'Closed Collection'
    })
    await closed.put('secret', { id: 'secret', name: 'secret' })
    // setPolicy() is the generic primitive (any extensible `type`).
    await closed.setPolicy({ type: 'SomethingUnsupported' })

    const response = await fetch(
      new URL(`/space/${alice.space1.id}/closed-collection/secret`, serverUrl)
    )
    assert.equal(response.status, 404)
  })

  it('a resource-level policy overrides a (missing) collection policy', async () => {
    // 'closed-collection' has a fail-closed policy; grant just one resource.
    await aliceSpace
      .collection('closed-collection')
      .resource('secret')
      .setPublic()
    const response = await fetch(
      new URL(`/space/${alice.space1.id}/closed-collection/secret`, serverUrl)
    )
    assert.equal(response.status, 200)
  })

  it('a space-level PublicCanRead policy is inherited by collections and resources', async () => {
    // Use a fresh Space so the space-wide policy does not affect other tests.
    const inheritedSpaceId = crypto.randomUUID()
    const space = await alice.was.createSpace({
      id: inheritedSpaceId,
      name: 'Inherited Public Space',
      controller: alice.did
    })
    const collection = await space.createCollection({
      id: 'docs',
      name: 'Docs'
    })
    await collection.put('readme', { id: 'readme', name: 'Read Me' })

    // Sanity check: with no policy anywhere, the resource is private (404).
    const beforeResponse = await fetch(
      new URL(`/space/${inheritedSpaceId}/docs/readme`, serverUrl)
    )
    assert.equal(beforeResponse.status, 404)

    // Set ONLY a space-level policy -- no collection- or resource-level policy.
    await space.setPublic()

    // The resource inherits the space policy (anonymous GET succeeds).
    const resourceResponse = await fetch(
      new URL(`/space/${inheritedSpaceId}/docs/readme`, serverUrl)
    )
    assert.equal(resourceResponse.status, 200)
    const body = (await resourceResponse.json()) as { name: string }
    assert.equal(body.name, 'Read Me')

    // The collection description and listing inherit it too.
    const describeResponse = await fetch(
      new URL(`/space/${inheritedSpaceId}/docs`, serverUrl)
    )
    assert.equal(describeResponse.status, 200)
    const listResponse = await fetch(
      new URL(`/space/${inheritedSpaceId}/docs/`, serverUrl)
    )
    assert.equal(listResponse.status, 200)
  })

  it('reading/writing the policy resource itself requires auth (401)', async () => {
    const getResponse = await fetch(
      new URL(`/space/${alice.space1.id}/public-credentials/policy`, serverUrl)
    )
    assert.equal(getResponse.status, 401)

    const deleteResponse = await fetch(
      new URL(`/space/${alice.space1.id}/public-credentials/policy`, serverUrl),
      { method: 'DELETE' }
    )
    assert.equal(deleteResponse.status, 401)
  })

  it('the collection linkset advertises the policy resource', async () => {
    // The collection is public, so its linkset is discoverable anonymously.
    const response = await fetch(
      new URL(`/space/${alice.space1.id}/public-credentials/linkset`, serverUrl)
    )
    assert.equal(response.status, 200)
    assert.match(
      response.headers.get('content-type')!,
      /application\/linkset\+json/
    )
    const body = (await response.json()) as {
      linkset: Array<Record<string, any>>
    }
    const entry = body.linkset[0]!
    assert.equal(entry.anchor, `/space/${alice.space1.id}/public-credentials`)
    assert.equal(
      entry['https://wallet.storage/spec#policy'][0].href,
      `/space/${alice.space1.id}/public-credentials/policy`
    )
  })

  it('[controller] collection.clearPolicy() revokes public access (404)', async () => {
    await publicCollection.clearPolicy()
    assert.equal(await publicCollection.getPolicy(), null)

    const response = await fetch(new URL(publicResourcePath(), serverUrl))
    assert.equal(response.status, 404)
  })

  it('reserved ids (policy, linkset) cannot be used as collection ids (400)', async () => {
    // Use the raw request escape hatch: the high-level client rejects reserved
    // ids before sending, so this exercises the server-side guard. The escape
    // hatch throws on non-2xx, so assert via the thrown response.
    for (const reserved of ['policy', 'linkset']) {
      let thrown: any
      try {
        await alice.was.request({
          path: `/space/${alice.space1.id}/`,
          method: 'POST',
          json: { id: reserved, name: reserved }
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, `expected reserved id "${reserved}" to be rejected`)
      assert.equal(thrown.response.status, 400)
    }
  })
})
