/**
 * Typed Space Description tests (Vitest): the OPTIONAL `type` array a Space
 * Description carries, its validation on the two create paths, its immutability
 * on update, and the one listing consequence -- an `AuxiliarySpace` is omitted
 * from List Spaces.
 *
 * A Space Description's `type` subtypes `Space`, so every consumer keeps
 * matching on the base `Space` type while a Space declares a more specific role
 * (e.g. `['Space', 'AuxiliarySpace', 'DelegatedClientsSpace']` for a Space
 * holding bookkeeping rather than user data).
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { requestError, startTestServer, zcapClients } from './helpers.js'

/** The auxiliary Space's full type array, as a wallet would send it. */
const AUXILIARY_TYPE = ['Space', 'AuxiliarySpace', 'DelegatedClientsSpace']

/**
 * Reads the HTTP status off a thrown ezcap/ky error, which carries it flat on
 * some paths and nested under `response` on others.
 *
 * @param err {any}   the thrown error
 * @returns {number | undefined}
 */
function statusOf(err: any): number | undefined {
  return err?.status ?? err?.response?.status
}

describe('Space Description type', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    bob: any

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice, bob } = await zcapClients({ serverUrl }))
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  /**
   * POSTs a Space Description to the Spaces Repository, signed by `identity`.
   *
   * @param options {object}
   * @param options.identity {any}   the test identity signing the create
   * @param options.body {object}    the Space Description request body
   * @returns {Promise<any>}
   */
  async function createSpace({
    identity,
    body
  }: {
    identity: any
    body: object
  }): Promise<any> {
    return identity.was.request({
      url: new URL('/spaces/', serverUrl).toString(),
      method: 'POST',
      json: body
    })
  }

  /**
   * PUTs a Space Description by id, signed by `identity`.
   *
   * @param options {object}
   * @param options.identity {any}   the test identity signing the request
   * @param options.spaceId {string}
   * @param options.body {object}    the Space Description request body
   * @returns {Promise<any>}
   */
  async function putSpace({
    identity,
    spaceId,
    body
  }: {
    identity: any
    spaceId: string
    body: object
  }): Promise<any> {
    return identity.was.request({
      url: new URL(`/space/${spaceId}`, serverUrl).toString(),
      method: 'PUT',
      json: body
    })
  }

  describe('Create Space (POST /spaces/)', () => {
    it('stores a supplied type array and serves it lexically sorted', async () => {
      const spaceId = randomUUID()
      const response = await createSpace({
        identity: alice,
        body: {
          id: spaceId,
          name: 'Delegated Clients',
          controller: alice.did,
          type: AUXILIARY_TYPE
        }
      })
      assert.equal(response.status, 201)
      assert.deepStrictEqual(response.data.type, AUXILIARY_TYPE)

      // Get Space serves `type` lexically sorted (spec SHOULD).
      const description = await alice.was.space(spaceId).describe()
      assert.deepStrictEqual(description.type, [
        'AuxiliarySpace',
        'DelegatedClientsSpace',
        'Space'
      ])
    })

    it('defaults the type to ["Space"] when the body carries none', async () => {
      const spaceId = randomUUID()
      const response = await createSpace({
        identity: alice,
        body: { id: spaceId, name: 'Ordinary', controller: alice.did }
      })
      assert.equal(response.status, 201)
      assert.deepStrictEqual(response.data.type, ['Space'])

      const description = await alice.was.space(spaceId).describe()
      assert.deepStrictEqual(description.type, ['Space'])
    })

    const invalidTypes: Array<[string, unknown]> = [
      ['a non-array type', 'Space'],
      ['an object type', { Space: true }],
      ['an empty array', []],
      ['an array missing the base Space type', ['AuxiliarySpace']],
      ['an array with a non-string member', ['Space', 42]],
      ['an array with an empty-string member', ['Space', '']],
      ['a null type', null]
    ]

    for (const [label, type] of invalidTypes) {
      it(`rejects ${label} (400 invalid-request-body, #/type)`, async () => {
        const spaceId = randomUUID()
        const err = await requestError(
          createSpace({
            identity: alice,
            body: { id: spaceId, name: 'Bad Type', controller: alice.did, type }
          })
        )
        assert.equal(statusOf(err), 400)
        assert.equal(
          err.data.type,
          'https://wallet.storage/spec#invalid-request-body'
        )
        assert.equal(err.data.errors[0].pointer, '#/type')

        // Nothing was stored.
        assert.equal(await alice.was.space(spaceId).describe(), null)
      })
    }
  })

  describe('Create Space by id (PUT /space/:spaceId)', () => {
    it('accepts a type array on the create path, like POST', async () => {
      const spaceId = randomUUID()
      const response = await putSpace({
        identity: alice,
        spaceId,
        body: {
          id: spaceId,
          name: 'PUT-created Auxiliary',
          controller: alice.did,
          type: AUXILIARY_TYPE
        }
      })
      assert.equal(response.status, 201)

      const description = await alice.was.space(spaceId).describe()
      assert.deepStrictEqual(description.type, [
        'AuxiliarySpace',
        'DelegatedClientsSpace',
        'Space'
      ])
    })

    it('defaults the type to ["Space"] on the create path too', async () => {
      const spaceId = randomUUID()
      const response = await putSpace({
        identity: alice,
        spaceId,
        body: { id: spaceId, name: 'PUT-created', controller: alice.did }
      })
      assert.equal(response.status, 201)

      const description = await alice.was.space(spaceId).describe()
      assert.deepStrictEqual(description.type, ['Space'])
    })

    it('rejects an invalid type on the create path (400, #/type)', async () => {
      const spaceId = randomUUID()
      const err = await requestError(
        putSpace({
          identity: alice,
          spaceId,
          body: { id: spaceId, controller: alice.did, type: [] }
        })
      )
      assert.equal(statusOf(err), 400)
      assert.equal(err.data.errors[0].pointer, '#/type')
      assert.equal(await alice.was.space(spaceId).describe(), null)
    })
  })

  describe('Update Space (PUT /space/:spaceId): type is immutable', () => {
    let spaceId: string

    beforeAll(async () => {
      spaceId = randomUUID()
      await createSpace({
        identity: alice,
        body: {
          id: spaceId,
          name: 'Immutable Type',
          controller: alice.did,
          type: AUXILIARY_TYPE
        }
      })
    })

    it('rejects an update whose type names a different set (400, #/type)', async () => {
      const err = await requestError(
        putSpace({
          identity: alice,
          spaceId,
          body: {
            id: spaceId,
            name: 'Reclassified',
            controller: alice.did,
            type: ['Space']
          }
        })
      )
      assert.equal(statusOf(err), 400)
      assert.equal(
        err.data.type,
        'https://wallet.storage/spec#invalid-request-body'
      )
      assert.equal(err.data.errors[0].pointer, '#/type')

      // Neither the type nor the rest of the description changed.
      const description = await alice.was.space(spaceId).describe()
      assert.deepStrictEqual(description.type, [
        'AuxiliarySpace',
        'DelegatedClientsSpace',
        'Space'
      ])
      assert.equal(description.name, 'Immutable Type')
    })

    it('rejects an update that adds a type to the stored set (400)', async () => {
      const err = await requestError(
        putSpace({
          identity: alice,
          spaceId,
          body: {
            id: spaceId,
            controller: alice.did,
            type: [...AUXILIARY_TYPE, 'ExtraType']
          }
        })
      )
      assert.equal(statusOf(err), 400)
      assert.equal(err.data.errors[0].pointer, '#/type')
    })

    it('accepts the same type set in a different order', async () => {
      const response = await putSpace({
        identity: alice,
        spaceId,
        body: {
          id: spaceId,
          name: 'Reordered',
          controller: alice.did,
          type: ['DelegatedClientsSpace', 'Space', 'AuxiliarySpace']
        }
      })
      assert.equal(response.status, 204)

      const description = await alice.was.space(spaceId).describe()
      assert.deepStrictEqual(description.type, [
        'AuxiliarySpace',
        'DelegatedClientsSpace',
        'Space'
      ])
      assert.equal(description.name, 'Reordered')
    })

    it('preserves the stored type when the update body carries none', async () => {
      const response = await putSpace({
        identity: alice,
        spaceId,
        body: { id: spaceId, name: 'Renamed', controller: alice.did }
      })
      assert.equal(response.status, 204)

      const description = await alice.was.space(spaceId).describe()
      assert.deepStrictEqual(description.type, [
        'AuxiliarySpace',
        'DelegatedClientsSpace',
        'Space'
      ])
      assert.equal(description.name, 'Renamed')
    })

    it('the immutability check runs after authorization (an outsider still gets 404)', async () => {
      // Bob may not update Alice's Space at all, so he must not be able to
      // distinguish a type mismatch from a Space he cannot see.
      const err = await requestError(
        putSpace({
          identity: bob,
          spaceId,
          body: { id: spaceId, controller: bob.did, type: ['Space'] }
        })
      )
      assert.equal(statusOf(err), 404)
    })
  })

  describe('List Spaces (GET /spaces/) omits auxiliary Spaces', () => {
    let ordinarySpaceId: string, auxiliarySpaceId: string

    beforeAll(async () => {
      // Bob controls exactly these two Spaces in this suite, so his listing is
      // asserted exactly rather than by containment.
      ordinarySpaceId = randomUUID()
      auxiliarySpaceId = randomUUID()
      await createSpace({
        identity: bob,
        body: {
          id: ordinarySpaceId,
          name: "Bob's Data",
          controller: bob.did
        }
      })
      await createSpace({
        identity: bob,
        body: {
          id: auxiliarySpaceId,
          name: "Bob's Delegated Clients",
          controller: bob.did,
          type: AUXILIARY_TYPE
        }
      })
    })

    it('lists the ordinary Space only, and counts only listed items', async () => {
      const listing = await bob.was.listSpaces()
      assert.deepStrictEqual(listing.items, [
        {
          id: ordinarySpaceId,
          name: "Bob's Data",
          url: `/space/${ordinarySpaceId}`
        }
      ])
      assert.equal(listing.totalItems, 1)
    })

    it('the auxiliary Space is still directly readable by its controller', async () => {
      const description = await bob.was.space(auxiliarySpaceId).describe()
      assert.equal(description.id, auxiliarySpaceId)
      assert.equal(description.controller, bob.did)
      assert.deepStrictEqual(description.type, [
        'AuxiliarySpace',
        'DelegatedClientsSpace',
        'Space'
      ])
    })
  })
})
