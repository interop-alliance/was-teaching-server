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
import type { FastifyInstance } from 'fastify'

import {
  digestHeaderFor,
  openTempBackend,
  placeholderAuthHeader,
  rootInvocation,
  startTestServer,
  zcapClients
} from './helpers.js'

describe('Request Body Integrity (Digest header)', () => {
  let fastify: FastifyInstance, serverUrl: string, alice: any
  const spaceId = `digest-space-${crypto.randomUUID()}`
  const collectionId = 'credentials'

  beforeAll(async () => {
    ;({ fastify, serverUrl } = await startTestServer({
      backend: await openTempBackend()
    }))
    ;({ alice } = await zcapClients({ serverUrl }))

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
        authorization: placeholderAuthHeader({
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
        authorization: placeholderAuthHeader(),
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
        authorization: placeholderAuthHeader(),
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
        authorization: placeholderAuthHeader(),
        'capability-invocation': rootInvocation({ target }),
        'content-type': 'application/json',
        digest: 'mh=not-a-valid-multihash'
      },
      payload: JSON.stringify({ id: 'r4' })
    })
    assert.equal(response.statusCode, 400)
    assert.match(response.json().errors[0].detail, /malformed/)
  })

  it.each([
    { method: 'POST' as const, route: 'import', label: 'Import Space' },
    { method: 'PUT' as const, route: 'log', label: 'a governed-log PUT' }
  ])(
    'rejects $label with a body and no Content-Type, signed without `digest` (400)',
    async ({ method, route }) => {
      const url =
        route === 'import'
          ? `/space/${spaceId}/import`
          : `/space/${spaceId}/${collectionId}/meta/log`
      const response = await fastify.inject({
        method,
        url,
        headers: {
          authorization: placeholderAuthHeader({
            covered:
              '(key-id) (created) (expires) (request-target) host ' +
              'capability-invocation'
          }),
          'capability-invocation': rootInvocation({
            target: `${serverUrl}/space/${spaceId}/`
          })
        },
        payload: Buffer.from('{"state":{}}\n')
      })
      // Refused at the hook, before the handler reads the raw stream.
      assert.equal(response.statusCode, 400)
      assert.match(response.json().type, /missing-content-type/)
    }
  )

  it('a signed bodyless request with no Content-Type needs no Digest', async () => {
    // Content-Length 0 is bodyless: the request passes the digest gate and is
    // refused by the (placeholder) signature verification instead.
    const target = `${serverUrl}/space/${spaceId}/${collectionId}/r6`
    const response = await fastify.inject({
      method: 'DELETE',
      url: `/space/${spaceId}/${collectionId}/r6`,
      headers: {
        authorization: placeholderAuthHeader({
          covered:
            '(key-id) (created) (expires) (request-target) host ' +
            'capability-invocation'
        }),
        'capability-invocation': rootInvocation({ target }),
        'content-length': '0'
      }
    })
    assert.doesNotMatch(response.json().errors[0].detail, /Digest|digest/)
  })

  it('a streamed body with a mismatching Digest refused before it is read answers 404 and the server stays up', async () => {
    // A raw (non-buffered) body passes through the digest-verifying transform.
    // The placeholder signature fails verification, so the handler refuses
    // before it reads the body, and the transform's mismatch error at
    // end-of-stream has no consumer to receive it.
    const target = `${serverUrl}/space/${spaceId}/${collectionId}/blob`
    const response = await fastify.inject({
      method: 'PUT',
      url: `/space/${spaceId}/${collectionId}/blob`,
      headers: {
        authorization: placeholderAuthHeader(),
        'capability-invocation': rootInvocation({ target }),
        'content-type': 'application/octet-stream',
        digest: digestHeaderFor('not the body')
      },
      payload: Buffer.from('the actual body')
    })
    assert.equal(response.statusCode, 404)
    // Let the transform flush, then check the server still answers.
    await new Promise(resolve => setImmediate(resolve))
    const health = await fetch(`${serverUrl}/health`)
    assert.equal(health.status, 200)
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
        authorization: placeholderAuthHeader(),
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
