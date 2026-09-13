/**
 * Container-rule tests (Vitest): unsafe methods at a container URL -- a Space
 * or a Collection -- are controller-only, with two exceptions.
 *
 * The rule is keyed on the shape of the INVOKED capability (the chain's tail)
 * and is independent of who signed any link, so it holds whatever DID method
 * the Space controller or a delegator uses. `PUT /space/{s}/meta` on an
 * existing Space and `DELETE /space/{s}/{c}/` take a direct root-capability
 * invocation alone. `DELETE /space/{s}/` additionally takes a delegated
 * capability whose tail targets exactly that Space's canonical trailing-slash
 * URL with `allowedAction` exactly `['DELETE']`. `PUT /space/{s}/{c}/meta`
 * additionally takes one whose tail targets exactly the Space's items subtree
 * (that same trailing-slash URL), the shape a wallet's generation delegation
 * carries, and so does `PUT /space/{s}/{c}/meta/log`, the guarded create that
 * puts a Collection under history-log governance.
 *
 * Refusals are masked as a 404 like any other unauthorized invocation, and
 * each negative case reads the target back to show nothing changed.
 *
 * Invocations are raw `@interop/ezcap` requests where the wire shape of the
 * capability is the point, and the high-level `@interop/was-client` handles
 * where provisioning is.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import {
  createDID,
  logToJsonlString,
  signerFromExternalKey
} from '@interop/did-method-webvh'
import type { ServiceEndpoint } from '@interop/did-method-webvh'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import {
  anHourFromNow,
  client,
  delegate,
  requestError,
  rootZcap,
  startTestServer,
  zcapClients
} from './helpers.js'

/** The service-entry type IRI naming an account's current annex DID. */
const DELEGATED_CLIENTS_SERVICE_TYPE = 'https://w3id.org/byoe#DelegatedClients'

/** The auxiliary Space's full type array, as a wallet would send it. */
const AUXILIARY_TYPE = ['Space', 'AuxiliarySpace', 'DelegatedClientsSpace']

/** The closed WAS verb vocabulary a generation delegation carries. */
const WAS_ACTIONS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']

