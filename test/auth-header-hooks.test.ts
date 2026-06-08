/**
 * Unit tests for the auth onRequest hooks (`src/auth-header-hooks.ts`):
 * `requireAuthHeaders`, `requireAuthHeadersOrPublicRead`, and `parseAuthHeaders`.
 * These exercise the header-presence gating and the `request.zcap` parsing
 * directly against lightweight mock requests, without an HTTP round-trip (the
 * `*-api` suites cover the end-to-end behavior). No signature verification
 * happens here -- `parseAuthHeaders` only parses, so static header strings
 * suffice.
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'
import type { FastifyReply, FastifyRequest } from 'fastify'

import {
  requireAuthHeaders,
  requireAuthHeadersOrPublicRead,
  parseAuthHeaders
} from '../src/auth-header-hooks.js'
import {
  MissingAuthError,
  MissingKeyIdError,
  AuthHeaderParseError
} from '../src/errors.js'

/** A well-formed (but unsigned) Cavage Authorization header value. */
const VALID_AUTHORIZATION =
  'Signature keyId="did:key:zAlice#zAlice",' +
  'created="1",expires="2",headers="(created)",signature="sig=="'

/** Builds a mock FastifyRequest carrying the given headers and method. */
function mockRequest(
  headers: Record<string, string>,
  method = 'GET'
): FastifyRequest {
  return { headers, method } as unknown as FastifyRequest
}

const reply = {} as FastifyReply

describe('requireAuthHeaders', () => {
  it('resolves when both Authorization and Capability-Invocation are present', async () => {
    const request = mockRequest({
      authorization: VALID_AUTHORIZATION,
      'capability-invocation': 'zcap id="urn:zcap:root:x"'
    })
    await assert.doesNotReject(() => requireAuthHeaders(request, reply))
  })

  for (const headers of [
    { authorization: VALID_AUTHORIZATION }, // no capability-invocation
    { 'capability-invocation': 'zcap id="urn:zcap:root:x"' }, // no authorization
    {} // neither
  ]) {
    it(`throws MissingAuthError (401) for headers ${JSON.stringify(headers)}`, async () => {
      let thrown: any
      try {
        await requireAuthHeaders(mockRequest(headers), reply)
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown instanceof MissingAuthError)
      assert.equal(thrown.statusCode, 401)
    })
  }
})

describe('requireAuthHeadersOrPublicRead', () => {
  it('resolves when both auth headers are present (any method)', async () => {
    const request = mockRequest(
      {
        authorization: VALID_AUTHORIZATION,
        'capability-invocation': 'zcap id="urn:zcap:root:x"'
      },
      'DELETE'
    )
    await assert.doesNotReject(() =>
      requireAuthHeadersOrPublicRead(request, reply)
    )
  })

  for (const method of ['GET', 'HEAD']) {
    it(`lets unauthenticated ${method} (a safe method) through`, async () => {
      await assert.doesNotReject(() =>
        requireAuthHeadersOrPublicRead(mockRequest({}, method), reply)
      )
    })
  }

  for (const method of ['POST', 'PUT', 'DELETE']) {
    it(`throws MissingAuthError for unauthenticated ${method} (unsafe)`, async () => {
      let thrown: any
      try {
        await requireAuthHeadersOrPublicRead(mockRequest({}, method), reply)
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown instanceof MissingAuthError)
      assert.equal(thrown.statusCode, 401)
    })
  }
})

describe('parseAuthHeaders', () => {
  it('leaves request.zcap unset when no Authorization header is present', async () => {
    const request = mockRequest({})
    await parseAuthHeaders(request, reply)
    assert.equal(request.zcap, undefined)
  })

  it('parses the auth headers into request.zcap', async () => {
    const request = mockRequest({
      authorization: VALID_AUTHORIZATION,
      'capability-invocation': 'zcap id="urn:zcap:root:x",action="GET"',
      digest: 'mh=uEiABC'
    })
    await parseAuthHeaders(request, reply)
    assert.ok(request.zcap)
    assert.equal(request.zcap!.keyId, 'did:key:zAlice#zAlice')
    assert.equal(
      request.zcap!.invocation,
      'zcap id="urn:zcap:root:x",action="GET"'
    )
    assert.equal(request.zcap!.digest, 'mh=uEiABC')
  })

  it('throws MissingKeyIdError when the Authorization header has no keyId', async () => {
    const request = mockRequest({
      authorization: 'Signature created="1",signature="sig=="'
    })
    let thrown: any
    try {
      await parseAuthHeaders(request, reply)
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown instanceof MissingKeyIdError)
    assert.equal(thrown.statusCode, 400)
  })

  it('throws AuthHeaderParseError (with cause) on a malformed Authorization header', async () => {
    const request = mockRequest({ authorization: 'Signature ="x"' })
    let thrown: any
    try {
      await parseAuthHeaders(request, reply)
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown instanceof AuthHeaderParseError)
    assert.equal(thrown.statusCode, 400)
    assert.ok(thrown.cause instanceof Error)
  })
})
