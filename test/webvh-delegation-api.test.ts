/**
 * Delegation shapes that the zcap layer accepts (Vitest), pinned end to end:
 *
 * - a capability delegated to a *self-hosted `did:webvh`* third party, invoked
 *   with that DID's own key -- the account DID's document is never touched, so
 *   sharing costs zero membership changes;
 * - a depth-3 chain (root, an intermediate delegate, a further-attenuated
 *   delegate) invoked at its tail;
 * - a capability whose `invocationTarget` is a Space's trailing-slash subtree
 *   URL, invoked against a Collection's `policy` resource underneath it.
 *
 * Invocations are raw `@interop/ezcap` requests (and, where the ezcap client's
 * own RESTful-prefix check would refuse a subtree target, a hand-signed
 * invocation via `@interop/http-signature-zcap-invoke`): these are wire-level
 * authorization shapes, not the high-level `@interop/was-client` surface.
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
import type { DIDLog, Signer } from '@interop/did-method-webvh'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import {
  client,
  requestError,
  startTestServer,
  zcapClients
} from './helpers.js'

/** A minted, published self-hosted `did:webvh` and its enrolled client key. */
interface WebvhIdentity {
  spaceId: string
  did: string
  log: DIDLog
  logSigner: Signer
  clientKeyPair: any
}

