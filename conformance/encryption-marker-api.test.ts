/**
 * WAS conformance tests — Collection client-side encryption marker
 * Using Node.js test runner
 * @see https://nodejs.org/api/test.html
 *
 * Wire-contract coverage for the non-secret `encryption` marker (spec
 * "Encrypted Collections"): the server persists and echoes it, validates its
 * shape, enforces set-once immutability, and -- crucially -- a delegated
 * consumer that did not create the Collection discovers the marker by reading
 * its Description. Raw `rootClient.request()` is used to send/inspect the marker
 * (the published high-level client does not yet forward `encryption`).
 */
import { it, describe, before, after } from 'node:test'
import assert from 'node:assert'

import { Collection } from '@interop/was-client'

import {
  buildZcapClients,
  createSpace,
  generateId,
  serverUrl
} from './helpers.js'

describe('Encryption marker API', () => {
  let alice: any, bob: any

  before(async () => {
    ;({ alice, bob } = await buildZcapClients())
    alice.space1 = { id: generateId() }
    await createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Encryption Space",
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

  /** POSTs a Collection (raw, so an `encryption` marker can be sent). */
  function createCollection(json: object): Promise<any> {
    return alice.rootClient.request({
      url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
      method: 'POST',
      action: 'POST',
      json
    })
  }

  it('[root] persists and echoes the marker on create', async () => {
    const response = await createCollection({
      id: 'vault',
      name: 'Vault',
      encryption: { scheme: 'edv' }
    })
    assert.equal(response.status, 201)
    assert.deepStrictEqual(response.data.encryption, { scheme: 'edv' })

    const read = await alice.rootClient.request({
      url: new URL(`/space/${alice.space1.id}/vault`, serverUrl).toString(),
      method: 'GET'
    })
    assert.deepStrictEqual(read.data.encryption, { scheme: 'edv' })
  })

  it('a delegated consumer discovers the marker by reading the Description', async () => {
    // Alice grants Bob read on the vault; Bob -- who did not create it --
    // rebuilds a handle and reads the Description, seeing the marker (this is how
    // a consuming app learns to decrypt with its own keys).
    const zcap = await alice.was
      .space(alice.space1.id)
      .collection('vault')
      .grant({ to: bob.did, actions: ['GET'] })

    const handle = bob.was.fromCapability(zcap)
    assert.ok(handle instanceof Collection)
    const description = (await handle.describe()) as any
    assert.deepStrictEqual(description.encryption, { scheme: 'edv' })
  })

  it('[root] rejects a malformed marker (400 invalid-request-body)', async () => {
    let expectedError: any
    try {
      await createCollection({ id: 'bad', encryption: { foo: 1 } })
    } catch (err) {
      expectedError = err
    }
    assert.ok(
      expectedError,
      'expected the malformed-marker create to be rejected'
    )
    assert.equal(expectedError.response.status, 400)
    assert.equal(
      expectedError.data.type,
      'https://wallet.storage/spec#invalid-request-body'
    )
  })

  it('[root] rejects changing an existing marker (409 encryption-immutable)', async () => {
    let expectedError: any
    try {
      await alice.rootClient.request({
        url: new URL(`/space/${alice.space1.id}/vault`, serverUrl).toString(),
        method: 'PUT',
        action: 'PUT',
        json: { id: 'vault', encryption: { scheme: 'other' } }
      })
    } catch (err) {
      expectedError = err
    }
    assert.ok(expectedError, 'expected the marker change to be rejected')
    assert.equal(expectedError.response.status, 409)
    assert.equal(
      expectedError.data.type,
      'https://wallet.storage/spec#encryption-immutable'
    )
  })
})
