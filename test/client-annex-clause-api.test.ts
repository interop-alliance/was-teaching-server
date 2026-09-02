/**
 * Client-annex-clause tests (Vitest): the bound on what a *ladder* verification
 * method of a self-hosted `did:webvh` account document may delegate.
 *
 * A ladder VM is recognized by relation asymmetry alone -- listed under
 * `capabilityDelegation`, absent from `capabilityInvocation`. A delegation it
 * signs is admitted only when it names the account document's annex DID as its
 * sole controller with a target inside the account Space's items subtree and
 * actions within the closed WAS verb vocabulary, when its target is
 * bridge-shaped (the account's own history log with `PUT`, or the subtree URL
 * of a delegated-clients bookkeeping Space with `GET`/`PUT`), or when its
 * target is a bare Space URL equal to its parent capability's own, granted
 * exactly `GET` or exactly `DELETE`.
 * Everything else is refused, and the refusal is masked as a 404 like any other
 * unauthorized invocation -- while still falling through to the access-control
 * policy, so a world-readable target keeps serving.
 *
 * A method holding both `capabilityInvocation` and `capabilityDelegation` --
 * the shape a per-visit annex verification method publishes under -- is not
 * ladder authority, so the clause skips the link it signed.
 *
 * Invocations are raw `@interop/ezcap` requests: these are wire-level
 * authorization shapes, not the high-level `@interop/was-client` surface.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { KmsClient } from '@interop/webkms-client'

import {
  createDID,
  logToJsonlString,
  signerFromExternalKey,
  updateDID
} from '@interop/did-method-webvh'
import type { DIDLog, ServiceEndpoint } from '@interop/did-method-webvh'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import {
  client,
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

/** One hour out, the expiry every delegation in this suite carries. */
function anHourFromNow(): Date {
  return new Date(Date.now() + 60 * 60 * 1000)
}

/** A minted, published self-hosted `did:webvh` and the keys it lists. */
interface WebvhIdentity {
  spaceId: string
  did: string
  log: DIDLog
  /** the update-key signer every log entry of this identity is signed by */
  logSigner: any
  /** the ordinary client key: invocation *and* delegation */
  clientKeyPair: any
  /** the delegation-only (ladder) key, when the document lists one */
  ladderKeyPair?: any
  /** the invocation-and-delegation (transient annex) key, when listed */
  transientKeyPair?: any
}

