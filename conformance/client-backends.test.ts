/**
 * WAS conformance tests — high-level WasClient: BYOS backend registration
 * Using Node.js test runner
 * @see https://nodejs.org/api/test.html
 *
 * Drives the published `@interop/was-client` backend-registration control plane
 * (`space.registerBackend` / `updateBackend` / `deregisterBackend`, and
 * selecting a registered backend on a Collection) against a live server, the
 * write side of the spec's "Backends" section. The reference server registers no
 * provider adapters, so a registered `external` backend is selectable but its
 * data plane is inert -- the suite asserts that "registered but not operable"
 * contract too.
 */
import { it, describe, before, after } from 'node:test'
import assert from 'node:assert'

import { ConflictError, ValidationError } from '@interop/was-client'
import type { Space, BackendRegistration } from '@interop/was-client'

import { buildZcapClients } from './helpers.js'

describe('WasClient — BYOS backend registration', () => {
  let alice: any
  const createdSpaces: Space[] = []

  before(async () => {
    ;({ alice } = await buildZcapClients())
  })

  after(async () => {
    for (const space of createdSpaces) {
      try {
        await space.delete()
      } catch {
        /* best-effort cleanup */
      }
    }
  })

  /**
   * Creates a space via the high-level client and registers it for teardown.
   *
   * @param name {string}
   * @returns {Promise<Space>}
   */
  async function newSpace(name: string): Promise<Space> {
    const space = await alice.was.createSpace({ name })
    createdSpaces.push(space)
    return space
  }

  /**
   * A representative registration body. `connection` is deliberately
   * secret-bearing (an OAuth authorization code) so the suite can assert the
   * server never echoes it back on the sanitized read.
   *
   * @param id {string}
   * @returns {BackendRegistration}
   */
  function gdriveRegistration(id: string): BackendRegistration {
    return {
      id,
      name: 'My Google Drive',
      provider: 'google-drive',
      storageMode: ['document', 'blob'],
      connection: {
        kind: 'oauth2-google',
        authorizationCode: 'secret-auth-code',
        scope: 'https://www.googleapis.com/auth/drive.file',
        rootFolderName: 'WAS'
      }
    }
  }

  it('registers a backend and returns a sanitized (secret-free) descriptor', async () => {
    const space = await newSpace('Register Backend')
    const descriptor = await space.registerBackend(
      gdriveRegistration('gdrive-personal')
    )
    assert.equal(descriptor.id, 'gdrive-personal')
    assert.equal(descriptor.name, 'My Google Drive')
    assert.equal(descriptor.managedBy, 'external')
    assert.equal(descriptor.provider, 'google-drive')
    assert.deepStrictEqual(descriptor.storageMode, ['document', 'blob'])
    // The connection is sanitized: public fields surface (and `status` starts at
    // `registered`, since no provider adapter has connected it yet).
    const connection = descriptor.connection
    assert.ok(connection)
    assert.equal(connection.kind, 'oauth2-google')
    assert.equal(connection.status, 'registered')
    assert.equal(connection.scope, 'https://www.googleapis.com/auth/drive.file')
    assert.equal(connection.rootFolderName, 'WAS')
    assert.match(connection.connectedAt ?? '', /^\d{4}-\d{2}-\d{2}T/)
    // The secret-bearing authorization code must never be echoed back anywhere.
    assert.ok(
      !JSON.stringify(descriptor).includes('secret-auth-code'),
      'the sanitized descriptor must not leak the authorization code'
    )
  })

  it('lists the registered backend alongside the server default', async () => {
    const space = await newSpace('List Backends')
    await space.registerBackend(gdriveRegistration('gdrive-personal'))
    const backends = await space.backends()
    assert.ok(backends)
    assert.equal(backends.length, 2)
    assert.ok(backends.some(backend => backend.id === 'default'))
    const gdrive = backends.find(backend => backend.id === 'gdrive-personal')
    assert.ok(gdrive)
    assert.equal(gdrive.provider, 'google-drive')
    assert.equal(gdrive.connection?.status, 'registered')
    // No secret leaks on the list path either.
    assert.ok(!JSON.stringify(gdrive).includes('secret-auth-code'))
  })

  it('rejects a duplicate backend id with ConflictError', async () => {
    const space = await newSpace('Duplicate Backend')
    await space.registerBackend(gdriveRegistration('gdrive-personal'))
    await assert.rejects(
      space.registerBackend(gdriveRegistration('gdrive-personal')),
      (err: unknown) => err instanceof ConflictError
    )
  })

  it('rejects registering the reserved "default" id with ValidationError', async () => {
    const space = await newSpace('Reserved Backend Id')
    await assert.rejects(
      space.registerBackend(gdriveRegistration('default')),
      (err: unknown) => err instanceof ValidationError
    )
  })

  it('updateBackend creates a record (descriptor) then replaces it in place (null)', async () => {
    const space = await newSpace('Update Backend')
    // PUT to a fresh id creates the record -> 201 + sanitized descriptor.
    const created = await space.updateBackend(
      gdriveRegistration('gdrive-personal')
    )
    assert.ok(created)
    assert.equal(created.id, 'gdrive-personal')
    assert.equal(created.connection?.status, 'registered')
    // PUT to the same id replaces it in place -> 204, no body -> null.
    const replaced = await space.updateBackend({
      id: 'gdrive-personal',
      provider: 'google-drive',
      connection: { kind: 'oauth2-google', authorizationCode: 'fresh-code' }
    })
    assert.equal(replaced, null)
  })

  it('selects a registered backend on a Collection (control plane)', async () => {
    const space = await newSpace('Select Backend')
    await space.registerBackend(gdriveRegistration('gdrive-personal'))
    const collection = await space.createCollection({
      id: 'on-gdrive',
      backend: { id: 'gdrive-personal' }
    })
    const description = await collection.describe()
    assert.deepStrictEqual(description?.backend, { id: 'gdrive-personal' })
    // "Collection Backend Selected" resolves to the registered descriptor.
    const backend = await collection.backend()
    assert.equal(backend?.id, 'gdrive-personal')
    assert.equal(backend?.provider, 'google-drive')
  })

  it('a registered backend with no provider adapter is inert (data plane fails closed)', async () => {
    const space = await newSpace('Inert Backend')
    await space.registerBackend(gdriveRegistration('gdrive-personal'))
    const collection = await space.createCollection({
      id: 'on-gdrive',
      backend: { id: 'gdrive-personal' }
    })
    // The reference server registers no provider adapters, so writing a resource
    // to the selected backend fails closed with `unsupported-backend` (409).
    await assert.rejects(
      collection.add({ hello: 'world' }),
      (err: unknown) =>
        err instanceof ConflictError &&
        (err.type ?? '').includes('unsupported-backend')
    )
  })

  it('deregisters a backend and is idempotent', async () => {
    const space = await newSpace('Deregister Backend')
    await space.registerBackend(gdriveRegistration('gdrive-personal'))
    await space.deregisterBackend('gdrive-personal')
    const backends = await space.backends()
    assert.ok(backends)
    assert.ok(!backends.some(backend => backend.id === 'gdrive-personal'))
    // Deregistering again must not throw (idempotent).
    await space.deregisterBackend('gdrive-personal')
  })
})
