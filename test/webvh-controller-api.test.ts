/**
 * Self-hosted `did:webvh` Space-controller tests (Vitest): promotion by PUT,
 * the capability-verification branch that follows, and the refusals that guard
 * both.
 *
 * The flow under test is "promotion by ordering": a Space is created with a
 * `did:key` controller, its history log is published into one of its
 * Collections, and a PUT of the Space Description -- still authorized by the
 * stored `did:key` -- swaps the controller to the `did:webvh` that log resolves
 * to. From then on every invocation is verified against the *currently
 * resolved* document, read out of local storage and fully verified (never
 * fetched, never trusted).
 *
 * The log's location is carried by the DID string, so it is not restricted to
 * the conventional world-readable `id` Collection: the later sections cover an
 * arbitrarily named, capability-gated log Collection and a controller whose log
 * lives in a different Space than the one it controls.
 *
 * Logs are built in-test with the same `@interop/did-method-webvh` the server
 * resolves with, signed by a locally generated update key.
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
import type { DIDLog, Signer } from '@interop/did-method-webvh'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { spaceRevocationsPath } from '../src/lib/paths.js'
import {
  client,
  requestError,
  rootZcap,
  startTestServer,
  wasClient,
  zcapClients
} from './helpers.js'

/** A Space promoted to (or being prepared for) a did:webvh controller. */
interface WebvhSpace {
  spaceId: string
  /** the Collection the DID's history log is published in */
  logCollectionId: string
  did: string
  log: DIDLog
  /** signs history-log entries (the DID's update key) */
  logSigner: Signer
  /** the enrolled wallet client key listed in the DID document */
  clientKeyPair: any
  /** a `WasClient` signing with that client key */
  was: any
}