describe('client-annex clause (ladder-VM delegation bounds)', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    bob: any

  /** The account identity every ladder delegation below is signed under. */
  let account: WebvhIdentity
  /** The annex DID the account document's service entry names. */
  let clientAnnex: WebvhIdentity
  let accountSpaceUrl: string
  let accountLogUrl: string
  let credentialsUrl: string
  let openCollectionUrl: string

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice, bob } = await zcapClients({ serverUrl }))

    // The annex identity is provisioned first: the account document's service entry
    // has to name it, and a DID string is only known once its log is minted.
    clientAnnex = await provisionWebvhIdentity({
      withLadderKey: false,
      withTransientKey: true
    })
    account = await provisionWebvhIdentity({
      withLadderKey: true,
      services: [
        {
          id: '#delegated-clients',
          type: DELEGATED_CLIENTS_SERVICE_TYPE,
          serviceEndpoint: clientAnnex.did
        }
      ]
    })

    accountSpaceUrl = new URL(`/space/${account.spaceId}`, serverUrl).toString()
    accountLogUrl = `${accountSpaceUrl}/id/did.jsonl`
    credentialsUrl = `${accountSpaceUrl}/credentials`
    openCollectionUrl = `${accountSpaceUrl}/open`

    const accountSpace = alice.was.space(account.spaceId)
    await accountSpace.collection('credentials').configure({ force: true })
    await accountSpace
      .collection('credentials')
      .put('doc-1', { hello: 'world' })
    // A log-shaped target outside the `id` Collection, for the branch-one
    // refusal case.
    await accountSpace.collection('other').configure({ force: true })
    const openCollection = accountSpace.collection('open')
    await openCollection.configure({ force: true })
    await openCollection.put('note-1', { open: true })
    await openCollection.setPublic()

    // Promotion by ordering: the Space is created under Alice's `did:key`,
    // populated, and only then handed to the account DID.
    const promoted = await alice.was.request({
      path: `/space/${account.spaceId}`,
      method: 'PUT',
      json: {
        id: account.spaceId,
        name: 'Account Space',
        controller: account.did
      }
    })
    assert.equal(promoted.status, 204)
  })

  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  /**
   * Provisions a Space controlled by Alice's `did:key`, mints a `did:webvh`
   * anchored in a Collection of that Space (`id` unless overridden), and
   * publishes its history log there. The log Collection is deliberately *not*
   * world-readable: local resolution is a storage read, and a public policy
   * would mask the refusals this suite asserts on the log URL. Promotion is
   * left to the caller.
   *
   * @param options {object}
   * @param options.withLadderKey {boolean}   also list a delegation-only
   *   verification method (the ladder VM)
   * @param [options.withTransientKey] {boolean}   also list a method under
   *   `capabilityInvocation` *and* `capabilityDelegation`, the shape a
   *   per-visit annex verification method publishes under
   * @param [options.collectionId] {string}   the Collection anchoring the log
   * @param [options.services] {ServiceEndpoint[]}   service entries for the
   *   created document
   * @returns {Promise<WebvhIdentity>}
   */
  async function provisionWebvhIdentity({
    withLadderKey,
    withTransientKey = false,
    collectionId = 'id',
    services
  }: {
    withLadderKey: boolean
    withTransientKey?: boolean
    collectionId?: string
    services?: ServiceEndpoint[]
  }): Promise<WebvhIdentity> {
    const spaceId = randomUUID()
    const space = alice.was.space(spaceId)
    await space.configure({ name: 'Identity Space', controller: alice.did })
    await space.collection(collectionId).configure({ force: true })

    const updateKeyPair = await Ed25519VerificationKey.generate()
    updateKeyPair.id =
      `did:key:${updateKeyPair.publicKeyMultibase}` +
      `#${updateKeyPair.publicKeyMultibase}`
    const logSigner = signerFromExternalKey({
      publicKeyMultibase: updateKeyPair.publicKeyMultibase!,
      sign: async ({ data }: { data: Uint8Array }) =>
        await updateKeyPair.signer().sign({ data })
    })

    const clientKeyPair = await Ed25519VerificationKey.generate()
    const ladderKeyPair = withLadderKey
      ? await Ed25519VerificationKey.generate()
      : undefined
    const transientKeyPair = withTransientKey
      ? await Ed25519VerificationKey.generate()
      : undefined

    // Relationship wiring is driven entirely through `purpose`: passing
    // explicit relationship arrays alongside would override it wholesale.
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
    if (ladderKeyPair) {
      verificationMethods.push({
        type: 'Multikey',
        publicKeyMultibase: ladderKeyPair.publicKeyMultibase!,
        purpose: ['assertionMethod', 'capabilityDelegation']
      })
    }
    if (transientKeyPair) {
      verificationMethods.push({
        type: 'Multikey',
        publicKeyMultibase: transientKeyPair.publicKeyMultibase!,
        purpose: ['capabilityInvocation', 'capabilityDelegation']
      })
    }

    const created = await createDID({
      address: `${serverUrl}/space/${spaceId}/${collectionId}`,
      signer: logSigner,
      updateKeys: [updateKeyPair.publicKeyMultibase!],
      vmIdFragment: 'multibase',
      verificationMethods: verificationMethods as any,
      ...(services ? { services } : {})
    })

    clientKeyPair.id = `${created.did}#${clientKeyPair.publicKeyMultibase}`
    clientKeyPair.controller = created.did
    if (ladderKeyPair) {
      ladderKeyPair.id = `${created.did}#${ladderKeyPair.publicKeyMultibase}`
      ladderKeyPair.controller = created.did
    }
    if (transientKeyPair) {
      transientKeyPair.id = `${created.did}#${transientKeyPair.publicKeyMultibase}`
      transientKeyPair.controller = created.did
    }

    const published = await alice.was.request({
      path: `/space/${spaceId}/${collectionId}/did.jsonl`,
      method: 'PUT',
      headers: { 'content-type': 'text/jsonl' },
      body: new Blob([logToJsonlString(created.log)], { type: 'text/jsonl' })
    })
    assert.equal(published.status, 204)

    return {
      spaceId,
      did: created.did,
      log: created.log,
      logSigner,
      clientKeyPair,
      ladderKeyPair,
      transientKeyPair
    }
  }

  /**
   * Delegates from a parent capability, signed by one of the account's keys.
   *
   * @param options {object}
   * @param options.signerKeyPair {any}   the key signing the delegation proof
   * @param options.capability {any}   the parent capability (or its root id)
   * @param options.invocationTarget {string}
   * @param options.controller {string}
   * @param options.allowedActions {string[]}
   * @param [options.expires] {Date}   an expiry within the parent's, for a
   *   sub-delegation
   * @returns {Promise<any>}
   */
  async function delegate({
    signerKeyPair,
    capability,
    invocationTarget,
    controller,
    allowedActions,
    expires = anHourFromNow()
  }: {
    signerKeyPair: any
    capability: any
    invocationTarget: string
    controller: string
    allowedActions: string[]
    expires?: Date
  }): Promise<any> {
    return client({ signer: signerKeyPair.signer() }).delegate({
      capability,
      invocationTarget,
      controller,
      allowedActions,
      expires
    })
  }

  /** The account Space's root capability id, the parent of every WAS-route
   * delegation below. */
  function accountSpaceRoot(): string {
    return `urn:zcap:root:${encodeURIComponent(accountSpaceUrl)}`
  }

  describe('control: a non-ladder chain is untouched', () => {
    it('an ordinary client VM delegates an arbitrary target end to end', async () => {
      const delegated = await delegate({
        signerKeyPair: account.clientKeyPair,
        capability: accountSpaceRoot(),
        invocationTarget: credentialsUrl,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const response = await client({ signer: bob.signer }).request({
        url: `${credentialsUrl}/doc-1`,
        method: 'GET',
        action: 'GET',
        capability: delegated
      })
      assert.equal(response.status, 200)
      assert.deepStrictEqual(response.data, { hello: 'world' })
    })
  })

  describe('predicate (i): the annex DID as controller', () => {
    it('admits a ladder delegation controlled by the annex DID', async () => {
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: accountSpaceRoot(),
        invocationTarget: credentialsUrl,
        controller: clientAnnex.did,
        allowedActions: ['GET']
      })
      const response = await client({
        signer: clientAnnex.clientKeyPair.signer()
      }).request({
        url: `${credentialsUrl}/doc-1`,
        method: 'GET',
        action: 'GET',
        capability: delegated
      })
      assert.equal(response.status, 200)
      assert.deepStrictEqual(response.data, { hello: 'world' })
    })

    it('refuses a ladder delegation to some other controller (404)', async () => {
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: accountSpaceRoot(),
        invocationTarget: credentialsUrl,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: `${credentialsUrl}/doc-1`,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })

    it('the refused delegation cannot write either, and nothing lands', async () => {
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: accountSpaceRoot(),
        invocationTarget: credentialsUrl,
        controller: bob.did,
        allowedActions: ['GET', 'PUT']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: `${credentialsUrl}/doc-1`,
          method: 'PUT',
          action: 'PUT',
          capability: delegated,
          json: { escape: true }
        })
      )
      assert.equal(err.status, 404)

      const readBack = await client({
        signer: account.clientKeyPair.signer()
      }).request({
        url: `${credentialsUrl}/doc-1`,
        method: 'GET',
        action: 'GET',
        capability: rootZcap({
          target: accountSpaceUrl,
          controller: account.did
        })
      })
      assert.deepStrictEqual(readBack.data, { hello: 'world' })
    })

    it('admits the generation-delegation shape on the Space subtree', async () => {
      // The shape a wallet actually mints: the trailing-slash account Space
      // URL with the full closed WAS verb vocabulary, granted to the annex
      // DID. Both a read and a write under it land.
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: accountSpaceRoot(),
        invocationTarget: `${accountSpaceUrl}/`,
        controller: clientAnnex.did,
        allowedActions: WAS_ACTIONS
      })
      const annex = client({ signer: clientAnnex.clientKeyPair.signer() })

      const read = await annex.request({
        url: `${credentialsUrl}/doc-1`,
        method: 'GET',
        action: 'GET',
        capability: delegated
      })
      assert.equal(read.status, 200)
      assert.deepStrictEqual(read.data, { hello: 'world' })

      const written = await annex.request({
        url: `${credentialsUrl}/doc-generation`,
        method: 'PUT',
        action: 'PUT',
        capability: delegated,
        json: { minted: 'under-generation-delegation' }
      })
      assert.equal(written.status, 204)

      const readBack = await annex.request({
        url: `${credentialsUrl}/doc-generation`,
        method: 'GET',
        action: 'GET',
        capability: delegated
      })
      assert.equal(readBack.status, 200)
      assert.deepStrictEqual(readBack.data, {
        minted: 'under-generation-delegation'
      })
    })

    it('refuses a Space-level target to the same grantee (404)', async () => {
      // The bare Space URL is outside the items subtree: it reaches Update
      // Space Description, and so the Space's controller.
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: accountSpaceRoot(),
        invocationTarget: accountSpaceUrl,
        controller: clientAnnex.did,
        allowedActions: ['GET', 'PUT']
      })
      const err = await requestError(
        client({ signer: clientAnnex.clientKeyPair.signer() }).request({
          url: accountSpaceUrl,
          method: 'PUT',
          action: 'PUT',
          capability: delegated,
          json: {
            id: account.spaceId,
            name: 'Account Space',
            controller: bob.did
          }
        })
      )
      assert.equal(err.status, 404)

      // The controller rewrite did not land.
      const description = await client({
        signer: account.clientKeyPair.signer()
      }).request({
        url: accountSpaceUrl,
        method: 'GET',
        action: 'GET',
        capability: rootZcap({
          target: accountSpaceUrl,
          controller: account.did
        })
      })
      assert.equal(
        (description.data as { controller: string }).controller,
        account.did
      )
    })

    it("refuses a subtree target in another of the account's Spaces (404)", async () => {
      // A second Space promoted to the same account DID. The delegation hangs
      // off that Space's own root, so the zcap library's target attenuation
      // passes and the refusal is the clause's: the Space is not the one
      // carrying the account DID's log.
      const otherSpaceId = randomUUID()
      const otherSpace = alice.was.space(otherSpaceId)
      await otherSpace.configure({ name: 'Other', controller: alice.did })
      await otherSpace.collection('notes').configure({ force: true })
      await otherSpace.collection('notes').put('note-1', { other: true })
      const promoted = await alice.was.request({
        path: `/space/${otherSpaceId}`,
        method: 'PUT',
        json: { id: otherSpaceId, name: 'Other', controller: account.did }
      })
      assert.equal(promoted.status, 204)

      const otherSpaceUrl = new URL(
        `/space/${otherSpaceId}`,
        serverUrl
      ).toString()
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: `urn:zcap:root:${encodeURIComponent(otherSpaceUrl)}`,
        invocationTarget: `${otherSpaceUrl}/`,
        controller: clientAnnex.did,
        allowedActions: WAS_ACTIONS
      })
      const err = await requestError(
        client({ signer: clientAnnex.clientKeyPair.signer() }).request({
          url: `${otherSpaceUrl}/notes/note-1`,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses an action outside the WAS verb vocabulary (404)', async () => {
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: accountSpaceRoot(),
        invocationTarget: `${accountSpaceUrl}/`,
        controller: clientAnnex.did,
        allowedActions: ['GET', 'PATCH']
      })
      const err = await requestError(
        client({ signer: clientAnnex.clientKeyPair.signer() }).request({
          url: `${credentialsUrl}/doc-1`,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses an absent `allowedAction` on a subtree target (404)', async () => {
      // An empty `allowedActions` omits `allowedAction` from the delegation,
      // which permits any action in the zcap model.
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: accountSpaceRoot(),
        invocationTarget: `${accountSpaceUrl}/`,
        controller: clientAnnex.did,
        allowedActions: []
      })
      assert.equal(delegated.allowedAction, undefined)
      const err = await requestError(
        client({ signer: clientAnnex.clientKeyPair.signer() }).request({
          url: `${credentialsUrl}/doc-1`,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })
  })

  describe('a two-relation annex VM is outside the clause', () => {
    it('skips the grant link that annex VM signed, so it serves (200)', async () => {
      // The chain a transient wallet session mints: the root, then the
      // ladder-signed generation delegation the clause judges and admits
      // under predicate (i), then the grant the annex's own per-visit
      // verification method signs. That method holds `capabilityInvocation`
      // *and* `capabilityDelegation`, so the relation asymmetry does not
      // match and the clause skips its link. Were the link judged as ladder
      // authority, neither predicate could hold -- the controller is Bob, not
      // the annex DID, and the target is an ordinary Collection -- and this
      // read would be a 404.
      const generationDelegation = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: accountSpaceRoot(),
        invocationTarget: credentialsUrl,
        controller: clientAnnex.did,
        allowedActions: ['GET']
      })
      const grant = await delegate({
        signerKeyPair: clientAnnex.transientKeyPair,
        capability: generationDelegation,
        invocationTarget: credentialsUrl,
        controller: bob.did,
        allowedActions: ['GET'],
        expires: new Date(generationDelegation.expires)
      })
      const response = await client({ signer: bob.signer }).request({
        url: `${credentialsUrl}/doc-1`,
        method: 'GET',
        action: 'GET',
        capability: grant
      })
      assert.equal(response.status, 200)
      assert.deepStrictEqual(response.data, { hello: 'world' })
    })

    it('still serves when the generation delegation targets the subtree', async () => {
      // The same depth-3 chain, with the generation delegation in the shape a
      // wallet mints it: the trailing-slash account Space URL and the full
      // verb vocabulary. The clause admits the middle link on all three of its
      // bounds, and skips the annex-signed link as before.
      const generationDelegation = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: accountSpaceRoot(),
        invocationTarget: `${accountSpaceUrl}/`,
        controller: clientAnnex.did,
        allowedActions: WAS_ACTIONS
      })
      const grant = await delegate({
        signerKeyPair: clientAnnex.transientKeyPair,
        capability: generationDelegation,
        invocationTarget: credentialsUrl,
        controller: bob.did,
        allowedActions: ['GET'],
        expires: new Date(generationDelegation.expires)
      })
      const response = await client({ signer: bob.signer }).request({
        url: `${credentialsUrl}/doc-1`,
        method: 'GET',
        action: 'GET',
        capability: grant
      })
      assert.equal(response.status, 200)
      assert.deepStrictEqual(response.data, { hello: 'world' })
    })
  })

  describe('a refusal still falls through to the access-control policy', () => {
    it('a world-readable target serves a refused ladder invocation (200)', async () => {
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: accountSpaceRoot(),
        invocationTarget: openCollectionUrl,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const response = await client({ signer: bob.signer }).request({
        url: `${openCollectionUrl}/note-1`,
        method: 'GET',
        action: 'GET',
        capability: delegated
      })
      assert.equal(response.status, 200)
      assert.deepStrictEqual(response.data, { open: true })
    })

    it('but the policy grants reads only -- a write is still refused', async () => {
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: accountSpaceRoot(),
        invocationTarget: openCollectionUrl,
        controller: bob.did,
        allowedActions: ['GET', 'PUT']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: `${openCollectionUrl}/note-1`,
          method: 'PUT',
          action: 'PUT',
          capability: delegated,
          json: { open: false }
        })
      )
      assert.equal(err.status, 404)
    })
  })

  describe("predicate (ii), branch one: the account's own log target", () => {
    /** PUTs an account's log bytes back, under `capability`. */
    async function putLog({
      signer,
      capability,
      url = accountLogUrl,
      log = account.log
    }: {
      signer: any
      capability: any
      url?: string
      log?: DIDLog
    }): Promise<any> {
      const jsonl = logToJsonlString(log)
      return client({ signer }).request({
        url,
        method: 'PUT',
        action: 'PUT',
        capability,
        headers: { 'content-type': 'text/jsonl' },
        body: new Blob([jsonl], { type: 'text/jsonl' })
      })
    }

    it("admits a PUT-only delegation of the account's own log", async () => {
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: accountSpaceRoot(),
        invocationTarget: accountLogUrl,
        controller: bob.did,
        allowedActions: ['PUT']
      })
      const response = await putLog({
        signer: bob.signer,
        capability: delegated
      })
      assert.equal(response.status, 204)
    })

    it('refuses the same target granted GET (404)', async () => {
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: accountSpaceRoot(),
        invocationTarget: accountLogUrl,
        controller: bob.did,
        allowedActions: ['GET']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: accountLogUrl,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses actions outside {PUT} (404)', async () => {
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: accountSpaceRoot(),
        invocationTarget: accountLogUrl,
        controller: bob.did,
        allowedActions: ['PUT', 'DELETE']
      })
      const err = await requestError(
        putLog({ signer: bob.signer, capability: delegated })
      )
      assert.equal(err.status, 404)
    })

    it("refuses a log-shaped target that is not the account's own log (404)", async () => {
      const otherLogUrl = `${accountSpaceUrl}/other/did.jsonl`
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: accountSpaceRoot(),
        invocationTarget: otherLogUrl,
        controller: bob.did,
        allowedActions: ['PUT']
      })
      const err = await requestError(
        putLog({
          signer: bob.signer,
          capability: delegated,
          url: otherLogUrl
        })
      )
      assert.equal(err.status, 404)
    })

    it("refuses another Space's `id/did.jsonl`, even account-controlled (404)", async () => {
      // A second Space promoted to the same account DID, with a Collection
      // named `id`: the exact shape a hardcoded `<S>/id/did.jsonl` match
      // would admit, but not the log the account DID itself is anchored in.
      const decoySpaceId = randomUUID()
      const decoySpace = alice.was.space(decoySpaceId)
      await decoySpace.configure({ name: 'Decoy', controller: alice.did })
      await decoySpace.collection('id').configure({ force: true })
      const promoted = await alice.was.request({
        path: `/space/${decoySpaceId}`,
        method: 'PUT',
        json: { id: decoySpaceId, name: 'Decoy', controller: account.did }
      })
      assert.equal(promoted.status, 204)

      const decoySpaceUrl = new URL(
        `/space/${decoySpaceId}`,
        serverUrl
      ).toString()
      const decoyLogUrl = `${decoySpaceUrl}/id/did.jsonl`
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: `urn:zcap:root:${encodeURIComponent(decoySpaceUrl)}`,
        invocationTarget: decoyLogUrl,
        controller: bob.did,
        allowedActions: ['PUT']
      })
      const err = await requestError(
        putLog({ signer: bob.signer, capability: delegated, url: decoyLogUrl })
      )
      assert.equal(err.status, 404)
    })

    it('admits the bridge for an account anchored outside `id`', async () => {
      // The DID string carries its own log Collection, so an account anchored
      // in a `keys` Collection reaches the same bridge.
      const keysAccount = await provisionWebvhIdentity({
        withLadderKey: true,
        collectionId: 'keys'
      })
      const promoted = await alice.was.request({
        path: `/space/${keysAccount.spaceId}`,
        method: 'PUT',
        json: {
          id: keysAccount.spaceId,
          name: 'Keys Account Space',
          controller: keysAccount.did
        }
      })
      assert.equal(promoted.status, 204)

      const keysSpaceUrl = new URL(
        `/space/${keysAccount.spaceId}`,
        serverUrl
      ).toString()
      const keysLogUrl = `${keysSpaceUrl}/keys/did.jsonl`
      const delegated = await delegate({
        signerKeyPair: keysAccount.ladderKeyPair,
        capability: `urn:zcap:root:${encodeURIComponent(keysSpaceUrl)}`,
        invocationTarget: keysLogUrl,
        controller: bob.did,
        allowedActions: ['PUT']
      })
      const response = await putLog({
        signer: bob.signer,
        capability: delegated,
        url: keysLogUrl,
        log: keysAccount.log
      })
      assert.equal(response.status, 204)
    })
  })

  describe('predicate (ii), branch two: a delegated-clients Space', () => {
    let auxSpaceId: string
    let auxSpaceUrl: string
    let auxSpaceRoot: string

    beforeAll(async () => {
      // Creation is `did:key`-only, so the auxiliary Space is created (and its
      // Collection provisioned) under Alice, then promoted to the account DID.
      auxSpaceId = randomUUID()
      auxSpaceUrl = new URL(`/space/${auxSpaceId}`, serverUrl).toString()
      auxSpaceRoot = `urn:zcap:root:${encodeURIComponent(auxSpaceUrl)}`

      const created = await alice.was.request({
        url: new URL('/spaces/', serverUrl).toString(),
        method: 'POST',
        json: {
          id: auxSpaceId,
          name: 'Delegated Clients',
          controller: alice.did,
          type: AUXILIARY_TYPE
        }
      })
      assert.equal(created.status, 201)
      await alice.was
        .space(auxSpaceId)
        .collection('clients')
        .configure({ force: true })

      const promoted = await alice.was.request({
        path: `/space/${auxSpaceId}`,
        method: 'PUT',
        json: {
          id: auxSpaceId,
          name: 'Delegated Clients',
          controller: account.did
        }
      })
      assert.equal(promoted.status, 204)
    })

    it('admits a GET/PUT grant on the whole auxiliary Space', async () => {
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: auxSpaceRoot,
        invocationTarget: `${auxSpaceUrl}/`,
        controller: bob.did,
        allowedActions: ['GET', 'PUT']
      })
      const recordUrl = `${auxSpaceUrl}/clients/rec-1`
      const written = await client({ signer: bob.signer }).request({
        url: recordUrl,
        method: 'PUT',
        action: 'PUT',
        capability: delegated,
        json: { clientId: 'client-1' }
      })
      assert.equal(written.status, 204)

      const read = await client({ signer: bob.signer }).request({
        url: recordUrl,
        method: 'GET',
        action: 'GET',
        capability: delegated
      })
      assert.equal(read.status, 200)
      assert.deepStrictEqual(read.data, { clientId: 'client-1' })
    })

    it('refuses the no-slash form of the same Space URL (404)', async () => {
      // Only the subtree (trailing-slash) target is admitted: a no-slash
      // grant would also cover Update Space Description under target
      // attenuation. Annex-profile grants pass the subtree target
      // explicitly (was-client `GrantOptions.target`).
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: auxSpaceRoot,
        invocationTarget: auxSpaceUrl,
        controller: bob.did,
        allowedActions: ['GET', 'PUT']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: `${auxSpaceUrl}/clients/rec-1`,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses actions outside {GET, PUT} on the same Space (404)', async () => {
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: auxSpaceRoot,
        invocationTarget: `${auxSpaceUrl}/`,
        controller: bob.did,
        allowedActions: ['GET', 'PUT', 'DELETE']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: `${auxSpaceUrl}/clients/rec-1`,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses the same shape over an ordinary Space (404)', async () => {
      // The account's own Space is typed `['Space']` and controlled by the same
      // DID: only the Description type separates it from the case above.
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: accountSpaceRoot(),
        invocationTarget: `${accountSpaceUrl}/`,
        controller: bob.did,
        allowedActions: ['GET', 'PUT']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: `${credentialsUrl}/doc-1`,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })
  })

  describe('predicate (iii): a target-exact single-verb GET or DELETE on a Space', () => {
    /**
     * The ladder VM's own bare `did:key` identity: the DID a predicate (iii)
     * delegation names as controller, and the verification method the matching
     * invocation is signed under. The deletion ceremony's delegatee is this key
     * rather than the `did:webvh` fragment -- it is the one identity that keeps
     * resolving while the walk deletes the Spaces every hosted document lives
     * in. Predicate (i) can never admit these chains: the controller is a bare
     * `did:key`, not the account document's annex `did:webvh`.
     *
     * @param keyPair {any}   the account's ladder key pair
     * @returns {{ did: string, signer: any }}
     */
    function bareDidKeyOf(keyPair: any): { did: string; signer: any } {
      const did = `did:key:${keyPair.publicKeyMultibase}`
      return {
        did,
        signer: {
          ...keyPair.signer(),
          id: `${did}#${keyPair.publicKeyMultibase}`
        }
      }
    }

    /**
     * Creates an ordinary Space under Alice's `did:key` and, when `controller`
     * is given, promotes it to that DID (Space creation is `did:key`-only).
     *
     * @param [options] {object}
     * @param [options.controller] {string}   promote the Space to this DID
     * @returns {Promise<{ spaceId: string, url: string, root: string }>}
     */
    async function makeSpace({
      controller
    }: { controller?: string } = {}): Promise<{
      spaceId: string
      url: string
      root: string
    }> {
      const spaceId = randomUUID()
      await alice.was
        .space(spaceId)
        .configure({ name: 'Unlock Space', controller: alice.did })
      if (controller !== undefined) {
        const promoted = await alice.was.request({
          path: `/space/${spaceId}`,
          method: 'PUT',
          json: { id: spaceId, name: 'Unlock Space', controller }
        })
        assert.equal(promoted.status, 204)
      }
      const url = new URL(`/space/${spaceId}`, serverUrl).toString()
      return { spaceId, url, root: `urn:zcap:root:${encodeURIComponent(url)}` }
    }

    it('admits a DELETE under a manageCapability parent, and the Space goes', async () => {
      // The three-link chain: a sibling unlock Space's root, the
      // `manageCapability` its `did:key` controller delegated to the account
      // DID, then the ladder-signed child that keeps the same bare target and
      // narrows the actions to `DELETE` alone.
      const unlock = await makeSpace()
      const manage = await client({ signer: alice.signer }).delegate({
        capability: unlock.root,
        invocationTarget: unlock.url,
        controller: account.did,
        allowedActions: ['GET', 'PUT', 'DELETE'],
        expires: anHourFromNow()
      })
      const ladder = bareDidKeyOf(account.ladderKeyPair)
      const child = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: manage,
        invocationTarget: unlock.url,
        controller: ladder.did,
        allowedActions: ['DELETE'],
        expires: new Date(manage.expires)
      })

      const deleted = await client({ signer: ladder.signer }).request({
        url: unlock.url,
        method: 'DELETE',
        action: 'DELETE',
        capability: child
      })
      assert.equal(deleted.status, 204)

      const gone = await requestError(
        client({ signer: alice.signer }).request({
          url: unlock.url,
          method: 'GET',
          action: 'GET',
          capability: rootZcap({ target: unlock.url, controller: alice.did })
        })
      )
      assert.equal(gone.status, 404)
    })

    it("admits a DELETE straight off an account Space's own root", async () => {
      // The two-link chain: the synthesized root's own target is the bare
      // Space URL, so the ladder-signed child matches it unchanged.
      const space = await makeSpace({ controller: account.did })
      const ladder = bareDidKeyOf(account.ladderKeyPair)
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: space.root,
        invocationTarget: space.url,
        controller: ladder.did,
        allowedActions: ['DELETE']
      })
      const deleted = await client({ signer: ladder.signer }).request({
        url: space.url,
        method: 'DELETE',
        action: 'DELETE',
        capability: delegated
      })
      assert.equal(deleted.status, 204)
    })

    it('admits the GET half: a Space Description read (200)', async () => {
      const space = await makeSpace({ controller: account.did })
      const ladder = bareDidKeyOf(account.ladderKeyPair)
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: space.root,
        invocationTarget: space.url,
        controller: ladder.did,
        allowedActions: ['GET']
      })
      const response = await client({ signer: ladder.signer }).request({
        url: space.url,
        method: 'GET',
        action: 'GET',
        capability: delegated
      })
      assert.equal(response.status, 200)
      const description = response.data as { id: string; controller: string }
      assert.equal(description.id, space.spaceId)
      assert.equal(description.controller, account.did)
    })

    it("refuses a target under the parent's Space rather than the Space (404)", async () => {
      const ladder = bareDidKeyOf(account.ladderKeyPair)
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: accountSpaceRoot(),
        invocationTarget: credentialsUrl,
        controller: ladder.did,
        allowedActions: ['GET']
      })
      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: `${credentialsUrl}/doc-1`,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses the trailing-slash form under a bare parent (404)', async () => {
      // The subtree URL is a different target from the parent's bare one, and
      // the account Space is not delegated-clients bookkeeping either.
      const ladder = bareDidKeyOf(account.ladderKeyPair)
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: accountSpaceRoot(),
        invocationTarget: `${accountSpaceUrl}/`,
        controller: ladder.did,
        allowedActions: ['GET']
      })
      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: `${credentialsUrl}/doc-1`,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses a two-verb {GET, DELETE} set on the bare target (404)', async () => {
      const ladder = bareDidKeyOf(account.ladderKeyPair)
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: accountSpaceRoot(),
        invocationTarget: accountSpaceUrl,
        controller: ladder.did,
        allowedActions: ['GET', 'DELETE']
      })
      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: accountSpaceUrl,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses a single verb outside {GET} and {DELETE} (404)', async () => {
      // `PUT` on the bare Space URL is Update Space Description, which could
      // rewrite the Space's controller.
      const ladder = bareDidKeyOf(account.ladderKeyPair)
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: accountSpaceRoot(),
        invocationTarget: accountSpaceUrl,
        controller: ladder.did,
        allowedActions: ['PUT']
      })
      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: accountSpaceUrl,
          method: 'PUT',
          action: 'PUT',
          capability: delegated,
          json: {
            id: account.spaceId,
            name: 'Account Space',
            controller: account.did
          }
        })
      )
      assert.equal(err.status, 404)
    })

    it('stops verifying once the ladder VM leaves the account document', async () => {
      // The current-key-set rule applied to the delegation link: the child is
      // minted and exercised while the ladder VM stands, then one log entry
      // drops that method from the document and the same still-unexpired child
      // refuses. A fresh account identity, so the removal leaves the suite's
      // shared one untouched.
      const retiring = await provisionWebvhIdentity({ withLadderKey: true })
      const space = await makeSpace({ controller: retiring.did })
      const ladder = bareDidKeyOf(retiring.ladderKeyPair)
      const deleteChild = await delegate({
        signerKeyPair: retiring.ladderKeyPair,
        capability: space.root,
        invocationTarget: space.url,
        controller: ladder.did,
        allowedActions: ['DELETE']
      })

      // A GET child of the same shape proves the chain verifies right now,
      // without spending the Space the DELETE child is aimed at.
      const readChild = await delegate({
        signerKeyPair: retiring.ladderKeyPair,
        capability: space.root,
        invocationTarget: space.url,
        controller: ladder.did,
        allowedActions: ['GET']
      })
      const before = await client({ signer: ladder.signer }).request({
        url: space.url,
        method: 'GET',
        action: 'GET',
        capability: readChild
      })
      assert.equal(before.status, 200)

      // The removal entry restates the document with the ordinary client key
      // alone, signed by the update key still in `updateKeys`. It lands in the
      // log's own Collection, so that write drops the cached document too.
      const removed = await updateDID({
        log: retiring.log,
        signer: retiring.logSigner,
        vmIdFragment: 'multibase',
        verificationMethods: [
          {
            type: 'Multikey',
            publicKeyMultibase: retiring.clientKeyPair.publicKeyMultibase!,
            purpose: [
              'authentication',
              'assertionMethod',
              'capabilityInvocation',
              'capabilityDelegation'
            ]
          }
        ] as any
      })
      const published = await alice.was.request({
        path: `/space/${retiring.spaceId}/id/did.jsonl`,
        method: 'PUT',
        headers: { 'content-type': 'text/jsonl' },
        body: new Blob([logToJsonlString(removed.log)], { type: 'text/jsonl' })
      })
      assert.equal(published.status, 204)

      const err = await requestError(
        client({ signer: ladder.signer }).request({
          url: space.url,
          method: 'DELETE',
          action: 'DELETE',
          capability: deleteChild
        })
      )
      assert.equal(err.status, 404)

      // The Space the refused DELETE was aimed at is still there, read back
      // under the client key the removal entry kept.
      const description = await client({
        signer: retiring.clientKeyPair.signer()
      }).request({
        url: space.url,
        method: 'GET',
        action: 'GET',
        capability: rootZcap({ target: space.url, controller: retiring.did })
      })
      assert.equal(description.status, 200)

      // The read half stops verifying with it, so nothing the ladder signed
      // survives the removal.
      const readErr = await requestError(
        client({ signer: ladder.signer }).request({
          url: space.url,
          method: 'GET',
          action: 'GET',
          capability: readChild
        })
      )
      assert.equal(readErr.status, 404)
    })
  })

  describe('the clause also runs on the /kms route family', () => {
    let keystoreId: string

    beforeAll(async () => {
      const config = await KmsClient.createKeystore({
        url: `${serverUrl}/kms/keystores`,
        config: { sequence: 0, controller: alice.did },
        invocationSigner: alice.signer
      })
      keystoreId = config.id!
      // Promote the keystore to the account DID, still authorized by the
      // stored `did:key`.
      const kmsClient = new KmsClient({ keystoreId })
      await kmsClient.updateKeystore({
        config: {
          id: keystoreId,
          sequence: 1,
          controller: account.did,
          kmsModule: 'local-v1'
        },
        invocationSigner: alice.signer
      })
    })

    it('an ordinary client VM still delegates keystore reads (200)', async () => {
      const delegated = await delegate({
        signerKeyPair: account.clientKeyPair,
        capability: rootZcap({
          target: keystoreId,
          controller: account.did
        }),
        invocationTarget: keystoreId,
        controller: bob.did,
        allowedActions: ['read']
      })
      const response = await client({ signer: bob.signer }).request({
        url: keystoreId,
        method: 'GET',
        action: 'read',
        capability: delegated
      })
      assert.equal(response.status, 200)
    })

    it('a ladder-signed keystore delegation is refused (404)', async () => {
      // No kms target can be bridge-shaped, and a `/kms/...` path is not
      // inside any Space's items subtree, so no predicate can hold.
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: rootZcap({
          target: keystoreId,
          controller: account.did
        }),
        invocationTarget: keystoreId,
        controller: bob.did,
        allowedActions: ['read']
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: keystoreId,
          method: 'GET',
          action: 'read',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses a keystore delegation to the annex DID (404)', async () => {
      // The grantee bound of predicate (i) holds -- the sole controller is the
      // annex DID the account document names -- and the delegation is still
      // refused: a `/kms/...` target is outside the account Space's items
      // subtree.
      const delegated = await delegate({
        signerKeyPair: account.ladderKeyPair,
        capability: rootZcap({
          target: keystoreId,
          controller: account.did
        }),
        invocationTarget: keystoreId,
        controller: clientAnnex.did,
        allowedActions: ['read']
      })
      const err = await requestError(
        client({ signer: clientAnnex.clientKeyPair.signer() }).request({
          url: keystoreId,
          method: 'GET',
          action: 'read',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })
  })
})