describe('did:webvh delegation and chain depth', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    aliceDelegatedApp: any,
    bob: any

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

  /**
   * Mints a `did:webvh` whose log is anchored at `<serverUrl>/space/<id>/id`,
   * listing one enrolled client key under every verification relationship a
   * zcap needs.
   *
   * @param options {object}
   * @param options.spaceId {string}   the Space the log will be published in
   * @returns {Promise<object>}
   */
  async function mintWebvhDid({ spaceId }: { spaceId: string }) {
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

    const created = await createDID({
      address: `${serverUrl}/space/${spaceId}/id`,
      signer: logSigner,
      updateKeys: [updateKeyPair.publicKeyMultibase!],
      vmIdFragment: 'multibase',
      verificationMethods: [
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
    })
    clientKeyPair.id = `${created.did}#${clientKeyPair.publicKeyMultibase}`
    clientKeyPair.controller = created.did

    return { did: created.did, log: created.log, logSigner, clientKeyPair }
  }

  /**
   * Provisions a Space controlled by Alice's `did:key`, mints a `did:webvh`
   * anchored in that Space's world-readable `id` Collection, and publishes its
   * history log there. Promotion of the Space is left to the caller: a DID's
   * log may be hosted by a Space it does not control.
   *
   * @returns {Promise<WebvhIdentity>}
   */
  async function provisionWebvhIdentity(): Promise<WebvhIdentity> {
    const spaceId = randomUUID()
    const space = alice.was.space(spaceId)
    await space.configure({ name: 'Identity Space', controller: alice.did })
    const idCollection = space.collection('id')
    await idCollection.configure({ force: true })
    await idCollection.setPublic()

    const minted = await mintWebvhDid({ spaceId })
    const published = await alice.was.request({
      path: `/space/${spaceId}/id/did.jsonl`,
      method: 'PUT',
      headers: { 'content-type': 'text/jsonl' },
      body: new Blob([logToJsonlString(minted.log)], { type: 'text/jsonl' })
    })
    assert.equal(published.status, 204)

    return { spaceId, ...minted }
  }

  describe('delegating to a self-hosted did:webvh (zero membership changes)', () => {
    let account: WebvhIdentity
    let delegate: WebvhIdentity
    let collectionUrl: string
    let delegated: any

    beforeAll(async () => {
      // The account DID: its log is anchored in the Space it goes on to
      // control (the wallet's own ordering).
      account = await provisionWebvhIdentity()
      const accountSpace = alice.was.space(account.spaceId)
      await accountSpace.collection('credentials').configure({ force: true })
      await accountSpace
        .collection('credentials')
        .put('doc-1', { hello: 'world' })
      const promoted = await alice.was.request({
        path: `/space/${account.spaceId}`,
        method: 'PUT',
        json: {
          id: account.spaceId,
          name: 'Identity Space',
          controller: account.did
        }
      })
      assert.equal(promoted.status, 204)

      // The delegate DID is a separate self-hosted `did:webvh`, anchored in a
      // Space of its own. It is never listed in the account DID's document.
      delegate = await provisionWebvhIdentity()

      collectionUrl = new URL(
        `/space/${account.spaceId}/credentials`,
        serverUrl
      ).toString()
    })

    it('the account controller delegates to the delegate did:webvh', async () => {
      const spaceUrl = new URL(
        `/space/${account.spaceId}`,
        serverUrl
      ).toString()
      delegated = await client({
        signer: account.clientKeyPair.signer()
      }).delegate({
        capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
        invocationTarget: collectionUrl,
        controller: delegate.did,
        allowedActions: ['GET'],
        expires: new Date(Date.now() + 60 * 60 * 1000)
      })
      assert.equal(delegated.controller, delegate.did)
    })

    it('the delegate invokes it with its own did:webvh key', async () => {
      const response = await client({
        signer: delegate.clientKeyPair.signer()
      }).request({
        url: `${collectionUrl}/doc-1`,
        method: 'GET',
        action: 'GET',
        capability: delegated
      })
      assert.equal(response.status, 200)
      assert.deepStrictEqual(response.data, { hello: 'world' })
    })

    it('the account DID document was never modified (zero membership changes)', async () => {
      // One log entry, one verification method: the delegate's key was never
      // enrolled in the account document to make the read above work.
      assert.equal(account.log.length, 1)
      const methods = account.log[account.log.length - 1]!.state
        .verificationMethod as Array<{ publicKeyMultibase?: string }>
      assert.equal(methods.length, 1)
      assert.equal(
        methods[0]!.publicKeyMultibase,
        account.clientKeyPair.publicKeyMultibase
      )
    })

    it('a key the delegate document does not list is refused', async () => {
      // Same keyId (the fragment the delegate document lists), different key
      // material: the signature cannot verify against the resolved method.
      const rogueKeyPair = await Ed25519VerificationKey.generate()
      rogueKeyPair.id = delegate.clientKeyPair.id
      rogueKeyPair.controller = delegate.did

      const err = await requestError(
        client({ signer: rogueKeyPair.signer() }).request({
          url: `${collectionUrl}/doc-1`,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)
    })

    it('a keyId fragment absent from the delegate document is refused', async () => {
      const unlistedKeyPair = await Ed25519VerificationKey.generate()
      unlistedKeyPair.id = `${delegate.did}#${unlistedKeyPair.publicKeyMultibase}`
      unlistedKeyPair.controller = delegate.did

      const err = await requestError(
        client({ signer: unlistedKeyPair.signer() }).request({
          url: `${collectionUrl}/doc-1`,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      // The keyId does not resolve at all, so verification *errors* -- the 400
      // `invalid-authorization-header`, not the 404 an unauthorized-but-
      // verified invocation is masked as.
      assert.equal(err.status, 400)
    })
  })

  describe('a depth-3 delegation chain', () => {
    const spaceId = randomUUID()
    const collectionId = 'credentials'
    let spaceUrl: string
    let collectionUrl: string
    let docUrl: string
    // root -> B (the intermediate) -> C (the tail)
    let intermediateCap: any
    let tailCap: any

    beforeAll(async () => {
      spaceUrl = new URL(`/space/${spaceId}`, serverUrl).toString()
      collectionUrl = new URL(
        `/space/${spaceId}/${collectionId}`,
        serverUrl
      ).toString()
      docUrl = `${collectionUrl}/doc-1`

      const space = alice.was.space(spaceId)
      await space.configure({ name: 'Chain Space', controller: alice.did })
      await space.collection(collectionId).configure({ force: true })
      await space.collection(collectionId).put('doc-1', { hello: 'world' })

      // The Space controller delegates the Collection to B...
      intermediateCap = await client({ signer: alice.signer }).delegate({
        capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
        invocationTarget: collectionUrl,
        controller: aliceDelegatedApp.did,
        allowedActions: ['GET', 'PUT'],
        expires: new Date(Date.now() + 60 * 60 * 1000)
      })
      // ...and B attenuates it down to one Resource, read-only, for C.
      tailCap = await client({ signer: aliceDelegatedApp.signer }).delegate({
        capability: intermediateCap,
        invocationTarget: docUrl,
        controller: bob.did,
        allowedActions: ['GET'],
        expires: new Date(Date.now() + 30 * 60 * 1000)
      })
    })

    it('the tail delegate reads through the full chain', async () => {
      const response = await client({ signer: bob.signer }).request({
        url: docUrl,
        method: 'GET',
        action: 'GET',
        capability: tailCap
      })
      assert.equal(response.status, 200)
      assert.deepStrictEqual(response.data, { hello: 'world' })
    })

    it('the tail cannot exceed what the middle link granted', async () => {
      // The middle link allows PUT, but the tail's own `allowedAction` is
      // GET-only, so a write does not verify.
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: docUrl,
          method: 'PUT',
          action: 'PUT',
          capability: tailCap,
          json: { escape: true }
        })
      )
      assert.equal(err.status, 404)
      assert.deepStrictEqual(
        await alice.was.space(spaceId).collection(collectionId).get('doc-1'),
        { hello: 'world' }
      )
    })

    it('a middle delegation signed by the wrong key breaks the chain', async () => {
      // Bob (the tail) signs the middle-to-tail delegation himself, rather
      // than B: the delegation proof's signer is not the parent capability's
      // controller, so the chain does not verify.
      const forgedTailCap = await client({ signer: bob.signer }).delegate({
        capability: intermediateCap,
        invocationTarget: docUrl,
        controller: bob.did,
        allowedActions: ['GET'],
        expires: new Date(Date.now() + 30 * 60 * 1000)
      })
      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: docUrl,
          method: 'GET',
          action: 'GET',
          capability: forgedTailCap
        })
      )
      assert.equal(err.status, 404)
    })
  })

  describe('a trailing-slash subtree capability', () => {
    const spaceId = randomUUID()
    const collectionId = 'notes'
    let spaceUrl: string
    let subtreeCap: any

    beforeAll(async () => {
      spaceUrl = new URL(`/space/${spaceId}`, serverUrl).toString()
      const space = alice.was.space(spaceId)
      await space.configure({ name: 'Subtree Space', controller: alice.did })
      await space.collection(collectionId).configure({ force: true })
      await space.collection(collectionId).put('note-1', { open: true })

      // One capability for the whole Space *subtree*: the trailing slash is
      // its own boundary prefix, so everything under `/space/<id>/` is a valid
      // attenuation of it.
      subtreeCap = await client({ signer: alice.signer }).delegate({
        capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
        invocationTarget: `${spaceUrl}/`,
        controller: aliceDelegatedApp.did,
        allowedActions: ['GET', 'PUT'],
        expires: new Date(Date.now() + 60 * 60 * 1000)
      })
    })

    /**
     * Invokes `subtreeCap` by hand: the ezcap client refuses to pair a URL
     * with a capability whose `invocationTarget` already ends in `/` (its own
     * prefix check appends another `/`), while the server's zcap layer accepts
     * exactly that shape.
     *
     * @param options {object}
     * @param options.url {string}   the absolute URL to invoke
     * @param options.method {string}
     * @param [options.json] {object}   a JSON request body
     * @returns {Promise<Response>}
     */
    async function invokeSubtree({
      url,
      method,
      json
    }: {
      url: string
      method: string
      json?: object
    }): Promise<Response> {
      const headers = await signCapabilityInvocation({
        url,
        method,
        headers:
          json === undefined ? {} : { 'content-type': 'application/json' },
        json,
        capability: subtreeCap,
        capabilityAction: method,
        invocationSigner: aliceDelegatedApp.signer
      })
      return fetch(url, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json)
      })
    }

    it('the delegate PUTs a Collection policy under the subtree target', async () => {
      const policyUrl = new URL(
        `/space/${spaceId}/${collectionId}/policy`,
        serverUrl
      ).toString()
      const response = await invokeSubtree({
        url: policyUrl,
        method: 'PUT',
        json: { type: 'PublicCanRead' }
      })
      assert.equal(response.status, 201)
    })

    it('the policy it wrote is in effect (anonymous read succeeds)', async () => {
      const response = await fetch(
        new URL(`/space/${spaceId}/${collectionId}/note-1`, serverUrl)
      )
      assert.equal(response.status, 200)
      assert.deepStrictEqual(await response.json(), { open: true })
    })

    it('the same capability reads the policy back', async () => {
      const policyUrl = new URL(
        `/space/${spaceId}/${collectionId}/policy`,
        serverUrl
      ).toString()
      const response = await invokeSubtree({ url: policyUrl, method: 'GET' })
      assert.equal(response.status, 200)
      assert.deepStrictEqual(await response.json(), { type: 'PublicCanRead' })
    })
  })
})
