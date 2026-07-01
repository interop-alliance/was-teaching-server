/**
 * Unit tests for the id sanitizer (`assertValidId` / `assertValidIds`) and the
 * Content-Type guard in `resolveResourceInput`. These exercise the path-
 * traversal defense and request-validation logic directly, without an HTTP
 * round-trip (see validation-api.test.ts for the end-to-end behavior).
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'
import type { FastifyRequest } from 'fastify'

import {
  RESERVED_COLLECTION_IDS as storageCoreCollectionIds,
  RESERVED_RESOURCE_IDS as storageCoreResourceIds
} from '@interop/storage-core'
import {
  assertValidId,
  assertValidIds,
  RESERVED_COLLECTION_IDS,
  RESERVED_RESOURCE_IDS
} from '../src/lib/validateId.js'
import { resolveResourceInput } from '../src/requests/resourceInput.js'
import {
  InvalidSpaceIdError,
  InvalidCollectionIdError,
  InvalidResourceIdError,
  MissingContentTypeError,
  ReservedIdError
} from '../src/errors.js'

describe('assertValidId', () => {
  const validIds = [
    '426e7db8-26b5-4fdc-8068-9dcb948fd291', // uuid v4
    'credentials',
    'a-space-to-delete',
    'Note_1',
    'a.b', // interior dot is fine
    'a..b', // interior `..` is not a traversal segment
    'file~tilde',
    'CAPS123'
  ]
  for (const id of validIds) {
    it(`accepts URL-safe id "${id}"`, () => {
      assert.doesNotThrow(() => assertValidId(id, { kind: 'space' }))
    })
  }

  const invalidIds = [
    '', // empty
    '.', // current dir
    '..', // parent dir (traversal)
    '../x', // traversal prefix
    '../../pwned', // deep traversal
    'a/b', // path separator
    'a\\b', // windows separator
    'foo bar', // space
    'a*b', // glob metachar
    'a?b', // glob metachar
    'a[b]', // glob metachar
    '%2e%2e', // literal percent-encoding is not URL-safe charset
    'space\u0000id' // embedded NUL byte
  ]
  for (const id of invalidIds) {
    it(`rejects unsafe id ${JSON.stringify(id)} with a typed 400`, () => {
      let thrown: any
      try {
        assertValidId(id, { kind: 'space', requestName: 'Get Space' })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown instanceof InvalidSpaceIdError)
      assert.equal(thrown.statusCode, 400)
      assert.ok(thrown.title)
    })
  }

  // The spec's Reserved Path Segment Registry, per id position (plus the
  // server's own non-spec `import` endpoint at the collection position).
  const reservedCollectionIds = [
    'backends',
    'collections',
    'export',
    'import',
    'linkset',
    'policy',
    'query',
    'quotas'
  ]
  for (const id of reservedCollectionIds) {
    it(`rejects reserved collection id "${id}" with a typed 409`, () => {
      let thrown: any
      try {
        assertValidId(id, { kind: 'collection' })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown instanceof ReservedIdError)
      assert.equal(thrown.statusCode, 409)
      assert.equal(thrown.type, 'https://wallet.storage/spec#reserved-id')
    })
  }

  const reservedResourceIds = ['backend', 'linkset', 'policy', 'query', 'quota']
  for (const id of reservedResourceIds) {
    it(`rejects reserved resource id "${id}" with a typed 409`, () => {
      let thrown: any
      try {
        assertValidId(id, { kind: 'resource' })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown instanceof ReservedIdError)
      assert.equal(thrown.statusCode, 409)
    })
  }

  it('reserved segments only apply at their own position', () => {
    // Space ids have no reserved siblings.
    assert.doesNotThrow(() => assertValidId('export', { kind: 'space' }))
    assert.doesNotThrow(() => assertValidId('policy', { kind: 'space' }))
    // Space-level-only segments are fine as resource ids...
    assert.doesNotThrow(() => assertValidId('export', { kind: 'resource' }))
    assert.doesNotThrow(() => assertValidId('quotas', { kind: 'resource' }))
    // ...and collection-level-only segments are fine as collection ids.
    assert.doesNotThrow(() => assertValidId('backend', { kind: 'collection' }))
    assert.doesNotThrow(() => assertValidId('quota', { kind: 'collection' }))
  })

  it('throws the error class matching the id kind', () => {
    assert.throws(
      () => assertValidId('../x', { kind: 'space' }),
      (err: Error) => err instanceof InvalidSpaceIdError
    )
    assert.throws(
      () => assertValidId('../x', { kind: 'collection' }),
      (err: Error) => err instanceof InvalidCollectionIdError
    )
    assert.throws(
      () => assertValidId('../x', { kind: 'resource' }),
      (err: Error) => err instanceof InvalidResourceIdError
    )
  })
})

describe('reserved-id registry (client #13)', () => {
  it('the server per-kind sets stay byte-identical to @interop/storage-core', () => {
    // The server is the authority for the Reserved Path Segment Registry and
    // exports its per-kind sets so the client can mirror them. storage-core
    // carries the shared copy; lock the two together so they cannot drift.
    assert.deepStrictEqual(
      [...RESERVED_COLLECTION_IDS].sort(),
      [...storageCoreCollectionIds].sort()
    )
    assert.deepStrictEqual(
      [...RESERVED_RESOURCE_IDS].sort(),
      [...storageCoreResourceIds].sort()
    )
  })

  it('documents the one known divergence from the spec registry: `import`', () => {
    // `import` is this server's non-spec tar-import endpoint; a client mirroring
    // the *spec* registry omits it. It must be reserved as a collection id (so it
    // cannot shadow the endpoint) but is not a reserved resource id.
    assert.ok(RESERVED_COLLECTION_IDS.has('import'))
    assert.ok(!RESERVED_RESOURCE_IDS.has('import'))
  })
})

describe('assertValidIds', () => {
  it('validates only the ids that are present', () => {
    assert.doesNotThrow(() =>
      assertValidIds({ spaceId: 'space-1', collectionId: 'col-1' })
    )
  })
  it('rejects when any present id is unsafe', () => {
    assert.throws(
      () => assertValidIds({ spaceId: 'space-1', collectionId: '../escape' }),
      (err: Error) => err instanceof InvalidCollectionIdError
    )
    assert.throws(
      () =>
        assertValidIds({
          spaceId: 'space-1',
          collectionId: 'col-1',
          resourceId: 'a/b'
        }),
      (err: Error) => err instanceof InvalidResourceIdError
    )
  })
})

describe('resolveResourceInput Content-Type guard', () => {
  it('throws a typed 400 when Content-Type header is missing', async () => {
    const request = { headers: {} } as unknown as FastifyRequest
    let thrown: any
    try {
      await resolveResourceInput(request)
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown instanceof MissingContentTypeError)
    assert.equal(thrown.statusCode, 400)
    assert.ok(thrown.title)
  })
})
