/**
 * Root-invocation relation-scoping tests (Vitest): on a Space promoted to a
 * self-hosted `did:webvh` controller, a *root* invocation verifies only when
 * the signing verification method is listed under the resolved document's
 * `capabilityInvocation` relation.
 *
 * The check is not written out anywhere in this server. `webvhVerifier`
 * (`src/zcap.ts:253`) looks the invocation keyId up by membership in the flat
 * `verificationMethod` array and compares no relation of its own; what carries
 * the rule is the `controller: did` it restates on the verification method it
 * reconstructs (`src/zcap.ts:276`). That string sends jsigs'
 * `ControllerProofPurpose` to fetch the controller document through the local
 * webvh resolver driver (`webvhDidResolverDriver` /`dereferenceFragment`,
 * `src/lib/webvhController.ts:325` and `:357`) and read `capabilityInvocation`
 * out of it. Root invocation and delegation proof are therefore
 * relation-scoped by the same code, and a refactor that dropped the restated
 * controller -- or a jsigs / zcap upgrade that stopped consulting the
 * document -- would widen root invocation silently. This suite is the alarm.
 *
 * Two levels are pinned. At the route, the refusal is a 404: the maximum-
 * privacy masking every unauthorized invocation gets, which hides the reason.
 * So the verifier's own message is pinned separately, by calling `verifyZcap`
 * in-process over headers signed by `signCapabilityInvocation`. That is the
 * only place the message is observable: the relation failure comes back as
 * `{ verified: false, error }` rather than as a throw, so `handleZcapVerify`
 * raises `UnauthorizedError` without logging it, and nothing reaches the
 * request log to assert on.
 *
 * The bootstrap case, deliberately outside this matrix: before promotion a
 * Space's controller is a bare `did:key`, and its invocations take the
 * `did:key` branch of the verifier key hook (`createGetVerifier`,
 * `src/zcap.ts:300`) rather than `webvhVerifier`'s listed-method lookup. There
 * is no relation for a wallet to choose there -- a `did:key` document is
 * generated from the DID string with its single key under all four
 * relationships -- so nothing this suite measures applies to it.
 *
 * Invocations are raw `@interop/ezcap` requests: this is a wire-level
 * authorization shape, not the high-level `@interop/was-client` surface.
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
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import type { IDID } from '../src/types.js'
import { verifyZcap } from '../src/zcap.js'
import {
  client,
  requestError,
  rootZcap,
  startTestServer,
  zcapClients
} from './helpers.js'

/**
 * A promoted Space plus the four keys its controller document lists, one per
 * relation set under test.
 */
interface PromotedSpace {
  spaceId: string
  spaceUrl: string
  did: IDID
  /** listed under all four verification relationships */
  allRelations: any
  /** listed under `capabilityInvocation` alone */
  invocationOnly: any
  /** listed under `assertionMethod` + `capabilityDelegation`: a ladder VM */
  ladder: any
  /** listed under `authentication` alone */
  authenticationOnly: any
}

