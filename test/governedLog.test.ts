/**
 * Unit tests for the governing history log helpers (`src/lib/governedLog.ts`)
 * at the stored-data boundary: a stored log body the line contract rejects is
 * a server-side fault (`StorageError`, 500), not the client-facing 400 the
 * parser raises on a request body.
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'

import { deriveGovernedEncryption } from '../src/lib/governedLog.js'
import { StorageError } from '../src/errors.js'

describe('deriveGovernedEncryption', () => {
  const logUrl = 'https://was.example/space/s/c/meta/log'

  it('derives the head state with history stamped on', () => {
    const body =
      JSON.stringify({
        parameters: { method: 'resource-log:0.1' },
        state: { scheme: 'edv' }
      }) + '\n'
    assert.deepStrictEqual(deriveGovernedEncryption({ body, logUrl }), {
      scheme: 'edv',
      history: { method: 'resource-log:0.1', resource: logUrl }
    })
  })

  it('surfaces a stored body that breaks the line contract as StorageError', () => {
    for (const body of ['', 'not json\n', '{"noState":true}\n']) {
      assert.throws(
        () => deriveGovernedEncryption({ body, logUrl }),
        (err: Error) => err instanceof StorageError && err.statusCode === 500,
        `body ${JSON.stringify(body)}`
      )
    }
  })
})
