/**
 * Masked-denial indistinguishability (Vitest): the 404 an absent target
 * answers and the 404 a failed authorization answers must be the same
 * response, byte for byte, or the status pair alone tells an unauthorized
 * caller which Spaces, Collections, Resources and keystores exist (spec
 * "Access Control": a server MUST NOT disclose existence to a caller that may
 * not read the target).
 *
 * Every case probes the same operation twice -- once at an absent target, once
 * at an existing target the caller may not see -- and compares the raw
 * response text and `Content-Type`, not a parsed shape. Requests go out over
 * `fetch` with headers from `signCapabilityInvocation`, so nothing a client
 * library normalizes can hide a difference.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { KmsClient } from '@interop/webkms-client'
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { startTestServer, zcapClients } from './helpers.js'

/** One probed response, reduced to what the comparison reads. */
interface Probe {
  status: number
  contentType: string | null
  text: string
}

describe('Masked denials are indistinguishable', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    keystoreId: string
  const spaceId = `masked-space-${crypto.randomUUID()}`
  const collectionId = 'credentials'
  const resourceId = 'doc-1'
  // A key no Space, Collection, Resource or keystore here has ever heard of:
  // its signature is well-formed and verifies as a signature, so every
  // refusal it collects is an authorization refusal rather than a parse error.
  let rogueSigner: any

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice } = await zcapClients({ serverUrl }))

    const rogueKeyPair = await Ed25519VerificationKey.generate()
    rogueSigner = rogueKeyPair.didKeySigner()

    await alice.was.request({
      path: '/spaces/',
      method: 'POST',
      json: { id: spaceId, name: 'Masked Denial Space', controller: alice.did }
    })
    await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, name: 'Credentials' }
    })
    await alice.was.request({
      path: `/space/${spaceId}/${collectionId}/`,
      method: 'POST',
      json: { id: resourceId, name: 'A document' }
    })
    const keystore = await KmsClient.createKeystore({
      url: `${serverUrl}/kms/keystores`,
      config: { sequence: 0, controller: alice.did },
      invocationSigner: alice.signer
    })
    keystoreId = (keystore as any).id.split('/').pop()!
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  /**
   * Issues a request with no authorization headers at all and reduces the
   * response to what the comparison reads.
   *
   * @param options {object}
   * @param options.url {string}   the absolute URL to request
   * @param [options.method] {string}   the HTTP method (default `GET`)
   * @returns {Promise<Probe>}
   */
  async function anonymous({
    url,
    method = 'GET'
  }: {
    url: string
    method?: string
  }): Promise<Probe> {
    const response = await fetch(url, { method })
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      text: await response.text()
    }
  }

  /**
   * Issues a request carrying well-formed but unverifiable authorization
   * headers: a real capability invocation signed by a key the target's
   * controller never delegated to.
   *
   * @param options {object}
   * @param options.url {string}   the absolute URL to request
   * @param [options.method] {string}   the HTTP method (default `GET`)
   * @param [options.action] {string}   the capability action (default: method)
   * @param [options.json] {object}   a JSON request body
   * @param [options.signer] {object}   the signing key (default: the rogue key)
   * @returns {Promise<Probe>}
   */
  async function unverifiable({
    url,
    method = 'GET',
    action,
    json,
    signer
  }: {
    url: string
    method?: string
    action?: string
    json?: object
    signer?: any
  }): Promise<Probe> {
    const headers = await signCapabilityInvocation({
      url,
      method,
      headers: { date: new Date().toUTCString() },
      ...(json ? { json } : {}),
      invocationSigner: signer ?? rogueSigner,
      capabilityAction: action ?? method
    })
    const response = await fetch(url, {
      method,
      headers: headers as Record<string, string>,
      ...(json ? { body: JSON.stringify(json) } : {})
    })
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      text: await response.text()
    }
  }

  /**
   * Asserts two probed responses are the same response: same status, same
   * `Content-Type`, same body bytes.
   *
   * @param options {object}
   * @param options.absent {Probe}   the probe at an absent target
   * @param options.denied {Probe}   the probe at an existing, unreadable target
   * @param options.what {string}   what was probed, for the failure message
   * @param [options.status] {number}   the status both MUST carry
   */
  function assertIndistinguishable({
    absent,
    denied,
    what,
    status
  }: {
    absent: Probe
    denied: Probe
    what: string
    status?: number
  }): void {
    if (status !== undefined) {
      assert.equal(absent.status, status, `${what}: absent target status`)
    }
    assert.equal(
      denied.status,
      absent.status,
      `${what}: status differs (absent ${absent.status}, denied ${denied.status})`
    )
    assert.equal(
      denied.contentType,
      absent.contentType,
      `${what}: Content-Type differs`
    )
    assert.equal(
      denied.text,
      absent.text,
      `${what}: body differs\nabsent: ${absent.text}\ndenied: ${denied.text}`
    )
  }

  describe('reads of an absent target versus an unreadable one', () => {
    const targets = () => [
      {
        what: 'Space',
        absent: `${serverUrl}/space/no-such-space-${crypto.randomUUID()}/`,
        existing: `${serverUrl}/space/${spaceId}/`
      },
      {
        what: 'Space Metadata',
        absent: `${serverUrl}/space/no-such-space-${crypto.randomUUID()}/meta`,
        existing: `${serverUrl}/space/${spaceId}/meta`
      },
      {
        what: 'Collection',
        absent: `${serverUrl}/space/${spaceId}/no-such-collection/`,
        existing: `${serverUrl}/space/${spaceId}/${collectionId}/`
      },
      {
        what: 'Resource',
        absent: `${serverUrl}/space/${spaceId}/${collectionId}/no-such-doc`,
        existing: `${serverUrl}/space/${spaceId}/${collectionId}/${resourceId}`
      },
      {
        what: 'Keystore',
        absent: `${serverUrl}/kms/keystores/nosuchkeystore`,
        existing: `${serverUrl}/kms/keystores/${keystoreId}`
      }
    ]

    it('anonymously, both answer the same response', async () => {
      for (const { what, absent, existing } of targets()) {
        assertIndistinguishable({
          absent: await anonymous({ url: absent }),
          denied: await anonymous({ url: existing }),
          what: `${what} (anonymous)`
        })
      }
    })

    it('with unverifiable auth headers, both answer the same 404', async () => {
      for (const { what, absent, existing } of targets()) {
        assertIndistinguishable({
          absent: await unverifiable({ url: absent }),
          denied: await unverifiable({ url: existing }),
          what: `${what} (unverifiable)`,
          status: 404
        })
      }
    })

    it('the masked 404 body names no entity', async () => {
      const probe = await unverifiable({
        url: `${serverUrl}/space/${spaceId}/${collectionId}/${resourceId}`
      })
      assert.equal(probe.status, 404)
      assert.equal(probe.contentType, 'application/problem+json; charset=utf-8')
      const problem = JSON.parse(probe.text)
      assert.equal(problem.type, 'https://w3id.org/pws#not-found')
      assert.deepStrictEqual(problem.errors, [
        { detail: 'URL not found or invalid authorization.' }
      ])
      // The title names the operation the URL selected -- which the caller
      // already knows, having chosen the URL -- and nothing about what was or
      // was not stored there.
      assert.equal(problem.title, 'Invalid Get Resource request')
    })
  })

  describe('write paths that used to answer before verifying', () => {
    it('a revocation with a malformed body answers the same 404 either way', async () => {
      const revocationId = 'urn:uuid:not-a-real-capability'
      const suffix = `zcaps/revocations/${encodeURIComponent(revocationId)}`
      assertIndistinguishable({
        absent: await unverifiable({
          url: `${serverUrl}/space/no-such-space-${crypto.randomUUID()}/${suffix}`,
          method: 'POST',
          json: { not: 'a capability' }
        }),
        denied: await unverifiable({
          url: `${serverUrl}/space/${spaceId}/${suffix}`,
          method: 'POST',
          json: { not: 'a capability' }
        }),
        what: 'Revoke Capability (malformed body)',
        status: 404
      })
    })

    it('Create Space at an existing id answers as it does at a fresh one', async () => {
      // The body's controller has not consented (the invocation is signed by
      // some other key), so both answer the consent failure. An `id-conflict`
      // at the existing id would be an existence oracle for any caller.
      const bobKeyPair = await Ed25519VerificationKey.generate()
      const bobDid = `did:key:${bobKeyPair.fingerprint()}`
      const url = `${serverUrl}/spaces/`
      const existing = await unverifiable({
        url,
        method: 'POST',
        json: { id: spaceId, controller: bobDid }
      })
      const fresh = await unverifiable({
        url,
        method: 'POST',
        json: { id: `fresh-${crypto.randomUUID()}`, controller: bobDid }
      })
      assert.notEqual(existing.status, 409)
      assertIndistinguishable({
        absent: fresh,
        denied: existing,
        what: 'Create Space (unconsented)',
        status: 400
      })
    })

    it('an authorized Create Space at an existing id is still a 409', async () => {
      const response = await alice.was
        .request({
          path: '/spaces/',
          method: 'POST',
          json: { id: spaceId, controller: alice.did }
        })
        .catch((err: any) => err.response)
      assert.equal(response.status, 409)
    })
  })

  describe('a signing key that does not resolve', () => {
    it('an unresolvable did:webvh keyId answers the masked 404', async () => {
      // Syntactically a self-hosted did:webvh, but no `did.jsonl` is published
      // at the Collection it names, so the controller document does not
      // resolve. The keyId is entirely the caller's to choose, so this must
      // not be told apart from any other failed authorization.
      const host = new URL(serverUrl).host.replace(':', '%3A')
      const keyPair = await Ed25519VerificationKey.generate()
      const did = `did:webvh:QmUnresolvableScid1111111111111:${host}:space:${spaceId}:${collectionId}`
      keyPair.id = `${did}#${keyPair.publicKeyMultibase}`
      keyPair.controller = did

      const url = `${serverUrl}/space/${spaceId}/${collectionId}/${resourceId}`
      assertIndistinguishable({
        absent: await unverifiable({
          url: `${serverUrl}/space/${spaceId}/${collectionId}/no-such-doc`
        }),
        denied: await unverifiable({ url, signer: keyPair.signer() }),
        what: 'unresolvable did:webvh keyId',
        status: 404
      })
    })
  })
})
