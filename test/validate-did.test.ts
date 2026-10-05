/**
 * Unit tests for the controller-DID validators (`isValidController`,
 * `parseSelfHostedWebvh`, `parsePeerHostedWebvh`, `parseCrossHostWebvh`,
 * `isWebvhControllerShape`, `assertValidController` /
 * `assertValidSpaceController`). These exercise the accepted controller shapes
 * directly, without an HTTP round-trip (see webvh-controller-api.test.ts for
 * the end-to-end behavior).
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'

import {
  assertValidController,
  assertValidSpaceController,
  isValidController,
  isWebvhControllerShape,
  parseCrossHostWebvh,
  parsePeerHostedWebvh,
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
  it('parses a well-formed self-hosted DID into its three parts', () => {
    assert.deepEqual(parseSelfHostedWebvh(selfHosted, { serverUrl }), {
      scid,
      spaceId,
      collectionId: 'id'
    })
  })

  it('parses an arbitrary URL-safe Collection as the log location', () => {
    for (const collectionId of [
      'clientAnnex-3',
      'c.0_x~y',
      'id',
      'Keys',
      '9'
    ]) {
      const did = `did:webvh:${scid}:localhost%3A3000:space:${spaceId}:${collectionId}`
      assert.deepEqual(parseSelfHostedWebvh(did, { serverUrl }), {
        scid,
        spaceId,
        collectionId
      })
    }
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
      { scid, spaceId, collectionId: 'id' }
    )
  })

  it('compares the host case-insensitively', () => {
    const did = `did:webvh:${scid}:WAS.Example:space:${spaceId}:id`
    assert.deepEqual(
      parseSelfHostedWebvh(did, { serverUrl: 'https://was.example' }),
      { scid, spaceId, collectionId: 'id' }
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
      'a percent-encoded separator in the collectionId',
      `did:webvh:${scid}:localhost%3A3000:space:${spaceId}:a%2Fb`
    ],
    [
      'any percent-escape in the collectionId (it would not round-trip)',
      `did:webvh:${scid}:localhost%3A3000:space:${spaceId}:a%41b`
    ],
    [
      'a bare percent sign in the collectionId',
      `did:webvh:${scid}:localhost%3A3000:space:${spaceId}:a%b`
    ],
    [
      'path-traversal characters in the collectionId',
      `did:webvh:${scid}:localhost%3A3000:space:${spaceId}:..`
    ],
    [
      'a single-dot collectionId',
      `did:webvh:${scid}:localhost%3A3000:space:${spaceId}:.`
    ],
    [
      'an empty collectionId',
      `did:webvh:${scid}:localhost%3A3000:space:${spaceId}:`
    ],
    ['an empty spaceId', `did:webvh:${scid}:localhost%3A3000:space::id`],
    [
      'reserved characters in the collectionId',
      `did:webvh:${scid}:localhost%3A3000:space:${spaceId}:a+b`
    ],
    [
      'a path separator in the collectionId',
      `did:webvh:${scid}:localhost%3A3000:space:${spaceId}:a/b`
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
    })
  }
})

describe('parsePeerHostedWebvh', () => {
  it('accepts a space:<S>:<C> DID on another host, naming its peer Space', () => {
    assert.deepStrictEqual(
      parsePeerHostedWebvh(
        `did:webvh:${scid}:peer.example:space:${spaceId}:id`,
        { serverUrl }
      ),
      {
        scid,
        host: 'peer.example',
        spaceId,
        collectionId: 'id',
        fromSpace: `https://peer.example/space/${spaceId}/`
      }
    )
  })

  it('refuses this host, a port, another path, and malformed ids', () => {
    for (const did of [
      selfHosted,
      `did:webvh:${scid}:localhost:space:${spaceId}:id`,
      `did:webvh:${scid}:peer.example%3A8443:space:${spaceId}:id`,
      `did:webvh:${scid}:Peer.Example:space:${spaceId}:id`,
      `did:webvh:${scid}:peer.example:spaces:${spaceId}:id`,
      `did:webvh:${scid}:peer.example:space:${spaceId}`,
      `did:webvh:${scid}:peer.example:space:${spaceId}:id:extra`,
      `did:webvh:${scid}:peer.example:space:..:id`,
      `did:webvh:${scid}:peer.example:space:${spaceId}:a%2Fb`,
      `did:webvh:short:peer.example:space:${spaceId}:id`
    ]) {
      assert.equal(parsePeerHostedWebvh(did, { serverUrl }), undefined, did)
    }
  })
})

describe('parseCrossHostWebvh', () => {
  it('maps any path, and the host-only form, to its log URL', () => {
    assert.deepStrictEqual(
      parseCrossHostWebvh(`did:webvh:${scid}:agent.example:agents:a1`, {
        serverUrl
      }),
      {
        scid,
        host: 'agent.example',
        path: ['agents', 'a1'],
        logUrl: 'https://agent.example/agents/a1/did.jsonl'
      }
    )
    assert.deepStrictEqual(
      parseCrossHostWebvh(`did:webvh:${scid}:agent.example`, { serverUrl }),
      {
        scid,
        host: 'agent.example',
        path: [],
        logUrl: 'https://agent.example/.well-known/did.jsonl'
      }
    )
  })

  it('refuses this host, a port, an IP, and segments that are not URL-safe', () => {
    for (const did of [
      `did:webvh:${scid}:localhost%3A3000:space:${spaceId}:id`,
      `did:webvh:${scid}:localhost`,
      `did:webvh:${scid}:agent.example%3A8443:agents:a1`,
      `did:webvh:${scid}:10.0.0.1:agents:a1`,
      `did:webvh:${scid}:Agent.Example:agents:a1`,
      `did:webvh:${scid}:agent.example:agents:..`,
      `did:webvh:${scid}:agent.example:agents:.`,
      `did:webvh:${scid}:agent.example:agents:`,
      `did:webvh:${scid}:agent.example:a%2Fb`,
      `did:webvh:${scid}:agent.example:a%3Fb`,
      `did:webvh:${scid}:agent.example:a b`,
      `did:webvh:short:agent.example:agents:a1`,
      `did:web:agent.example:agents:a1`,
      42
    ]) {
      assert.equal(
        parseCrossHostWebvh(did, { serverUrl }),
        undefined,
        String(did)
      )
    }
  })
})

describe('isWebvhControllerShape', () => {
  it('accepts a self-hosted and a peer-hosted space:<S>:<C> DID', () => {
    assert.equal(isWebvhControllerShape(selfHosted, { serverUrl }), true)
    assert.equal(
      isWebvhControllerShape(
        `did:webvh:${scid}:peer.example:space:${spaceId}:id`,
        { serverUrl }
      ),
      true
    )
  })

  it('refuses a cross-host DID of any other path, and the host-only form', () => {
    for (const did of [
      `did:webvh:${scid}:agent.example:agents:a1`,
      `did:webvh:${scid}:agent.example`,
      didKey
    ]) {
      assert.equal(isWebvhControllerShape(did, { serverUrl }), false, did)
    }
  })
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

  it('passes a peer-hosted did:webvh, whose resolvability is checked later', () => {
    assert.doesNotThrow(() =>
      assertValidSpaceController(
        `did:webvh:${scid}:peer.example:space:${spaceId}:id`,
        { serverUrl }
      )
    )
  })

  it('throws for a cross-host did:webvh off the space path, naming both accepted shapes', () => {
    assert.throws(
      () =>
        assertValidSpaceController(
          `did:webvh:${scid}:evil.example:agents:${spaceId}`,
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
