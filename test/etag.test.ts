/**
 * Unit tests for the `ETag` strong validator helpers in `src/lib/etag.ts`:
 * minting and formatting a `generation`/`version` pair, parsing a read's
 * `If-None-Match` header into the validators the client holds (RFC 9110 weak
 * comparison), and deciding the 304 Not Modified answer.
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'
import {
  etagOf,
  formatEtag,
  newGeneration,
  isNotModified,
  parseIfNoneMatch
} from '../src/lib/etag.js'

describe('newGeneration', () => {
  it('mints an alphanumeric base58 marker', () => {
    assert.match(newGeneration(), /^[A-Za-z0-9]+$/)
  })

  it('mints a distinct marker on every call', () => {
    assert.notEqual(newGeneration(), newGeneration())
  })
})

describe('formatEtag', () => {
  it('joins generation and version with a dot, quoted', () => {
    assert.equal(
      formatEtag({ generation: '3mJr7AoUXx2', version: 3 }),
      '"3mJr7AoUXx2.3"'
    )
  })
})

describe('etagOf', () => {
  it('formats the validator when both parts are present', () => {
    assert.equal(etagOf({ generation: 'abc', version: 1 }), '"abc.1"')
  })

  it('is undefined when the generation is missing', () => {
    assert.equal(etagOf({ version: 1 }), undefined)
  })

  it('is undefined when the version is missing', () => {
    assert.equal(etagOf({ generation: 'abc' }), undefined)
  })

  it('is undefined when both parts are missing', () => {
    assert.equal(etagOf({}), undefined)
  })
})

describe('parseIfNoneMatch', () => {
  it('an absent header is an unconditional read', () => {
    assert.equal(parseIfNoneMatch(undefined), undefined)
  })

  it('a single strong validator is kept quoted', () => {
    assert.deepEqual(parseIfNoneMatch('"abc.3"'), new Set(['"abc.3"']))
  })

  it('a weak validator names the same quoted form (weak comparison)', () => {
    assert.deepEqual(parseIfNoneMatch('W/"abc.3"'), new Set(['"abc.3"']))
  })

  it('a list collects every quoted member, whitespace tolerated', () => {
    assert.deepEqual(
      parseIfNoneMatch(' "abc.1", W/"def.2" ,"ghi.7"'),
      new Set(['"abc.1"', '"def.2"', '"ghi.7"'])
    )
  })

  it('an array-valued header is its comma-joined form', () => {
    assert.deepEqual(
      parseIfNoneMatch(['"abc.1"', '"def.2"']),
      new Set(['"abc.1"', '"def.2"'])
    )
  })

  it('`*` holds any representation', () => {
    assert.equal(parseIfNoneMatch('*'), '*')
  })

  it('a non-quoted member is skipped, not rejected', () => {
    assert.deepEqual(parseIfNoneMatch('abc, "def.2"'), new Set(['"def.2"']))
  })

  it('any quoted string is kept, opaque values included', () => {
    // The parser does not validate the shape inside the quotes -- that is
    // `isNotModified`'s job, by exact-string comparison against the current
    // `ETag`.
    assert.deepEqual(
      parseIfNoneMatch('"not-a-real-etag"'),
      new Set(['"not-a-real-etag"'])
    )
  })

  it('a header with no recognizable validator is an unconditional read', () => {
    assert.equal(parseIfNoneMatch('abc'), undefined)
    assert.equal(parseIfNoneMatch(''), undefined)
  })
})

describe('isNotModified', () => {
  it('is not modified when the held validators cover the current ETag', () => {
    const held = parseIfNoneMatch('"abc.2", "abc.3"')
    assert.equal(isNotModified({ held, etag: '"abc.3"' }), true)
  })

  it('is modified when the held validators miss it', () => {
    const held = parseIfNoneMatch('"abc.2"')
    assert.equal(isNotModified({ held, etag: '"abc.3"' }), false)
  })

  it('`*` covers any current representation, one with no ETag included', () => {
    const held = parseIfNoneMatch('*')
    assert.equal(isNotModified({ held, etag: '"abc.1"' }), true)
    assert.equal(isNotModified({ held, etag: undefined }), true)
  })

  it('a listed validator never covers a representation with no ETag', () => {
    const held = parseIfNoneMatch('"abc.1"')
    assert.equal(isNotModified({ held, etag: undefined }), false)
  })

  it('an unconditional read is never a 304', () => {
    assert.equal(isNotModified({ held: undefined, etag: '"abc.3"' }), false)
  })
})
