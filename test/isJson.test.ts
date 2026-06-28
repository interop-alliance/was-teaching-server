/**
 * Unit tests for the `isJson` content-type classifier (`src/lib/isJson.ts`).
 * The `json` token is anchored to the end of the media type, so content-types
 * that merely begin with `json` (JSON Lines, NDJSON, JSON-seq) are NOT JSON and
 * take the binary blob path.
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'
import { isJson } from '../src/lib/isJson.js'

describe('isJson', () => {
  const jsonTypes = [
    'application/json',
    'application/JSON',
    'application/json; charset=utf-8',
    'application/ld+json',
    'application/edv+json',
    'application/vnd.api+json',
    'application/problem+json'
  ]
  for (const contentType of jsonTypes) {
    it(`treats ${contentType} as JSON`, () => {
      assert.equal(isJson({ contentType }), true)
    })
  }

  const nonJsonTypes = [
    'application/jsonl',
    'application/json-seq',
    'application/json5',
    'application/x-ndjson',
    'application/octet-stream',
    'text/plain',
    'image/png',
    'text/json',
    undefined
  ]
  for (const contentType of nonJsonTypes) {
    it(`does not treat ${contentType} as JSON`, () => {
      assert.equal(isJson({ contentType }), false)
    })
  }
})