describe('container rule (unsafe methods at a container URL)', () => {
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

  /** One provisioned Space, with the URLs every case below addresses. */
  interface TestSpace {
    spaceId: string
    spaceUrl: string
    spaceMetaUrl: string
    rootId: string
  }

  /**
   * Provisions a fresh Space controlled by Alice's `did:key`, with one
   * Collection holding one Resource.
   *
   * @param [options] {object}
   * @param [options.collectionId] {string}   the Collection to create
   * @returns {Promise<TestSpace>}
   */
  async function provisionSpace({
    collectionId = 'notes'
  }: { collectionId?: string } = {}): Promise<TestSpace> {
    const spaceId = `container-${randomUUID()}`
    const created = await alice.was.request({
      path: '/spaces/',
      method: 'POST',
      json: { id: spaceId, name: 'Container Space', controller: alice.did }
    })
    assert.equal(created.status, 201)
    const space = alice.was.space(spaceId)
    await space.collection(collectionId).configure({ force: true })
    await space.collection(collectionId).put('doc-1', { hello: 'world' })
    const spaceUrl = new URL(`/space/${spaceId}/`, serverUrl).toString()
    return {
      spaceId,
      spaceUrl,
      spaceMetaUrl: `${spaceUrl}meta`,
      rootId: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`
    }
  }

  /**
   * Delegates from a parent capability signed by a raw signer (Alice's
   * `did:key` admin signer, which is not an `Ed25519VerificationKey`).
   *
   * @param options {object}
   * @param options.signer {any}   the delegation-proof signer
   * @param options.capability {any}
   * @param options.invocationTarget {string}
   * @param options.controller {string}
   * @param options.allowedActions {string[]}
   * @returns {Promise<any>}
   */
  async function delegateAs({
    signer,
    capability,
    invocationTarget,
    controller,
    allowedActions
  }: {
    signer: any
    capability: any
    invocationTarget: string
    controller: string
    allowedActions: string[]
  }): Promise<any> {
    return client({ signer }).delegate({
      capability,
      invocationTarget,
      controller,
      allowedActions,
      expires: anHourFromNow()
    })
  }

  /**
   * Asserts a Space is still there and still carries the expected controller.
   *
   * @param options {object}
   * @param options.space {TestSpace}
   * @param options.controller {string}
   * @returns {Promise<void>}
   */
  async function assertSpaceIntact({
    space,
    controller
  }: {
    space: TestSpace
    controller: string
  }): Promise<void> {
    const read = await alice.was.request({
      path: `/space/${space.spaceId}/meta`,
      method: 'GET'
    })
    assert.equal(read.status, 200)
    assert.equal((read.data as { controller: string }).controller, controller)
  }

  /**
   * Asserts a Collection is still there, by reading its Metadata object.
   *
   * @param options {object}
   * @param options.space {TestSpace}
   * @param options.collectionId {string}
   * @returns {Promise<any>}   the Collection Metadata object
   */
  async function readCollectionMeta({
    space,
    collectionId
  }: {
    space: TestSpace
    collectionId: string
  }): Promise<any> {
    const read = await alice.was.request({
      path: `/space/${space.spaceId}/${collectionId}/meta`,
      method: 'GET'
    })
    assert.equal(read.status, 200)
    return read.data
  }

  describe('a direct root invocation is admitted on all four operations', () => {
    it('PUT /space/{s}/meta rewrites the Space Metadata object', async () => {
      const space = await provisionSpace()
      const response = await client({ signer: alice.signer }).request({
        url: space.spaceMetaUrl,
        method: 'PUT',
        action: 'PUT',
        capability: rootZcap({
          target: space.spaceUrl,
          controller: alice.did
        }),
        json: {
          id: space.spaceId,
          name: 'Renamed by the controller',
          controller: alice.did
        }
      })
      assert.equal(response.status, 204)
      await assertSpaceIntact({ space, controller: alice.did })
    })

    it('PUT /space/{s}/{c}/meta creates and updates a Collection', async () => {
      const space = await provisionSpace()
      const created = await client({ signer: alice.signer }).request({
        url: `${space.spaceUrl}fresh/meta`,
        method: 'PUT',
        action: 'PUT',
        capability: rootZcap({
          target: space.spaceUrl,
          controller: alice.did
        }),
        json: { name: 'Fresh' }
      })
      assert.equal(created.status, 201)
      const updated = await client({ signer: alice.signer }).request({
        url: `${space.spaceUrl}fresh/meta`,
        method: 'PUT',
        action: 'PUT',
        capability: rootZcap({
          target: space.spaceUrl,
          controller: alice.did
        }),
        json: { name: 'Fresher' }
      })
      assert.equal(updated.status, 204)
      const meta = await readCollectionMeta({ space, collectionId: 'fresh' })
      assert.equal(meta.name, 'Fresher')
    })

    it('DELETE /space/{s}/{c}/ removes the Collection', async () => {
      const space = await provisionSpace()
      const response = await client({ signer: alice.signer }).request({
        url: `${space.spaceUrl}notes/`,
        method: 'DELETE',
        action: 'DELETE',
        capability: rootZcap({
          target: space.spaceUrl,
          controller: alice.did
        })
      })
      assert.equal(response.status, 204)
      const err = await requestError(
        alice.was.request({
          path: `/space/${space.spaceId}/notes/meta`,
          method: 'GET'
        })
      )
      assert.equal(err.status, 404)
    })

    it('DELETE /space/{s}/ removes the Space', async () => {
      const space = await provisionSpace()
      const response = await client({ signer: alice.signer }).request({
        url: space.spaceUrl,
        method: 'DELETE',
        action: 'DELETE',
        capability: rootZcap({
          target: space.spaceUrl,
          controller: alice.did
        })
      })
      assert.equal(response.status, 204)
      const err = await requestError(
        alice.was.request({
          path: `/space/${space.spaceId}/meta`,
          method: 'GET'
        })
      )
      assert.equal(err.status, 404)
    })
  })

  describe('a Space-subtree grant with the full verb set', () => {
    /**
     * The generation-delegation shape: the trailing-slash Space URL with the
     * whole WAS verb vocabulary, delegated to Bob.
     *
     * @param space {TestSpace}
     * @returns {Promise<any>}
     */
    async function subtreeGrant(space: TestSpace): Promise<any> {
      return delegateAs({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: space.spaceUrl,
        controller: bob.did,
        allowedActions: WAS_ACTIONS
      })
    }

    it('cannot PUT the Space Metadata object (404, controller unchanged)', async () => {
      const space = await provisionSpace()
      const capability = await subtreeGrant(space)
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: space.spaceMetaUrl,
          method: 'PUT',
          action: 'PUT',
          capability,
          json: {
            id: space.spaceId,
            name: 'Seized',
            controller: bob.did
          }
        })
      )
      assert.equal(err.status, 404)
      await assertSpaceIntact({ space, controller: alice.did })
    })

    it('cannot DELETE the Space (404, the Space survives)', async () => {
      const space = await provisionSpace()
      const capability = await subtreeGrant(space)
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: space.spaceUrl,
          method: 'DELETE',
          action: 'DELETE',
          capability
        })
      )
      assert.equal(err.status, 404)
      await assertSpaceIntact({ space, controller: alice.did })
    })

    it('cannot DELETE a Collection (404, the Collection survives)', async () => {
      const space = await provisionSpace()
      const capability = await subtreeGrant(space)
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: `${space.spaceUrl}notes/`,
          method: 'DELETE',
          action: 'DELETE',
          capability
        })
      )
      assert.equal(err.status, 404)
      await readCollectionMeta({ space, collectionId: 'notes' })
    })

    it('but CAN PUT a Collection Metadata object, created or updated', async () => {
      const space = await provisionSpace()
      const capability = await subtreeGrant(space)
      // The generation-collection create a transient session performs.
      const created = await client({ signer: bob.signer }).request({
        url: `${space.spaceUrl}generation/meta`,
        method: 'PUT',
        action: 'PUT',
        capability,
        json: { name: 'Generation' }
      })
      assert.equal(created.status, 201)
      // ...and the unlock-methods registry write over an existing one.
      const updated = await client({ signer: bob.signer }).request({
        url: `${space.spaceUrl}notes/meta`,
        method: 'PUT',
        action: 'PUT',
        capability,
        json: { name: 'Unlock methods' }
      })
      assert.equal(updated.status, 204)
      const meta = await readCollectionMeta({ space, collectionId: 'notes' })
      assert.equal(meta.name, 'Unlock methods')
    })
  })

  describe('the Delete Space exception', () => {
    it('admits an exactly-DELETE grant on the canonical Space URL', async () => {
      const space = await provisionSpace()
      const capability = await delegateAs({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: space.spaceUrl,
        controller: bob.did,
        allowedActions: ['DELETE']
      })
      const response = await client({ signer: bob.signer }).request({
        url: space.spaceUrl,
        method: 'DELETE',
        action: 'DELETE',
        capability
      })
      assert.equal(response.status, 204)
      const err = await requestError(
        alice.was.request({
          path: `/space/${space.spaceId}/meta`,
          method: 'GET'
        })
      )
      assert.equal(err.status, 404)
    })

    it('admits a DELETE-only child of a two-verb management parent', async () => {
      // The freewallet `manageCapability` shape: a Space's controller hands
      // out `['GET', 'DELETE']` on the Space URL, and the holder narrows it to
      // a DELETE-only child before invoking. The tail is what the rule reads.
      const space = await provisionSpace()
      const parent = await delegateAs({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: space.spaceUrl,
        controller: bob.did,
        allowedActions: ['GET', 'DELETE']
      })
      const child = await delegateAs({
        signer: bob.signer,
        capability: parent,
        invocationTarget: space.spaceUrl,
        controller: bob.did,
        allowedActions: ['DELETE']
      })
      const response = await client({ signer: bob.signer }).request({
        url: space.spaceUrl,
        method: 'DELETE',
        action: 'DELETE',
        capability: child
      })
      assert.equal(response.status, 204)
    })

    it('refuses a two-verb tail carrying DELETE (404)', async () => {
      const space = await provisionSpace()
      const capability = await delegateAs({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: space.spaceUrl,
        controller: bob.did,
        allowedActions: ['GET', 'DELETE']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: space.spaceUrl,
          method: 'DELETE',
          action: 'DELETE',
          capability
        })
      )
      assert.equal(err.status, 404)
      await assertSpaceIntact({ space, controller: alice.did })
    })

    it('refuses a DELETE-only tail whose target is a prefix (404)', async () => {
      const space = await provisionSpace()
      const capability = await delegateAs({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: new URL('/space/', serverUrl).toString(),
        controller: bob.did,
        allowedActions: ['DELETE']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: space.spaceUrl,
          method: 'DELETE',
          action: 'DELETE',
          capability
        })
      )
      assert.equal(err.status, 404)
      await assertSpaceIntact({ space, controller: alice.did })
    })

    it('refuses a DELETE-only tail in the slash-less spelling (404)', async () => {
      // The slash-less Space URL is not a canonical target under v0.5. The
      // zcap library may refuse it before the rule does; either way the
      // request is denied and the Space stays.
      const space = await provisionSpace()
      const capability = await delegateAs({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: space.spaceUrl.replace(/\/$/, ''),
        controller: bob.did,
        allowedActions: ['DELETE']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: space.spaceUrl,
          method: 'DELETE',
          action: 'DELETE',
          capability
        })
      )
      assert.equal(err.status, 404)
      await assertSpaceIntact({ space, controller: alice.did })
    })
  })

  describe('the Update Collection Metadata exception', () => {
    it('refuses a grant targeting the Collection container URL (404)', async () => {
      const space = await provisionSpace()
      const capability = await delegateAs({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: `${space.spaceUrl}notes/`,
        controller: bob.did,
        allowedActions: WAS_ACTIONS
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: `${space.spaceUrl}notes/meta`,
          method: 'PUT',
          action: 'PUT',
          capability,
          json: { name: 'Renamed under a container grant' }
        })
      )
      assert.equal(err.status, 404)
      const meta = await readCollectionMeta({ space, collectionId: 'notes' })
      assert.notEqual(meta.name, 'Renamed under a container grant')
    })

    it('refuses a grant targeting the Collection Metadata URL itself (404)', async () => {
      const space = await provisionSpace()
      const capability = await delegateAs({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: `${space.spaceUrl}notes/meta`,
        controller: bob.did,
        allowedActions: ['GET', 'PUT']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: `${space.spaceUrl}notes/meta`,
          method: 'PUT',
          action: 'PUT',
          capability,
          json: { name: 'Renamed under a meta grant' }
        })
      )
      assert.equal(err.status, 404)
      const meta = await readCollectionMeta({ space, collectionId: 'notes' })
      assert.notEqual(meta.name, 'Renamed under a meta grant')
    })

    it('refuses a grant targeting a Resource URL', async () => {
      const space = await provisionSpace()
      const capability = await delegateAs({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: `${space.spaceUrl}notes/doc-1`,
        controller: bob.did,
        allowedActions: WAS_ACTIONS
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: `${space.spaceUrl}notes/meta`,
          method: 'PUT',
          action: 'PUT',
          capability,
          json: { name: 'Renamed under a resource grant' }
        })
      )
      // A Resource URL is neither the Metadata URL nor a prefix of it, so the
      // signing client refuses to mint the invocation and the request never
      // reaches the wire. The Collection Metadata object is unchanged either
      // way.
      assert.match(err.message, /invocationTarget/)
      const meta = await readCollectionMeta({ space, collectionId: 'notes' })
      assert.notEqual(meta.name, 'Renamed under a resource grant')
    })
  })

  describe('the governing history log write', () => {
    /**
     * The genesis line of a governing history log: the JSON Lines entry whose
     * `state` the server serves as the Collection's `encryption` descriptor.
     *
     * @returns {string}
     */
    function genesisLog(): string {
      return (
        JSON.stringify({
          versionId: '1-hash1',
          versionTime: '2026-09-07T00:00:00Z',
          parameters: { method: 'resource-log:0.1', scid: 'zScid' },
          state: {
            type: 'WasEpochConfiguration',
            scheme: 'edv',
            currentEpoch: 'urn:epoch:1',
            epochs: [
              {
                id: 'urn:epoch:1',
                recipients: [
                  {
                    header: { kid: 'did:key:zApp1#ka', alg: 'ECDH-ES+A256KW' },
                    encrypted_key: 'wrapped-zApp1'
                  }
                ]
              }
            ]
          },
          proof: []
        }) + '\n'
      )
    }

    /**
     * The guarded create of a Collection's log, under one capability.
     *
     * @param options {object}
     * @param options.space {TestSpace}
     * @param options.signer {any}   the invoking signer
     * @param options.capability {any}   the capability to invoke, or a root id
     * @returns {Promise<any>}
     */
    async function putLog({
      space,
      signer,
      capability
    }: {
      space: TestSpace
      signer: any
      capability: any
    }): Promise<any> {
      return client({ signer }).request({
        url: `${space.spaceUrl}notes/meta/log`,
        method: 'PUT',
        action: 'PUT',
        capability,
        headers: { 'content-type': 'text/jsonl', 'if-none-match': '*' },
        body: new TextEncoder().encode(genesisLog())
      })
    }

    /**
     * Asserts the Collection is still ungoverned: no log to read, and no
     * derived `encryption` descriptor on its Metadata object.
     *
     * @param space {TestSpace}
     * @returns {Promise<void>}
     */
    async function assertUngoverned(space: TestSpace): Promise<void> {
      const meta = await readCollectionMeta({ space, collectionId: 'notes' })
      assert.equal(meta.encryption, undefined)
      const err = await requestError(
        alice.was.request({
          path: `/space/${space.spaceId}/notes/meta/log`,
          method: 'GET'
        })
      )
      assert.equal(err.status, 404)
    }

    it('refuses a grant targeting the Collection container URL (404)', async () => {
      // The guarded create is the declaration that puts the Collection under
      // log governance, and the head's `state` is served as its `encryption`
      // descriptor from then on -- so it takes the same rule the sibling
      // `PUT .../meta` takes, not a Collection-container data grant.
      const space = await provisionSpace()
      const capability = await delegateAs({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: `${space.spaceUrl}notes/`,
        controller: bob.did,
        allowedActions: WAS_ACTIONS
      })
      const err = await requestError(
        putLog({ space, signer: bob.signer, capability })
      )
      assert.equal(err.status, 404)
      await assertUngoverned(space)
    })

    it('admits a Space-subtree grant', async () => {
      const space = await provisionSpace()
      const capability = await delegateAs({
        signer: alice.signer,
        capability: space.rootId,
        invocationTarget: space.spaceUrl,
        controller: bob.did,
        allowedActions: WAS_ACTIONS
      })
      const response = await putLog({ space, signer: bob.signer, capability })
      assert.equal(response.status, 204)
      const meta = await readCollectionMeta({ space, collectionId: 'notes' })
      assert.equal(meta.encryption.currentEpoch, 'urn:epoch:1')
    })

    it('admits a direct root invocation', async () => {
      const space = await provisionSpace()
      const response = await putLog({
        space,
        signer: alice.signer,
        capability: rootZcap({ target: space.spaceUrl, controller: alice.did })
      })
      assert.equal(response.status, 204)
      const meta = await readCollectionMeta({ space, collectionId: 'notes' })
      assert.equal(meta.encryption.currentEpoch, 'urn:epoch:1')
    })
  })

  describe('the enrolled-client-signed arm (no ladder link in the chain)', () => {
    /**
     * A minted, published self-hosted `did:webvh` and the keys it lists.
     * Every verification method here is published under all four relations
     * (the enrolled-client shape) or under invocation plus delegation (the
     * transient annex shape), so no link any of them signs is ladder-signed
     * and the client-annex clause never runs. The container rule is the only
     * thing standing between these delegations and the container writes.
     */
    interface WebvhIdentity {
      spaceId: string
      spaceUrl: string
      did: string
      clientKeyPair: any
      transientKeyPair?: any
    }

    let account: WebvhIdentity
    let clientAnnex: WebvhIdentity
    let auxSpace: TestSpace

    beforeAll(async () => {
      clientAnnex = await provisionWebvhIdentity({ withTransientKey: true })
      account = await provisionWebvhIdentity({
        services: [
          {
            id: '#delegated-clients',
            type: DELEGATED_CLIENTS_SERVICE_TYPE,
            serviceEndpoint: clientAnnex.did
          }
        ]
      })
      await alice.was
        .space(account.spaceId)
        .collection('credentials')
        .configure({ force: true })

      // Promotion by ordering: the Space is created under Alice's `did:key`
      // and only then handed to the account DID.
      const promoted = await alice.was.request({
        path: `/space/${account.spaceId}/meta`,
        method: 'PUT',
        json: {
          id: account.spaceId,
          name: 'Account Space',
          controller: account.did
        }
      })
      assert.equal(promoted.status, 204)

      // The delegated-clients bookkeeping Space, typed as such and promoted to
      // the account DID too.
      const auxSpaceId = `annex-${randomUUID()}`
      const createdAux = await alice.was.request({
        url: new URL('/spaces/', serverUrl).toString(),
        method: 'POST',
        json: {
          id: auxSpaceId,
          name: 'Delegated Clients',
          controller: alice.did,
          type: AUXILIARY_TYPE
        }
      })
      assert.equal(createdAux.status, 201)
      const auxPromoted = await alice.was.request({
        path: `/space/${auxSpaceId}/meta`,
        method: 'PUT',
        json: {
          id: auxSpaceId,
          name: 'Delegated Clients',
          controller: account.did
        }
      })
      assert.equal(auxPromoted.status, 204)
      const auxUrl = new URL(`/space/${auxSpaceId}/`, serverUrl).toString()
      auxSpace = {
        spaceId: auxSpaceId,
        spaceUrl: auxUrl,
        spaceMetaUrl: `${auxUrl}meta`,
        rootId: `urn:zcap:root:${encodeURIComponent(auxUrl)}`
      }
    })

    /**
     * Provisions a Space controlled by Alice's `did:key`, mints a `did:webvh`
     * anchored in its `id` Collection, and publishes the history log there.
     * Promotion is left to the caller.
     *
     * @param [options] {object}
     * @param [options.withTransientKey] {boolean}   also list a method under
     *   `capabilityInvocation` and `capabilityDelegation` -- the shape a
     *   per-visit annex verification method publishes under
     * @param [options.services] {ServiceEndpoint[]}   service entries
     * @returns {Promise<WebvhIdentity>}
     */
    async function provisionWebvhIdentity({
      withTransientKey = false,
      services
    }: {
      withTransientKey?: boolean
      services?: ServiceEndpoint[]
    } = {}): Promise<WebvhIdentity> {
      const spaceId = randomUUID()
      const space = alice.was.space(spaceId)
      await space.configure({ name: 'Identity Space', controller: alice.did })
      await space.collection('id').configure({ force: true })

      const updateKeyPair = await Ed25519VerificationKey.generate()
      const updateKeySigner = updateKeyPair.didKeySigner()
      const logSigner = signerFromExternalKey({
        publicKeyMultibase: updateKeyPair.publicKeyMultibase!,
        sign: async ({ data }: { data: Uint8Array }) =>
          await updateKeySigner.sign({ data })
      })

      const clientKeyPair = await Ed25519VerificationKey.generate()
      const transientKeyPair = withTransientKey
        ? await Ed25519VerificationKey.generate()
        : undefined

      const verificationMethods = [
        {
          type: 'Multikey',
          publicKeyMultibase: clientKeyPair.publicKeyMultibase!,
          purpose: [
            'authentication',
            'assertionMethod',
            'capabilityInvocation',
            'capabilityDelegation'
          ]
        }
      ]
      if (transientKeyPair) {
        verificationMethods.push({
          type: 'Multikey',
          publicKeyMultibase: transientKeyPair.publicKeyMultibase!,
          purpose: ['capabilityInvocation', 'capabilityDelegation']
        })
      }

      const created = await createDID({
        address: `${serverUrl}/space/${spaceId}/id`,
        signer: logSigner,
        updateKeys: [updateKeyPair.publicKeyMultibase!],
        vmIdFragment: 'multibase',
        verificationMethods: verificationMethods as any,
        ...(services ? { services } : {})
      })

      clientKeyPair.id = `${created.did}#${clientKeyPair.publicKeyMultibase}`
      clientKeyPair.controller = created.did
      if (transientKeyPair) {
        transientKeyPair.id = `${created.did}#${transientKeyPair.publicKeyMultibase}`
        transientKeyPair.controller = created.did
      }

      const published = await alice.was.request({
        path: `/space/${spaceId}/id/did.jsonl`,
        method: 'PUT',
        headers: { 'content-type': 'text/jsonl' },
        body: new Blob([logToJsonlString(created.log)], { type: 'text/jsonl' })
      })
      assert.equal(published.status, 204)

      return {
        spaceId,
        spaceUrl: new URL(`/space/${spaceId}/`, serverUrl).toString(),
        did: created.did,
        clientKeyPair,
        transientKeyPair
      }
    }

    /**
     * The generation delegation as a wallet mints it by default: signed by an
     * ENROLLED CLIENT's key (published under all four relations, so not a
     * ladder VM), targeting the account Space's items subtree with the whole
     * WAS verb vocabulary, controlled by the annex DID.
     *
     * @returns {Promise<any>}
     */
    async function generationDelegation(): Promise<any> {
      return delegate({
        signerKeyPair: account.clientKeyPair,
        capability: `urn:zcap:root:${encodeURIComponent(account.spaceUrl)}`,
        invocationTarget: account.spaceUrl,
        controller: clientAnnex.did,
        allowedActions: WAS_ACTIONS
      })
    }

    /**
     * Asserts the account Space still carries the account DID as controller.
     *
     * @returns {Promise<void>}
     */
    async function assertAccountIntact(): Promise<void> {
      const metadata = await client({
        signer: account.clientKeyPair.signer()
      }).request({
        url: `${account.spaceUrl}meta`,
        method: 'GET',
        action: 'GET',
        capability: rootZcap({
          target: account.spaceUrl,
          controller: account.did
        })
      })
      assert.equal(
        (metadata.data as { controller: string }).controller,
        account.did
      )
    }

    it('refuses the annex VM DELETE of the account Space (404)', async () => {
      const capability = await generationDelegation()
      const err = await requestError(
        client({ signer: clientAnnex.transientKeyPair.signer() }).request({
          url: account.spaceUrl,
          method: 'DELETE',
          action: 'DELETE',
          capability
        })
      )
      assert.equal(err.status, 404)
      await assertAccountIntact()
    })

    it('refuses the annex VM PUT of the account Space Metadata object (404)', async () => {
      const capability = await generationDelegation()
      const err = await requestError(
        client({ signer: clientAnnex.transientKeyPair.signer() }).request({
          url: `${account.spaceUrl}meta`,
          method: 'PUT',
          action: 'PUT',
          capability,
          json: {
            id: account.spaceId,
            name: 'Seized',
            controller: clientAnnex.did
          }
        })
      )
      assert.equal(err.status, 404)
      await assertAccountIntact()
    })

    it('refuses a delegated-clients grant PUT of the annex Space Metadata object (404)', async () => {
      const capability = await delegate({
        signerKeyPair: account.clientKeyPair,
        capability: auxSpace.rootId,
        invocationTarget: auxSpace.spaceUrl,
        controller: clientAnnex.did,
        allowedActions: ['GET', 'PUT']
      })
      const err = await requestError(
        client({ signer: clientAnnex.transientKeyPair.signer() }).request({
          url: auxSpace.spaceMetaUrl,
          method: 'PUT',
          action: 'PUT',
          capability,
          json: {
            id: auxSpace.spaceId,
            name: 'Delegated Clients',
            controller: clientAnnex.did
          }
        })
      )
      assert.equal(err.status, 404)
      const metadata = await client({
        signer: account.clientKeyPair.signer()
      }).request({
        url: auxSpace.spaceMetaUrl,
        method: 'GET',
        action: 'GET',
        capability: rootZcap({
          target: auxSpace.spaceUrl,
          controller: account.did
        })
      })
      assert.equal(
        (metadata.data as { controller: string }).controller,
        account.did
      )
    })

    it('still lets the annex VM PUT a Collection Metadata object under the generation delegation', async () => {
      const capability = await generationDelegation()
      const response = await client({
        signer: clientAnnex.transientKeyPair.signer()
      }).request({
        url: `${account.spaceUrl}credentials/meta`,
        method: 'PUT',
        action: 'PUT',
        capability,
        json: { name: 'Credentials' }
      })
      assert.equal(response.status, 204)
    })

    // Runs last: it deletes the account Space, and everything above reads it.
    it('admits an annex-VM DELETE-only target-exact child of the generation delegation', async () => {
      // The residual this rule leaves standing. The annex verification method
      // holds both relations, so it is not ladder authority and may narrow the
      // generation delegation into a target-exact DELETE-only child -- which
      // is exactly the shape the Delete Space exception admits. Whether that
      // residual should be narrowed further is tracked separately.
      const parent = await generationDelegation()
      const child = await delegate({
        signerKeyPair: clientAnnex.transientKeyPair,
        capability: parent,
        invocationTarget: account.spaceUrl,
        controller: clientAnnex.did,
        allowedActions: ['DELETE']
      })
      const response = await client({
        signer: clientAnnex.transientKeyPair.signer()
      }).request({
        url: account.spaceUrl,
        method: 'DELETE',
        action: 'DELETE',
        capability: child
      })
      assert.equal(response.status, 204)
    })
  })
})
