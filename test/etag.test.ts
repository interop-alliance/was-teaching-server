/**
 * Unit tests for the `ETag` strong validator helpers in `src/lib/etag.ts`:
 * minting and formatting a `generation` plus write-stamp validator, parsing a read's
 * `If-None-Match` header into the validators the client holds (RFC 9110 weak
 * comparison), and deciding the 304 Not Modified answer.
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'
import {
  embedMetadataValidator,
  etagOf,
  formatEtag,
  importedGeneration,
  isMintedGeneration,
  metadataEtagOf,
  newGeneration,
  isNotModified,
  parseIfNoneMatch,
  stampedValidator,
  storedMetadataFromFile,
  validatorOf,
  withoutLocalSegment
} from '../src/lib/etag.js'

const stamp = {
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedAtCounter: 1,
  originId: 'o'
}

describe('newGeneration', () => {
  it('mints an alphanumeric base58 marker', () => {
    assert.match(newGeneration(), /^[A-Za-z0-9]+$/)
  })

  it('mints a distinct marker on every call', () => {
    assert.notEqual(newGeneration(), newGeneration())
  })
})

describe('isMintedGeneration and importedGeneration', () => {
  it('accepts a minted generation', () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      assert.equal(isMintedGeneration(newGeneration()), true)
    }
  })

  it('refuses a value that could corrupt the quoted ETag, or is not base58', () => {
    for (const value of [
      '',
      'a.b',
      'quote"d',
      'line\nbreak',
      ' padded',
      '0OIl',
      'x'.repeat(65),
      42,
      null,
      undefined,
      {}
    ]) {
      assert.equal(isMintedGeneration(value), false, JSON.stringify(value))
    }
  })

  it('keeps a minted archived generation and replaces any other', () => {
    const minted = newGeneration()
    assert.equal(importedGeneration(minted), minted)
    for (const archived of ['a.b', undefined, 7]) {
      const replaced = importedGeneration(archived)
      assert.equal(isMintedGeneration(replaced), true)
      assert.notEqual(replaced, archived)
    }
  })
})

describe('formatEtag', () => {
  it('joins generation, ms, counter and origin with dots, quoted', () => {
    assert.equal(
      formatEtag({
        generation: '3mJr7AoUXx2',
        stamp: {
          updatedAt: '2026-01-01T00:00:00.000Z',
          updatedAtCounter: 3,
          originId: 'zOrigin'
        }
      }),
      '"3mJr7AoUXx2.1767225600000.3.zOrigin"'
    )
  })

  it('appends the local segment when the validator carries one', () => {
    assert.equal(
      formatEtag({
        generation: 'abc',
        stamp: {
          updatedAt: '1970-01-01T00:00:00.005Z',
          updatedAtCounter: 0,
          originId: 'o'
        },
        local: 2
      }),
      '"abc.5.0.o.2"'
    )
  })
})

describe('stampedValidator', () => {
  it('keeps only the stamp members of a whole stored record', () => {
    assert.deepEqual(
      stampedValidator({
        generation: 'abc',
        stamp: { ...stamp, generation: 'abc', body: 'x' } as typeof stamp
      }),
      { generation: 'abc', stamp }
    )
  })

  it('carries a local segment of 0', () => {
    assert.equal(
      stampedValidator({ generation: 'abc', stamp, local: 0 }).local,
      0
    )
  })
})

describe('validatorOf and etagOf', () => {
  it('formats the validator when every part is present', () => {
    assert.equal(
      etagOf({ generation: 'abc', ...stamp }),
      '"abc.1767225600000.1.o"'
    )
    assert.deepEqual(validatorOf({ generation: 'abc', ...stamp }), {
      generation: 'abc',
      stamp
    })
  })

  it('adds the local segment, 0 included', () => {
    assert.equal(
      etagOf({ generation: 'abc', ...stamp, local: 0 }),
      '"abc.1767225600000.1.o.0"'
    )
  })

  it('is undefined when the generation is missing', () => {
    assert.equal(etagOf(stamp), undefined)
  })

  it.each(['updatedAt', 'updatedAtCounter', 'originId'] as const)(
    'is undefined when %s is missing',
    member => {
      const { [member]: _dropped, ...rest } = stamp
      assert.equal(etagOf({ generation: 'abc', ...rest }), undefined)
    }
  )

  it('is undefined when updatedAt does not parse', () => {
    assert.equal(
      etagOf({ generation: 'abc', ...stamp, updatedAt: 'nope' }),
      undefined
    )
  })

  it('is undefined when every part is missing', () => {
    assert.equal(etagOf({}), undefined)
  })
})

describe('metadata file helpers', () => {
  it('embeds _generation and _local, leaving the stamp members bare', () => {
    assert.deepEqual(
      embedMetadataValidator({
        body: { name: 'x', ...stamp },
        generation: 'abc',
        local: 2
      }),
      { name: 'x', ...stamp, _generation: 'abc', _local: 2 }
    )
  })

  it('leaves out a missing part rather than writing undefined', () => {
    const embedded = embedMetadataValidator({ body: { name: 'x' } })
    assert.deepEqual(Object.keys(embedded), ['name'])
  })

  it('an archive entry embeds _generation alone', () => {
    assert.deepEqual(
      embedMetadataValidator({ body: { name: 'x' }, generation: 'abc' }),
      { name: 'x', _generation: 'abc' }
    )
  })

  it('lifts _generation and _local to metaGeneration and metaLocal', () => {
    assert.deepEqual(
      storedMetadataFromFile({
        name: 'x',
        ...stamp,
        _generation: 'abc',
        _local: 2
      }),
      { name: 'x', ...stamp, metaGeneration: 'abc', metaLocal: 2 }
    )
  })

  it('round-trips through embed and lift', () => {
    const embedded = embedMetadataValidator({
      body: { name: 'x', ...stamp },
      generation: 'abc',
      local: 0
    })
    assert.deepEqual(storedMetadataFromFile(embedded), {
      name: 'x',
      ...stamp,
      metaGeneration: 'abc',
      metaLocal: 0
    })
  })

  it('metadataEtagOf reads a missing local segment as 0', () => {
    assert.equal(
      metadataEtagOf({ ...stamp, metaGeneration: 'abc' }),
      '"abc.1767225600000.1.o.0"'
    )
    assert.equal(
      metadataEtagOf({ ...stamp, metaGeneration: 'abc', metaLocal: 3 }),
      '"abc.1767225600000.1.o.3"'
    )
    assert.equal(metadataEtagOf(undefined), undefined)
  })
})

describe('withoutLocalSegment', () => {
  it('removes _local and keeps every other member', () => {
    const bytes = Buffer.from(
      JSON.stringify({ name: 'x', _generation: 'abc', _local: 2 })
    )
    assert.deepEqual(JSON.parse(withoutLocalSegment(bytes).toString('utf8')), {
      name: 'x',
      _generation: 'abc'
    })
  })

  it('returns bytes with no _local unchanged', () => {
    const bytes = Buffer.from(JSON.stringify({ name: 'x' }))
    assert.equal(withoutLocalSegment(bytes), bytes)
  })

  it('returns bytes that are not a JSON object unchanged', () => {
    for (const text of ['not json', '[1]', 'null']) {
      const bytes = Buffer.from(text)
      assert.equal(withoutLocalSegment(bytes), bytes)
    }
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