describe('root-invocation relation scoping (did:webvh controller)', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    backend: FileSystemBackend,
    alice: any

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    backend = new FileSystemBackend({ dataDir })
    ;({ fastify, serverUrl } = await startTestServer({ backend }))
    ;({ alice } = await zcapClients({ serverUrl }))
  })

  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  /**
   * Provisions a fresh Space under Alice's `did:key`, mints a `did:webvh`
   * anchored in its `id` Collection listing one verification method per
   * relation set, publishes the history log, and promotes the Space to that
   * DID. One Space per case, because half the matrix invokes `DELETE`.
   *
   * @returns {Promise<PromotedSpace>}
   */
  async function promotedSpace(): Promise<PromotedSpace> {
    const spaceId = randomUUID()
    const space = alice.was.space(spaceId)
    await space.configure({ name: 'Promoted Space', controller: alice.did })
    await space.collection('id').configure({ force: true })

    const updateKeyPair = await Ed25519VerificationKey.generate()
    updateKeyPair.id =
      `did:key:${updateKeyPair.publicKeyMultibase}` +
      `#${updateKeyPair.publicKeyMultibase}`
    const logSigner = signerFromExternalKey({
      publicKeyMultibase: updateKeyPair.publicKeyMultibase!,
      sign: async ({ data }: { data: Uint8Array }) =>
        await updateKeyPair.signer().sign({ data })
    })

    const allRelations = await Ed25519VerificationKey.generate()
    const invocationOnly = await Ed25519VerificationKey.generate()
    const ladder = await Ed25519VerificationKey.generate()
    const authenticationOnly = await Ed25519VerificationKey.generate()

    // Relationship wiring is driven entirely through `purpose`: passing
    // explicit relationship arrays alongside would override it wholesale.
    const created = await createDID({
      address: `${serverUrl}/space/${spaceId}/id`,
      signer: logSigner,
      updateKeys: [updateKeyPair.publicKeyMultibase!],
      vmIdFragment: 'multibase',
      verificationMethods: [
        {
          type: 'Multikey',
          publicKeyMultibase: allRelations.publicKeyMultibase!,
          purpose: [
            'authentication',
            'assertionMethod',
            'capabilityInvocation',
            'capabilityDelegation'
          ]
        },
        {
          type: 'Multikey',
          publicKeyMultibase: invocationOnly.publicKeyMultibase!,
          purpose: ['capabilityInvocation']
        },
        {
          type: 'Multikey',
          publicKeyMultibase: ladder.publicKeyMultibase!,
          purpose: ['assertionMethod', 'capabilityDelegation']
        },
        {
          type: 'Multikey',
          publicKeyMultibase: authenticationOnly.publicKeyMultibase!,
          purpose: ['authentication']
        }
      ] as any
    })

    for (const keyPair of [
      allRelations,
      invocationOnly,
      ladder,
      authenticationOnly
    ]) {
      keyPair.id = `${created.did}#${keyPair.publicKeyMultibase}`
      keyPair.controller = created.did
    }

    const published = await alice.was.request({
      path: `/space/${spaceId}/id/did.jsonl`,
      method: 'PUT',
      headers: { 'content-type': 'text/jsonl' },
      body: new Blob([logToJsonlString(created.log)], { type: 'text/jsonl' })
    })
    assert.equal(published.status, 204)

    // Promotion by ordering: created under Alice's `did:key`, handed to the
    // `did:webvh` by a PUT the stored `did:key` still authorizes.
    const promoted = await alice.was.request({
      path: `/space/${spaceId}`,
      method: 'PUT',
      json: {
        id: spaceId,
        name: 'Promoted Space',
        controller: created.did
      }
    })
    assert.equal(promoted.status, 204)

    return {
      spaceId,
      spaceUrl: new URL(`/space/${spaceId}`, serverUrl).toString(),
      did: created.did as IDID,
      allRelations,
      invocationOnly,
      ladder,
      authenticationOnly
    }
  }

  /**
   * Root-invokes one HTTP verb on a Space URL, signed by one of the DID
   * document's keys.
   *
   * @param options {object}
   * @param options.space {PromotedSpace}
   * @param options.signerKeyPair {any}   the key signing the invocation
   * @param options.method {string}   the HTTP verb, also the zcap action
   * @returns {Promise<any>}
   */
  async function rootInvoke({
    space,
    signerKeyPair,
    method
  }: {
    space: PromotedSpace
    signerKeyPair: any
    method: string
  }): Promise<any> {
    return client({ signer: signerKeyPair.signer() }).request({
      url: space.spaceUrl,
      method,
      action: method,
      capability: rootZcap({ target: space.spaceUrl, controller: space.did })
    })
  }

  /**
   * Asserts the Space Description still reads back, using the key listed under
   * all four relations. The survival check after a refused `DELETE`.
   *
   * @param options {object}
   * @param options.space {PromotedSpace}
   * @returns {Promise<void>}
   */
  async function assertSpaceSurvives({
    space
  }: {
    space: PromotedSpace
  }): Promise<void> {
    const response = await rootInvoke({
      space,
      signerKeyPair: space.allRelations,
      method: 'GET'
    })
    assert.equal(response.status, 200)
    assert.equal(response.data.id, space.spaceId)
  }

  describe('a method under all four relations', () => {
    it('reads the Space Description (200)', async () => {
      const space = await promotedSpace()
      const response = await rootInvoke({
        space,
        signerKeyPair: space.allRelations,
        method: 'GET'
      })
      assert.equal(response.status, 200)
      assert.equal(response.data.controller, space.did)
    })

    it('deletes the Space (204)', async () => {
      const space = await promotedSpace()
      const response = await rootInvoke({
        space,
        signerKeyPair: space.allRelations,
        method: 'DELETE'
      })
      assert.equal(response.status, 204)
    })
  })

  describe('a capabilityInvocation-only method', () => {
    it('reads the Space Description (200)', async () => {
      const space = await promotedSpace()
      const response = await rootInvoke({
        space,
        signerKeyPair: space.invocationOnly,
        method: 'GET'
      })
      assert.equal(response.status, 200)
      assert.equal(response.data.controller, space.did)
    })

    it('deletes the Space (204)', async () => {
      const space = await promotedSpace()
      const response = await rootInvoke({
        space,
        signerKeyPair: space.invocationOnly,
        method: 'DELETE'
      })
      assert.equal(response.status, 204)
    })
  })

  describe('a ladder VM (assertionMethod + capabilityDelegation only)', () => {
    it('cannot read the Space Description (404)', async () => {
      const space = await promotedSpace()
      const err = await requestError(
        rootInvoke({ space, signerKeyPair: space.ladder, method: 'GET' })
      )
      assert.equal(err.status, 404)
    })

    it('cannot delete the Space (404), and the Space survives', async () => {
      const space = await promotedSpace()
      const err = await requestError(
        rootInvoke({ space, signerKeyPair: space.ladder, method: 'DELETE' })
      )
      assert.equal(err.status, 404)
      await assertSpaceSurvives({ space })
    })
  })

  describe('an authentication-only method', () => {
    it('cannot read the Space Description (404)', async () => {
      const space = await promotedSpace()
      const err = await requestError(
        rootInvoke({
          space,
          signerKeyPair: space.authenticationOnly,
          method: 'GET'
        })
      )
      assert.equal(err.status, 404)
    })

    it('cannot delete the Space (404), and the Space survives', async () => {
      const space = await promotedSpace()
      const err = await requestError(
        rootInvoke({
          space,
          signerKeyPair: space.authenticationOnly,
          method: 'DELETE'
        })
      )
      assert.equal(err.status, 404)
      await assertSpaceSurvives({ space })
    })
  })

  describe('the verifier message behind the 404', () => {
    /**
     * Runs one root invocation through `verifyZcap` directly, over headers
     * signed exactly as the ezcap client signs them. The route masks the
     * outcome as a 404, so this is where the refusal is legible.
     *
     * @param options {object}
     * @param options.space {PromotedSpace}
     * @param options.signerKeyPair {any}
     * @param options.method {string}
     * @returns {Promise<import('@interop/http-signature-zcap-verify').VerifyCapabilityInvocationResult>}
     */
    async function verifyRootInvocation({
      space,
      signerKeyPair,
      method
    }: {
      space: PromotedSpace
      signerKeyPair: any
      method: string
    }) {
      const headers = await signCapabilityInvocation({
        url: space.spaceUrl,
        method,
        headers: { host: new URL(serverUrl).host },
        capability: rootZcap({
          target: space.spaceUrl,
          controller: space.did
        }),
        capabilityAction: method,
        invocationSigner: signerKeyPair.signer()
      })
      return verifyZcap({
        url: `/space/${space.spaceId}`,
        allowedTarget: space.spaceUrl,
        allowedAction: method,
        method,
        headers,
        serverUrl,
        spaceController: space.did,
        webvh: { storage: backend, serverUrl }
      })
    }

    it('names the capabilityInvocation purpose for a ladder VM', async () => {
      const space = await promotedSpace()
      const result = await verifyRootInvocation({
        space,
        signerKeyPair: space.ladder,
        method: 'GET'
      })
      assert.equal(result.verified, false)
      assert.equal(
        result.error?.message,
        `Verification method "${space.ladder.id}" not authorized by ` +
          'controller for proof purpose "capabilityInvocation".'
      )
    })

    it('names the same purpose for an authentication-only method', async () => {
      const space = await promotedSpace()
      const result = await verifyRootInvocation({
        space,
        signerKeyPair: space.authenticationOnly,
        method: 'DELETE'
      })
      assert.equal(result.verified, false)
      assert.equal(
        result.error?.message,
        `Verification method "${space.authenticationOnly.id}" not authorized ` +
          'by controller for proof purpose "capabilityInvocation".'
      )
    })

    it('a capabilityInvocation member verifies with no error', async () => {
      const space = await promotedSpace()
      const result = await verifyRootInvocation({
        space,
        signerKeyPair: space.invocationOnly,
        method: 'GET'
      })
      assert.equal(result.verified, true)
      assert.equal(result.error, undefined)
    })
  })
})
