/**
 * Update Collection composes the object it persists inside the backend's
 * write, from the stored object read under the lock. A full replacement
 * carries an omitted `plaintext` forward from the stored object; composed
 * against a read made before the lock, a rename racing a `unique` index
 * declaration would carry forward the object that read saw and drop the
 * declaration, with a 204 to both writers. The race is made deterministic by
 * holding the rename's backend write until the declaration has landed.
 *
 * A declaration's scan of the stored Resources runs with no Resource write of
 * the Space in flight (the filesystem Space gate's exclusive side): a Resource
 * write that arrives while the scan runs waits for the declaration to land,
 * then reads it, so it cannot slip a duplicate past the scan. Made
 * deterministic by holding the scan.
 */
import { it, describe, beforeAll, afterAll, afterEach, vi } from 'vitest'
import assert from 'node:assert'
import type { FastifyInstance } from 'fastify'

import type { TempFileSystemBackend } from '../src/testing.js'
import {
  openTempBackend,
  requestError,
  startTestServer,
  zcapClients
} from './helpers.js'

describe('Update Collection composes under the lock', () => {
  let fastify: FastifyInstance,
    baseServerUrl: string,
    alice: any,
    backend: TempFileSystemBackend

  const metaUrl = (collectionId: string) =>
    `${baseServerUrl}space/${alice.space1.id}/${collectionId}/meta`
  const resourceUrl = (collectionId: string, resourceId: string) =>
    `${baseServerUrl}space/${alice.space1.id}/${collectionId}/${resourceId}`

  /**
   * Resolves when a spied backend method is first called, which then runs as
   * it would unspied.
   */
  function firstCallStarted(method: 'writeResource'): Promise<void> {
    const original = backend[method].bind(backend) as (
      ...args: unknown[]
    ) => Promise<unknown>
    let started!: () => void
    const startedOnce = new Promise<void>(resolve => (started = resolve))
    vi.spyOn(backend, method).mockImplementation((async (
      ...args: unknown[]
    ) => {
      started()
      return original(...args)
    }) as any)
    return startedOnce
  }

  /**
   * A gate that holds the first call of a spied backend method until released,
   * running every later call at once.
   */
  function holdFirstCall(
    method: 'writeCollection' | 'findEqualityUniqueViolation'
  ): { held: Promise<void>; release: () => void } {
    const original = backend[method].bind(backend) as (
      ...args: unknown[]
    ) => Promise<unknown>
    let release!: () => void
    const released = new Promise<void>(resolve => (release = resolve))
    let held!: () => void
    const heldOnce = new Promise<void>(resolve => (held = resolve))
    let calls = 0
    vi.spyOn(backend, method).mockImplementation((async (
      ...args: unknown[]
    ) => {
      calls += 1
      if (calls === 1) {
        held()
        await released
      }
      return original(...args)
    }) as any)
    return { held: heldOnce, release }
  }

  beforeAll(async () => {
    backend = await openTempBackend()
    ;({ fastify, baseServerUrl } = await startTestServer({ backend }))
    ;({ alice } = await zcapClients({ baseServerUrl }))
    await alice.pws.createSpace({
      id: alice.space1.id,
      name: "Alice's Space #1 (Home)",
      controller: alice.did
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await fastify.close()
    await backend.close()
  })

  it('an unconditional rename racing a plaintext unique declaration keeps the declaration', async () => {
    const collectionId = 'raced'
    await alice.pws.request({
      url: metaUrl(collectionId),
      method: 'PUT',
      json: { id: collectionId, name: 'before' }
    })

    // The first backend write to arrive (the rename's) waits until released;
    // every later one (the declaration's) runs at once.
    const { held, release } = holdFirstCall('writeCollection')

    const rename = alice.pws.request({
      url: metaUrl(collectionId),
      method: 'PUT',
      json: { id: collectionId, name: 'renamed' }
    })
    await held
    const declared = await alice.pws.request({
      url: metaUrl(collectionId),
      method: 'PUT',
      json: {
        id: collectionId,
        name: 'before',
        plaintext: { indexes: [{ name: 'slug', unique: true }] }
      }
    })
    assert.equal(declared.status, 204)
    release()
    const renamed = await rename
    assert.equal(renamed.status, 204)

    const stored = await alice.pws.request({
      url: metaUrl(collectionId),
      method: 'GET'
    })
    assert.equal(stored.data.name, 'renamed')
    assert.deepStrictEqual(stored.data.plaintext, {
      indexes: [{ name: 'slug', unique: true }]
    })
  })

  it('a Resource write arriving during a unique declaration scan waits for the declaration and is bound by it', async () => {
    const collectionId = 'scanned'
    await alice.pws.request({
      url: metaUrl(collectionId),
      method: 'PUT',
      json: { id: collectionId, name: 'scanned' }
    })
    const holder = await alice.pws.request({
      url: resourceUrl(collectionId, 'holder'),
      method: 'PUT',
      json: { id: 'holder', slug: 'taken' }
    })
    assert.equal(holder.status, 201)

    // The declaration's scan of the stored Resources runs under the exclusive
    // side of the Space gate; hold it there.
    const { held, release } = holdFirstCall('findEqualityUniqueViolation')
    const declared = alice.pws.request({
      url: metaUrl(collectionId),
      method: 'PUT',
      json: {
        id: collectionId,
        name: 'scanned',
        plaintext: { indexes: [{ name: 'slug', unique: true }] }
      }
    })
    await held

    // A duplicate claim arriving mid-scan. The gate keeps it out until the
    // declaration has landed, so it cannot settle while the scan is held, and
    // once admitted it reads the declaration and is refused. The claimant is
    // known to have reached the backend's write (and so the gate) before the
    // check, rather than to be still in request handling.
    const writeStarted = firstCallStarted('writeResource')
    let claimantSettled = false
    const claimant = requestError(
      alice.pws.request({
        url: resourceUrl(collectionId, 'claimant'),
        method: 'PUT',
        json: { id: 'claimant', slug: 'taken' }
      })
    ).then(err => {
      claimantSettled = true
      return err
    })
    await writeStarted
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(claimantSettled, false)

    release()
    const declaration = await declared
    assert.equal(declaration.status, 204)
    const refused = await claimant
    assert.equal(refused.response.status, 409)
    assert.match(refused.data.type, /#id-conflict/)

    // The holder's value is still the only claim; the claimant stored nothing.
    const missing = await requestError(
      alice.pws.request({
        url: resourceUrl(collectionId, 'claimant'),
        method: 'GET'
      })
    )
    assert.equal(missing.response.status, 404)
  })
})