describe('did:webvh Space controller', () => {
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
   * Builds a `did:webvh` whose log is anchored at
   * `<serverUrl>/space/<id>/<collectionId>`, with one enrolled client key listed
   * for every verification relationship a zcap needs.
   *
   * @param options {object}
   * @param options.spaceId {string}   the Space the log will be published in
   * @param [options.collectionId] {string}   the Collection the log will be
   *   published in (any URL-safe Collection name; defaults to `id`)
   * @param [options.address] {string}   override the anchoring address (used by
   *   the cross-host case)
   * @returns {Promise<object>}
   */
  async function mintWebvhDid({
    spaceId,
    collectionId = 'id',
    address
  }: {
    spaceId: string
    collectionId?: string
    address?: string
  }) {
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
      address: address ?? `${serverUrl}/space/${spaceId}/${collectionId}`,
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
    // The wallet client signs invocations with `<did:webvh>#<multibase>`.
    clientKeyPair.id = `${created.did}#${clientKeyPair.publicKeyMultibase}`
    clientKeyPair.controller = created.did

    return {
      did: created.did,
      log: created.log,
      logSigner,
      clientKeyPair,
      updateKeyPair
    }
  }

  /**
   * Publishes a history log as `did.jsonl` in a Collection of a Space.
   *
   * @param options {object}
   * @param options.signerClient {any}   the WAS client authorized to write
   * @param options.spaceId {string}
   * @param [options.collectionId] {string}   defaults to `id`
   * @param options.jsonl {string}   the JSON Lines log
   * @returns {Promise<any>}
   */
  async function publishLog({
    signerClient,
    spaceId,
    collectionId = 'id',
    jsonl
  }: {
    signerClient: any
    spaceId: string
    collectionId?: string
    jsonl: string
  }) {
    return signerClient.request({
      path: `/space/${spaceId}/${collectionId}/did.jsonl`,
      method: 'PUT',
      headers: { 'content-type': 'text/jsonl' },
      body: new Blob([jsonl], { type: 'text/jsonl' })
    })
  }

  /**
   * Provisions a Space controlled by Alice's `did:key`, with a private
   * `credentials` Collection and a log Collection carrying a freshly minted
   * DID's history log. Stops short of the promotion PUT so the refusal cases can
   * use the same setup.
   *
   * @param [options] {object}
   * @param [options.logCollectionId] {string}   which Collection hosts the log
   *   (defaults to the conventional world-readable `id`)
   * @param [options.publicLogCollection] {boolean}   attach a `PublicCanRead`
   *   policy to the log Collection (defaults to true)
   * @returns {Promise<WebvhSpace>}
   */
  async function provisionSpace({
    logCollectionId = 'id',
    publicLogCollection = true
  }: {
    logCollectionId?: string
    publicLogCollection?: boolean
  } = {}): Promise<WebvhSpace> {
    const spaceId = randomUUID()
    const space = alice.was.space(spaceId)
    await space.configure({ name: 'Promotable Space', controller: alice.did })
    await space.collection('credentials').configure({ force: true })
    await space.collection('credentials').put('doc-1', { hello: 'world' })
    const logCollection = space.collection(logCollectionId)
    await logCollection.configure({ force: true })
    if (publicLogCollection) {
      await logCollection.setPublic()
    }

    const minted = await mintWebvhDid({
      spaceId,
      collectionId: logCollectionId
    })
    const published = await publishLog({
      signerClient: alice.was,
      spaceId,
      collectionId: logCollectionId,
      jsonl: logToJsonlString(minted.log)
    })
    assert.equal(published.status, 204)

    return {
      spaceId,
      logCollectionId,
      did: minted.did,
      log: minted.log,
      logSigner: minted.logSigner,
      clientKeyPair: minted.clientKeyPair,
      was: wasClient({ signer: minted.clientKeyPair.signer(), serverUrl })
    }
  }

  /**
   * Swaps a Space's controller to `controller`, authorized by whichever client
   * currently controls it.
   *
   * @param options {object}
   * @param options.signerClient {any}   the authorized WAS client
   * @param options.spaceId {string}
   * @param options.controller {string}   the proposed controller DID
   * @returns {Promise<any>}
   */
  async function promote({
    signerClient,
    spaceId,
    controller
  }: {
    signerClient: any
    spaceId: string
    controller: string
  }) {
    return signerClient.request({
      path: `/space/${spaceId}`,
      method: 'PUT',
      json: { id: spaceId, name: 'Promotable Space', controller }
    })
  }

  describe('promotion round-trip', () => {
    let space: WebvhSpace

    beforeAll(async () => {
      space = await provisionSpace()
    })

    it('PUT Space with a self-hosted did:webvh controller succeeds (204)', async () => {
      const response = await promote({
        signerClient: alice.was,
        spaceId: space.spaceId,
        controller: space.did
      })
      assert.equal(response.status, 204)
    })

    it('the stored controller is the did:webvh', async () => {
      const description = await space.was.space(space.spaceId).describe()
      assert.equal(description.controller, space.did)
    })

    it('the enrolled client key reads under the root capability', async () => {
      const doc = await space.was
        .space(space.spaceId)
        .collection('credentials')
        .get('doc-1')
      assert.deepStrictEqual(doc, { hello: 'world' })
    })

    it('the enrolled client key writes under the root capability', async () => {
      await space.was
        .space(space.spaceId)
        .collection('credentials')
        .put('doc-2', { written: 'by webvh' })
      const doc = await space.was
        .space(space.spaceId)
        .collection('credentials')
        .get('doc-2')
      assert.deepStrictEqual(doc, { written: 'by webvh' })
    })

    it('the old did:key controller no longer authorizes (current-key-set)', async () => {
      // The raw request, not the high-level `get()`: the latter maps the
      // masked 404 to `null`, which would hide the denial being asserted.
      const err = await requestError(
        client({ signer: alice.signer }).request({
          url: new URL(
            `/space/${space.spaceId}/credentials/doc-1`,
            serverUrl
          ).toString(),
          method: 'GET',
          action: 'GET',
          capability: rootZcap({
            target: new URL(`/space/${space.spaceId}`, serverUrl).toString(),
            controller: alice.did
          })
        })
      )
      assert.equal(err.status, 404)
    })
  })

  describe('delegation under a did:webvh controller', () => {
    let space: WebvhSpace
    let spaceUrl: string
    let collectionUrl: string
    let delegated: any

    beforeAll(async () => {
      space = await provisionSpace()
      const response = await promote({
        signerClient: alice.was,
        spaceId: space.spaceId,
        controller: space.did
      })
      assert.equal(response.status, 204)
      spaceUrl = new URL(`/space/${space.spaceId}`, serverUrl).toString()
      collectionUrl = new URL(
        `/space/${space.spaceId}/credentials`,
        serverUrl
      ).toString()
    })

    it('the webvh controller delegates a read capability to a third party', async () => {
      delegated = await client({
        signer: space.clientKeyPair.signer()
      }).delegate({
        capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
        invocationTarget: collectionUrl,
        controller: bob.did,
        allowedActions: ['GET'],
        expires: new Date(Date.now() + 60 * 60 * 1000)
      })
      assert.equal(delegated.controller, bob.did)
    })

    it('the delegate invokes it successfully', async () => {
      const response = await client({ signer: bob.signer }).request({
        url: `${collectionUrl}/doc-1`,
        method: 'GET',
        action: 'GET',
        capability: delegated
      })
      assert.equal(response.status, 200)
      assert.deepStrictEqual(response.data, { hello: 'world' })
    })

    it('publishing a log update that drops the delegator key stops it', async () => {
      // Rotate the enrolled client key: the DID document now lists a different
      // verification method, so the delegation proof's method is no longer in
      // the current key set.
      const replacementKey = await Ed25519VerificationKey.generate()
      const updated = await updateDID({
        log: space.log,
        signer: space.logSigner,
        vmIdFragment: 'multibase',
        verificationMethods: [
          {
            type: 'Multikey',
            publicKeyMultibase: replacementKey.publicKeyMultibase!,
            purpose: [
              'authentication',
              'assertionMethod',
              'capabilityInvocation',
              'capabilityDelegation'
            ]
          }
        ]
      })
      // The still-current client key authorizes the write of its own removal.
      const published = await publishLog({
        signerClient: space.was,
        spaceId: space.spaceId,
        jsonl: logToJsonlString(updated.log)
      })
      assert.equal(published.status, 204)

      const err = await requestError(
        client({ signer: bob.signer }).request({
          url: `${collectionUrl}/doc-1`,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      )
      assert.equal(err.status, 404)

      // The replacement key is what works now (the invalidation on the
      // `id`-collection write took effect immediately).
      replacementKey.id = `${space.did}#${replacementKey.publicKeyMultibase}`
      replacementKey.controller = space.did
      const rotatedClient = wasClient({
        signer: replacementKey.signer(),
        serverUrl
      })
      const doc = await rotatedClient
        .space(space.spaceId)
        .collection('credentials')
        .get('doc-1')
      assert.deepStrictEqual(doc, { hello: 'world' })
    })
  })

  describe('refusals at promotion time', () => {
    it('a cross-host did:webvh is refused (400, #/controller)', async () => {
      const space = await provisionSpace()
      const foreign = await mintWebvhDid({
        spaceId: space.spaceId,
        address: `https://evil.example/space/${space.spaceId}/id`
      })
      const err = await requestError(
        promote({
          signerClient: alice.was,
          spaceId: space.spaceId,
          controller: foreign.did
        })
      )
      assert.equal(err.status, 400)
      assert.equal(err.data.errors[0].pointer, '#/controller')
      // The stored controller is untouched.
      const description = await alice.was.space(space.spaceId).describe()
      assert.equal(description.controller, alice.did)
    })

    it('a did:web controller is refused (400, #/controller)', async () => {
      const space = await provisionSpace()
      const err = await requestError(
        promote({
          signerClient: alice.was,
          spaceId: space.spaceId,
          controller: 'did:web:localhost'
        })
      )
      assert.equal(err.status, 400)
      assert.equal(err.data.errors[0].pointer, '#/controller')
    })

    it('a self-hosted did:webvh with no published log is refused (400)', async () => {
      const spaceId = randomUUID()
      const space = alice.was.space(spaceId)
      await space.configure({ name: 'No Log', controller: alice.did })
      // Mint the DID but never publish its log.
      const minted = await mintWebvhDid({ spaceId })

      const err = await requestError(
        promote({ signerClient: alice.was, spaceId, controller: minted.did })
      )
      assert.equal(err.status, 400)
      assert.equal(err.data.errors[0].pointer, '#/controller')
    })

    it('a did:webvh whose SCID does not match its log is refused (400)', async () => {
      const space = await provisionSpace()
      // Same host, same Space, same shape -- a different SCID. The log is
      // published and verifies internally, but it is not this DID's log.
      const otherScid = (
        await mintWebvhDid({ spaceId: space.spaceId })
      ).did.split(':')[2]!
      const wrongScidDid = space.did.replace(
        space.did.split(':')[2]!,
        otherScid
      )
      assert.notEqual(wrongScidDid, space.did)

      const err = await requestError(
        promote({
          signerClient: alice.was,
          spaceId: space.spaceId,
          controller: wrongScidDid
        })
      )
      assert.equal(err.status, 400)
      assert.equal(err.data.errors[0].pointer, '#/controller')
    })

    it('a tampered log (bad proof on the last entry) is refused (400)', async () => {
      const spaceId = randomUUID()
      const space = alice.was.space(spaceId)
      await space.configure({ name: 'Tampered', controller: alice.did })
      await space.collection('id').configure({ force: true })
      const minted = await mintWebvhDid({ spaceId })

      // Alter the genesis entry's document state, leaving its proof in place.
      const tampered = structuredClone(minted.log) as DIDLog
      tampered[tampered.length - 1]!.state.alsoKnownAs = ['did:example:pwned']
      const published = await publishLog({
        signerClient: alice.was,
        spaceId,
        jsonl: logToJsonlString(tampered)
      })
      assert.equal(published.status, 204)

      const err = await requestError(
        promote({ signerClient: alice.was, spaceId, controller: minted.did })
      )
      assert.equal(err.status, 400)
      assert.equal(err.data.errors[0].pointer, '#/controller')
    })
  })

  describe('a forged log after promotion', () => {
    it('stops invocations rather than being silently trusted', async () => {
      const space = await provisionSpace()
      assert.equal(
        (
          await promote({
            signerClient: alice.was,
            spaceId: space.spaceId,
            controller: space.did
          })
        ).status,
        204
      )
      // Sanity: the enrolled key works before the forgery.
      assert.deepStrictEqual(
        await space.was
          .space(space.spaceId)
          .collection('credentials')
          .get('doc-1'),
        { hello: 'world' }
      )

      // Replace the stored log with one whose last entry has been altered.
      const forged = structuredClone(space.log) as DIDLog
      forged[forged.length - 1]!.state.alsoKnownAs = ['did:example:pwned']
      const published = await publishLog({
        signerClient: space.was,
        spaceId: space.spaceId,
        jsonl: logToJsonlString(forged)
      })
      assert.equal(published.status, 204)

      // The cache was invalidated by that very write, so the forgery takes
      // effect immediately -- as a *failure* to resolve, never as trust. The
      // controller document no longer resolves at all, so the keyId lookup
      // errors out: that is the 400 `invalid-authorization-header` every
      // verification error yields, not the 404 an unauthorized-but-verified
      // invocation is masked as.
      const err = await requestError(
        client({ signer: space.clientKeyPair.signer() }).request({
          url: new URL(
            `/space/${space.spaceId}/credentials/doc-1`,
            serverUrl
          ).toString(),
          method: 'GET',
          action: 'GET',
          capability: rootZcap({
            target: new URL(`/space/${space.spaceId}`, serverUrl).toString(),
            controller: space.did
          })
        })
      )
      assert.equal(err.status, 400)
    })
  })

  describe('revocation under a did:webvh controller', () => {
    it('the webvh controller revokes a capability it delegated', async () => {
      const space = await provisionSpace()
      assert.equal(
        (
          await promote({
            signerClient: alice.was,
            spaceId: space.spaceId,
            controller: space.did
          })
        ).status,
        204
      )
      const spaceUrl = new URL(`/space/${space.spaceId}`, serverUrl).toString()
      const collectionUrl = new URL(
        `/space/${space.spaceId}/credentials`,
        serverUrl
      ).toString()

      const delegated = await client({
        signer: space.clientKeyPair.signer()
      }).delegate({
        capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
        invocationTarget: collectionUrl,
        controller: bob.did,
        allowedActions: ['GET'],
        expires: new Date(Date.now() + 60 * 60 * 1000)
      })

      const readDoc = () =>
        client({ signer: bob.signer }).request({
          url: `${collectionUrl}/doc-1`,
          method: 'GET',
          action: 'GET',
          capability: delegated
        })
      assert.equal((await readDoc()).status, 200)

      const revocation = await client({
        signer: space.clientKeyPair.signer()
      }).request({
        url: new URL(
          spaceRevocationsPath({
            spaceId: space.spaceId,
            revocationId: delegated.id
          }),
          serverUrl
        ).toString(),
        method: 'POST',
        action: 'POST',
        capability: rootZcap({ target: spaceUrl, controller: space.did }),
        json: delegated
      })
      assert.equal(revocation.status, 204)

      const err = await requestError(readDoc())
      assert.equal(err.status, 404)
    })
  })

  describe('a log in an arbitrarily named Collection', () => {
    // The DID form carries the log's Collection, so the log may live in any
    // Collection whose name round-trips the DID path encoding -- not only the
    // conventional `id`. This one is also capability-gated (no public-read
    // policy): the server resolves it by reading its own storage, so a DID
    // resolves for authorization while its log stays unreadable to outsiders.
    let space: WebvhSpace

    beforeAll(async () => {
      space = await provisionSpace({
        logCollectionId: 'clientAnnex-0',
        publicLogCollection: false
      })
    })

    it('the minted DID names that Collection', () => {
      assert.equal(space.did.split(':').length, 7)
      assert.equal(space.did.split(':')[6], 'clientAnnex-0')
    })

    it('promotes the Space to it (204)', async () => {
      const response = await promote({
        signerClient: alice.was,
        spaceId: space.spaceId,
        controller: space.did
      })
      assert.equal(response.status, 204)
      const description = await space.was.space(space.spaceId).describe()
      assert.equal(description.controller, space.did)
    })

    it('the enrolled client key invokes against the promoted Space', async () => {
      const doc = await space.was
        .space(space.spaceId)
        .collection('credentials')
        .get('doc-1')
      assert.deepStrictEqual(doc, { hello: 'world' })
      await space.was
        .space(space.spaceId)
        .collection('credentials')
        .put('doc-3', { written: 'by webvh' })
    })

    it('an anonymous read of the log itself is still refused (404)', async () => {
      const response = await fetch(
        new URL(
          `/space/${space.spaceId}/clientAnnex-0/did.jsonl`,
          serverUrl
        ).toString()
      )
      assert.equal(response.status, 404)
    })

    it('a log rotation takes effect on the next verification', async () => {
      // Rotate the enrolled client key and republish the log. The write lands
      // in the log's own Collection, so the cached document is dropped by that
      // very write -- no stale key set survives it.
      const replacementKey = await Ed25519VerificationKey.generate()
      const updated = await updateDID({
        log: space.log,
        signer: space.logSigner,
        vmIdFragment: 'multibase',
        verificationMethods: [
          {
            type: 'Multikey',
            publicKeyMultibase: replacementKey.publicKeyMultibase!,
            purpose: [
              'authentication',
              'assertionMethod',
              'capabilityInvocation',
              'capabilityDelegation'
            ]
          }
        ]
      })
      // The still-current client key authorizes the write of its own removal.
      const published = await publishLog({
        signerClient: space.was,
        spaceId: space.spaceId,
        collectionId: 'clientAnnex-0',
        jsonl: logToJsonlString(updated.log)
      })
      assert.equal(published.status, 204)

      // The rotated-in key is the one that verifies now...
      replacementKey.id = `${space.did}#${replacementKey.publicKeyMultibase}`
      replacementKey.controller = space.did
      const rotatedClient = wasClient({
        signer: replacementKey.signer(),
        serverUrl
      })
      assert.deepStrictEqual(
        await rotatedClient
          .space(space.spaceId)
          .collection('credentials')
          .get('doc-1'),
        { hello: 'world' }
      )

      // ...and the rotated-out one no longer does.
      const err = await requestError(
        space.was.request({
          path: `/space/${space.spaceId}/credentials/doc-1`,
          method: 'GET'
        })
      )
      assert.equal(err.status, 400)
    })
  })

  describe('a controller whose log lives in another Space', () => {
    // The DID string carries its own log location, so the Space a DID controls
    // need not be the Space its log is published in.
    let logSpace: WebvhSpace
    let controlledSpaceId: string

    beforeAll(async () => {
      logSpace = await provisionSpace({ logCollectionId: 'clientAnnex-1' })
      controlledSpaceId = randomUUID()
      await alice.was
        .space(controlledSpaceId)
        .configure({ name: 'Controlled Space', controller: alice.did })
    })

    it('promotes a second Space to a DID anchored in the first (204)', async () => {
      const response = await promote({
        signerClient: alice.was,
        spaceId: controlledSpaceId,
        controller: logSpace.did
      })
      assert.equal(response.status, 204)
      const description = await logSpace.was.space(controlledSpaceId).describe()
      assert.equal(description.controller, logSpace.did)
      // The DID's log is anchored in the *other* Space.
      assert.equal(logSpace.did.split(':')[5], logSpace.spaceId)
      assert.notEqual(logSpace.spaceId, controlledSpaceId)
    })

    it('the cross-Space controller key invokes on the controlled Space', async () => {
      const response = await logSpace.was.request({
        path: `/space/${controlledSpaceId}/`,
        method: 'POST',
        json: { id: 'cross-space-collection', name: 'Made by webvh' }
      })
      assert.equal(response.status, 201)
    })

    it('deleting the log in the hosting Space stops those invocations', async () => {
      // The hosting Space is still controlled by Alice's did:key, so she may
      // remove the log -- which is the controlled Space's only key material.
      const deleted = await alice.was.request({
        path: `/space/${logSpace.spaceId}/clientAnnex-1/did.jsonl`,
        method: 'DELETE'
      })
      assert.equal(deleted.status, 204)

      // The invalidation is keyed by the log's location, in the OTHER Space, so
      // the cross-Space cache entry must go with it.
      const err = await requestError(
        logSpace.was.request({
          path: `/space/${controlledSpaceId}/`,
          method: 'POST',
          json: { id: 'after-log-deletion' }
        })
      )
      assert.equal(err.status, 400)

      // Reads are refused on the same terms: with no resolvable controller
      // document there is no key to verify against, which surfaces as the 400
      // every verification error yields (not the 404 an unauthorized-but-
      // verified invocation is masked as).
      const readErr = await requestError(
        logSpace.was.request({
          path: `/space/${controlledSpaceId}`,
          method: 'GET'
        })
      )
      assert.equal(readErr.status, 400)
    })
  })

  describe('keystore promotion (/kms facet)', () => {
    let space: WebvhSpace, keystoresUrl: string, keystoreId: string

    beforeAll(async () => {
      keystoresUrl = `${serverUrl}/kms/keystores`
      space = await provisionSpace()
      // Promote the Space itself first (the wallet's ordering).
      const promoted = await promote({
        signerClient: alice.was,
        spaceId: space.spaceId,
        controller: space.did
      })
      assert.equal(promoted.status, 204)
      // The keystore was created under the did:key, pre-promotion.
      const config = await KmsClient.createKeystore({
        url: keystoresUrl,
        config: { sequence: 0, controller: alice.did },
        invocationSigner: alice.signer
      })
      keystoreId = config.id!
    })

    it('the stored did:key controller updates the config to the did:webvh', async () => {
      const kmsClient = new KmsClient({ keystoreId })
      const { config } = (await kmsClient.updateKeystore({
        config: {
          id: keystoreId,
          sequence: 1,
          controller: space.did,
          kmsModule: 'local-v1'
        },
        invocationSigner: alice.signer
      })) as any
      assert.equal(config.controller, space.did)
      assert.equal(config.sequence, 1)
    })

    it('the promoted keystore verifies invocations under the did:webvh keyId', async () => {
      const kmsClient = new KmsClient({ keystoreId })
      const config = (await kmsClient.getKeystore({
        invocationSigner: space.clientKeyPair.signer()
      })) as any
      assert.equal(config.controller, space.did)
    })

    it('the old did:key invocation is masked after keystore promotion', async () => {
      const kmsClient = new KmsClient({ keystoreId })
      const err = await requestError(
        kmsClient.getKeystore({ invocationSigner: alice.signer })
      )
      assert.equal(err.cause?.status ?? err.status, 404)
    })

    it('lists keystores by the did:webvh controller', async () => {
      const response = await client({
        signer: space.clientKeyPair.signer()
      }).request({
        url: `${keystoresUrl}?controller=${encodeURIComponent(space.did)}`,
        method: 'GET',
        action: 'read'
      })
      assert.equal(response.status, 200)
      const { results } = response.data as { results: Array<{ id: string }> }
      assert.ok(results.map(result => result.id).includes(keystoreId))
    })

    it('a cross-host did:webvh keystore controller is refused (400)', async () => {
      const kmsClient = new KmsClient({ keystoreId })
      const err = await requestError(
        kmsClient.updateKeystore({
          config: {
            id: keystoreId,
            sequence: 2,
            controller:
              'did:webvh:zQmUJkK5W2ymCPTrJDLQnaqRCApssCiuMTDFuVCvyoQvyU3' +
              ':other.example:space:abc:id',
            kmsModule: 'local-v1'
          },
          invocationSigner: space.clientKeyPair.signer()
        })
      )
      assert.equal(err.cause?.status ?? err.status, 400)
    })
  })
})
