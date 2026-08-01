/**
 * Unit tests for the controller-DID validators (`isValidController`,
 * `parseSelfHostedWebvh`, `isSelfHostedWebvhController`,
 * `assertValidController` / `assertValidSpaceController`). These exercise the
 * two accepted controller shapes directly, without an HTTP round-trip (see
 * webvh-controller-api.test.ts for the end-to-end behavior).
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'

import {
  assertValidController,
  assertValidSpaceController,
  isSelfHostedWebvhController,
  isValidController,
  parseSelfHostedWebvh
} from '../src/lib/validateDid.js'
import { InvalidControllerError } from '../src/errors.js'

const serverUrl = 'http://localhost:3000'
const scid = 'QmTPzWvrGXnAxq2GfbfWs3ptFDgvXcnrsyFtfnMoLB1234'
const spaceId = '426e7db8-26b5-4fdc-8068-9dcb948fd291'
const selfHosted = `did:webvh:${scid}:localhost%3A3000:space:${spaceId}:id`

const didKey = 'did:key:z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD'

describe('isValidController', () => {
  it('accepts an Ed25519 did:key', () => {
    assert.equal(isValidController(didKey), true)
  })

  it('rejects a self-hosted did:webvh (did:key-only predicate)', () => {
    assert.equal(isValidController(selfHosted), false)
  })

  it('rejects non-strings and other methods', () => {
    for (const value of [undefined, null, 42, {}, 'did:web:example.com']) {
      assert.equal(isValidController(value), false)
    }
  })
})

describe('parseSelfHostedWebvh', () => {
  it('parses a well-formed self-hosted DID into its scid and spaceId', () => {
    assert.deepEqual(parseSelfHostedWebvh(selfHosted, { serverUrl }), {
      scid,
      spaceId
    })
  })

  it('decodes the percent-encoded port in the domain component', () => {
    // Same DID, but the server is on a different port: the `%3A`-encoded port
    // must participate in the host comparison, not be ignored.
    assert.equal(
      parseSelfHostedWebvh(selfHosted, {
        serverUrl: 'http://localhost:4000'
      }),
      undefined
    )
  })

  it('accepts a host with no port when the server has none', () => {
    const did = `did:webvh:${scid}:was.example:space:${spaceId}:id`
    assert.deepEqual(
      parseSelfHostedWebvh(did, { serverUrl: 'https://was.example' }),
      { scid, spaceId }
    )
  })

  it('compares the host case-insensitively', () => {
    const did = `did:webvh:${scid}:WAS.Example:space:${spaceId}:id`
    assert.deepEqual(
      parseSelfHostedWebvh(did, { serverUrl: 'https://was.example' }),
      { scid, spaceId }
    )
  })

  const rejected: Array<[string, unknown]> = [
    ['a cross-host did:webvh', `did:webvh:${scid}:evil.example:space:x:id`],
    ['a did:web', 'did:web:localhost%3A3000:space:x:id'],
    ['a did:key', didKey],
    [
      'a malformed scid (too short)',
      `did:webvh:abc:localhost%3A3000:space:x:id`
    ],
    [
      'a scid outside the base58btc alphabet',
      `did:webvh:0OIl0OIl0OIl0OIl0OIl:localhost%3A3000:space:${spaceId}:id`
    ],
    [
      'path-traversal characters in the spaceId',
      `did:webvh:${scid}:localhost%3A3000:space:..:id`
    ],
    [
      'a percent-encoded separator in the spaceId',
      `did:webvh:${scid}:localhost%3A3000:space:a%2Fb:id`
    ],
    [
      'a collection other than `id`',
      `did:webvh:${scid}:localhost%3A3000:space:${spaceId}:keys`
    ],
    [
      'a path root other than `space`',
      `did:webvh:${scid}:localhost%3A3000:spaces:${spaceId}:id`
    ],
    [
      'extra path segments',
      `did:webvh:${scid}:localhost%3A3000:space:${spaceId}:id:extra`
    ],
    ['too few path segments', `did:webvh:${scid}:localhost%3A3000:space:id`],
    ['a bare did:webvh with no path', `did:webvh:${scid}:localhost%3A3000`],
    ['a non-string', 42],
    ['undefined', undefined]
  ]

  for (const [label, value] of rejected) {
    it(`rejects ${label}`, () => {
      assert.equal(parseSelfHostedWebvh(value, { serverUrl }), undefined)
      assert.equal(isSelfHostedWebvhController(value, { serverUrl }), false)
    })
  }
})

describe('assertValidController (did:key-only call sites)', () => {
  it('passes a did:key', () => {
    assert.doesNotThrow(() => assertValidController(didKey))
  })

  it('throws InvalidControllerError for a self-hosted did:webvh', () => {
    assert.throws(
      () => assertValidController(selfHosted, { requestName: 'Create Space' }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidControllerError)
        assert.equal(err.statusCode, 400)
        assert.equal(err.problems?.[0]?.pointer, '#/controller')
        // The did:key-only call sites keep their original message.
        assert.equal(
          err.detail,
          'The "controller" property must be a valid did:key DID.'
        )
        return true
      }
    )
  })
})

describe('assertValidSpaceController (Update Space)', () => {
  it('passes a did:key', () => {
    assert.doesNotThrow(() => assertValidSpaceController(didKey, { serverUrl }))
  })

  it('passes a self-hosted did:webvh', () => {
    assert.doesNotThrow(() =>
      assertValidSpaceController(selfHosted, { serverUrl })
    )
  })

  it('throws for a cross-host did:webvh, naming both accepted shapes', () => {
    assert.throws(
      () =>
        assertValidSpaceController(
          `did:webvh:${scid}:evil.example:space:${spaceId}:id`,
          { serverUrl, requestName: 'Update Space' }
        ),
      (err: unknown) => {
        assert.ok(err instanceof InvalidControllerError)
        assert.equal(err.statusCode, 400)
        assert.equal(err.problems?.[0]?.pointer, '#/controller')
        assert.match(err.detail, /did:key/)
        assert.match(err.detail, /did:webvh/)
        return true
      }
    )
  })
})
