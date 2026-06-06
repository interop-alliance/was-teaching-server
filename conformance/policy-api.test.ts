/**
 * WAS conformance tests — Access-control policy (public-read fallback)
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

describe('Access-control policy API', () => {
  let alice: any, bob: any

  const collectionId = 'public-credentials'
  const resourceId = 'public-vc'
  const resourceUrl = () =>
    new URL(
      `/space/${alice.space1.id}/${collectionId}/${resourceId}`,
      serverUrl
    ).toString()
  const policyUrl = () =>
    new URL(
      `/space/${alice.space1.id}/${collectionId}/policy`,
      serverUrl
    ).toString()

  before(async () => {
    ;({ alice, bob } = await buildZcapClients())
    alice.space1 = { id: generateId() }
    await createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Space #1",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    await alice.rootClient.request({
      url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
      method: 'POST',
      json: { id: collectionId, name: 'Public Credentials' }
    })
    await alice.rootClient.request({
      url: resourceUrl(),
      method: 'PUT',
      json: { id: resourceId, name: 'A shared Verifiable Credential' }
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

  it('anonymous GET of a resource with no policy is denied (404)', async () => {
    const response = await fetch(resourceUrl())
    assert.equal(response.status, 404)
  })

  it('[controller] PUT a PublicCanRead policy on the collection (201)', async () => {
    const response = await alice.rootClient.request({
      url: policyUrl(),
      method: 'PUT',
      json: { type: 'PublicCanRead' }
    })
    assert.equal(response.status, 201)
  })

  it('anonymous GET of a resource in a PublicCanRead collection succeeds (200)', async () => {
    const response = await fetch(resourceUrl())
    assert.equal(response.status, 200)
    const body = (await response.json()) as { name: string }
    assert.equal(body.name, 'A shared Verifiable Credential')
  })

  it('a caller whose capability does not authorize falls back to policy (200)', async () => {
    // Bob is not the Space controller, so his capability does not verify; the
    // PublicCanRead policy grants the read.
    const response = await bob.rootClient.request({
      url: resourceUrl(),
      method: 'GET'
    })
    assert.equal(response.status, 200)
  })

  it('anonymous write is still rejected (401) on a public collection', async () => {
    const response = await fetch(resourceUrl(), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'anon write' })
    })
    assert.equal(response.status, 401)
  })

  it('the collection linkset advertises the policy resource', async () => {
    const response = await fetch(
      new URL(`/space/${alice.space1.id}/${collectionId}/linkset`, serverUrl)
    )
    assert.equal(response.status, 200)
    assert.match(
      response.headers.get('content-type')!,
      /application\/linkset\+json/
    )
    const body = (await response.json()) as {
      linkset: Array<Record<string, any>>
    }
    assert.equal(
      body.linkset[0]!['https://wallet.storage/spec#policy'][0].href,
      `/space/${alice.space1.id}/${collectionId}/policy`
    )
  })

  it('[controller] DELETE the policy revokes public access (404)', async () => {
    const del = await alice.rootClient.request({
      url: policyUrl(),
      method: 'DELETE'
    })
    assert.equal(del.status, 204)

    const response = await fetch(resourceUrl())
    assert.equal(response.status, 404)
  })
})
