/**
 * Unit tests for the governing history log helpers (`src/lib/governedLog.ts`)
 * at the stored-data boundary: a stored log body the parser rejects is
 * a server-side fault (`StorageError`, 500), not the client-facing 400 the
 * parser raises on a request body.
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'

import { deriveGovernedDescriptors } from '../src/lib/governedLog.js'
import { StorageError } from '../src/errors.js'

describe('deriveGovernedDescriptors', () => {
  const logUrl = 'https://was.example/space/s/c/meta/log'

  it('derives the head state with history stamped on', () => {
    const body =
      JSON.stringify({
        parameters: { method: 'resource-log:0.1' },
        state: { scheme: 'edv' }
      }) + '\n'
    assert.deepStrictEqual(deriveGovernedDescriptors({ body, logUrl }), {
      encryption: {
        scheme: 'edv',
        history: { method: 'resource-log:0.1', resource: logUrl }
      }
    })
  })

  it('serves the state revisions slot as the revisions descriptor', () => {
    const revisions = { immutable: true, merge: { kind: 'none' } }
    const body =
      JSON.stringify({
        parameters: { method: 'resource-log:0.1' },
        state: { scheme: 'edv', revisions }
      }) + '\n'
    assert.deepStrictEqual(deriveGovernedDescriptors({ body, logUrl }), {
      encryption: {
        scheme: 'edv',
        history: { method: 'resource-log:0.1', resource: logUrl }
      },
      revisions
    })
  })

  it('surfaces a stored body that breaks the line contract as StorageError', () => {
    for (const body of [
      '',
      'not json\n',
      '{"noState":true}\n',
      // A genesis without `parameters.method`.
      '{"state":{"scheme":"edv"}}\n',
      // A `state` carrying the server-stamped `history` member.
      '{"parameters":{"method":"m"},"state":{"history":{}}}\n'
    ]) {
      assert.throws(
        () => deriveGovernedDescriptors({ body, logUrl }),
        (err: Error) => err instanceof StorageError && err.statusCode === 500,
        `body ${JSON.stringify(body)}`
      )
    }
  })
})
