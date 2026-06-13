/**
 * Request Body Integrity (Digest header) enforcement (Vitest). Verifies the
 * `verifyBodyDigest` preValidation hook: a bodied write must cover the `digest`
 * header in its signature, present a `Digest` header, and that header must match
 * the received body (spec "Request Body Integrity").
 *
 * The digest hook runs before the handler verifies the capability signature, so
 * the negative cases are driven with `fastify.inject` and hand-built auth
 * headers (no valid signature needed -- the request is rejected at the digest
 * gate first). The happy path is covered by the real signing client, which
 * includes a correct `Digest` on every write.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import { zcapClients } from './helpers.js'

/** Alice's did:key (matches the seed in `helpers.ts`). */
const ALICE_KEY_ID =
  'did:key:z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD' +
  '#z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD'

const FULL_COVERED =
  '(key-id) (created) (expires) (request-target) host ' +
  'capability-invocation content-type digest'

/**
 * Builds a syntactically valid Cavage `Authorization: Signature ...` header.
 * The signature value is a placeholder -- these tests reject at the digest gate,
 * which runs before signature verification.
 * @param options {object}
 * @param [options.covered] {string}   the signed-headers list
 * @returns {string}
 */
function authHeader({ covered = FULL_COVERED }: { covered?: string } = {}) {
  return (
    `Signature keyId="${ALICE_KEY_ID}",headers="${covered}",` +
    'signature="cGxhY2Vob2xkZXI=",created="1758150502",expires="9999999999"'
  )
}

/** The root `Capability-Invocation` header for a target URL. */
function rootInvocation({ target }: { target: string }) {
  return `zcap id="urn:zcap:root:${encodeURIComponent(target)}",action="PUT"`
}

/**
 * Computes the spec's `Digest` header value (multibase base64url multihash of
 * the body's SHA-256) for a string body.
 * @param body {string}
 * @returns {string}
 */
function digestHeaderFor(body: string): string {
  const hash = createHash('sha256').update(body, 'utf8').digest()
  // multihash: sha2-256 (0x12), length 32 (0x20), then the digest bytes
  const multihash = Buffer.concat([Buffer.from([0x12, 0x20]), hash])
  return `mh=u${multihash.toString('base64url')}`
}

describe('Request Body Integrity (Digest header)', () => {
  let fastify: FastifyInstance, serverUrl: string, dataDir: string, alice: any
  const PORT = 7781
  const spaceId = `digest-space-${crypto.randomUUID()}`
  const collectionId = 'credentials'

  beforeAll(async () => {
    serverUrl = `http://localhost:${PORT}`
    ;({ alice } = await zcapClients({ serverUrl }))
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    fastify = createApp({
      serverUrl,
      backend: new FileSystemBackend({ dataDir })
    })
    await fastify.listen({ port: PORT })

    const space = await alice.was.createSpace({
      id: spaceId,
      name: 'Digest Space',
      controller: alice.did
    })
    await space.createCollection({
      id: collectionId,
      name: 'Verifiable Credentials'
    })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('a correctly signed write (valid Digest) succeeds', async () => {
    // The real client always covers and sends a matching Digest header.
    const response = await alice.was.request({
      path: `/space/${spaceId}/${collectionId}/happy`,
      method: 'PUT',
      json: { id: 'happy', name: 'Happy Path' }
    })
    assert.equal(response.status, 204)
  })

  it('rejects a body write whose signature does not cover `digest` (400)', async () => {
    const target = `${serverUrl}/space/${spaceId}/${collectionId}/r1`
    const response = await fastify.inject({
      method: 'PUT',
      url: `/space/${spaceId}/${collectionId}/r1`,
      headers: {
        authorization: authHeader({
          covered:
            '(key-id) (created) (expires) (request-target) host ' +
            'capability-invocation content-type'
        }),
        'capability-invocation': rootInvocation({ target }),
        'content-type': 'application/json',
        digest: digestHeaderFor(JSON.stringify({ id: 'r1' }))
      },
      payload: JSON.stringify({ id: 'r1' })
    })
    assert.equal(response.statusCode, 400)
    const body = response.json()
    assert.match(body.type, /invalid-authorization-header/)
    assert.match(body.errors[0].detail, /cover the `digest` header/)
  })

  it('rejects a body write with no Digest header (400)', async () => {
    const target = `${serverUrl}/space/${spaceId}/${collectionId}/r2`
    const response = await fastify.inject({
      method: 'PUT',
      url: `/space/${spaceId}/${collectionId}/r2`,
      headers: {
        authorization: authHeader(),
        'capability-invocation': rootInvocation({ target }),
        'content-type': 'application/json'
      },
      payload: JSON.stringify({ id: 'r2' })
    })
    assert.equal(response.statusCode, 400)
    assert.match(response.json().errors[0].detail, /header is required/)
  })

  it('rejects a body write whose Digest does not match the body (400)', async () => {
    const target = `${serverUrl}/space/${spaceId}/${collectionId}/r3`
    const response = await fastify.inject({
      method: 'PUT',
      url: `/space/${spaceId}/${collectionId}/r3`,
      headers: {
        authorization: authHeader(),
        'capability-invocation': rootInvocation({ target }),
        'content-type': 'application/json',
        // Digest of a different body than the one actually sent.
        digest: digestHeaderFor(JSON.stringify({ id: 'tampered' }))
      },
      payload: JSON.stringify({ id: 'r3' })
    })
    assert.equal(response.statusCode, 400)
    assert.match(response.json().errors[0].detail, /does not match/)
  })

  it('rejects a body write with a malformed Digest header (400)', async () => {
    const target = `${serverUrl}/space/${spaceId}/${collectionId}/r4`
    const response = await fastify.inject({
      method: 'PUT',
      url: `/space/${spaceId}/${collectionId}/r4`,
      headers: {
        authorization: authHeader(),
        'capability-invocation': rootInvocation({ target }),
        'content-type': 'application/json',
        digest: 'mh=not-a-valid-multihash'
      },
      payload: JSON.stringify({ id: 'r4' })
    })
    assert.equal(response.statusCode, 400)
    assert.match(response.json().errors[0].detail, /malformed/)
  })

  it('a correct Digest passes the gate (reaches signature verification)', async () => {
    // Correct covered headers + a matching Digest: the digest hook accepts it,
    // so the request proceeds and is instead rejected by the (placeholder)
    // signature verification -- a different failure than the digest details.
    const target = `${serverUrl}/space/${spaceId}/${collectionId}/r5`
    const payload = JSON.stringify({ id: 'r5' })
    const response = await fastify.inject({
      method: 'PUT',
      url: `/space/${spaceId}/${collectionId}/r5`,
      headers: {
        authorization: authHeader(),
        'capability-invocation': rootInvocation({ target }),
        'content-type': 'application/json',
        digest: digestHeaderFor(payload)
      },
      payload
    })
    // Not a digest rejection: the detail is about verification, not the Digest.
    assert.doesNotMatch(response.json().errors[0].detail, /Digest|digest/)
  })
})
