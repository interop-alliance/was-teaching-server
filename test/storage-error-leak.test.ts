/**
 * Regression tests for StorageError leakage: the client-visible
 * `application/problem+json` body of a 500 storage fault must never carry the
 * underlying cause message (filesystem paths, errnos, SQL) -- that detail
 * belongs in the server-side log only.
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'
import Fastify from 'fastify'

import {
  handleError,
  rethrowOrWrapStorageError,
  StorageError
} from '../src/errors.js'

// A cause message with the kind of server-internal detail (an absolute
// filesystem path and an errno) that must never reach a client.
const SENSITIVE_MESSAGE =
  "ENOENT: no such file or directory, open '/var/lib/was/data/space/abc/collection/def'"

describe('StorageError leakage', () => {
  it('does not copy the cause message into title or detail', () => {
    const cause = new Error(SENSITIVE_MESSAGE)
    const error = new StorageError({ cause, requestName: 'Resource' })

    assert.equal(error.statusCode, 500)
    assert.equal(error.title, 'Storage Error (Resource)')
    assert.ok(!error.title.includes(SENSITIVE_MESSAGE))
    assert.ok(!error.detail.includes(SENSITIVE_MESSAGE))
    // The cause is preserved for server-side logging in handleError.
    assert.equal(error.cause, cause)
  })

  it('serializes a generic problem+json body over the wire', async () => {
    const app = Fastify()
    app.setErrorHandler(handleError)
    app.get('/boom', async () => {
      try {
        throw new Error(SENSITIVE_MESSAGE)
      } catch (err) {
        rethrowOrWrapStorageError({ err, requestName: 'Resource' })
      }
    })

    const response = await app.inject({ method: 'GET', url: '/boom' })
    await app.close()

    assert.equal(response.statusCode, 500)
    assert.match(
      response.headers['content-type'] ?? '',
      /^application\/problem\+json/
    )
    assert.ok(!response.body.includes('ENOENT'))
    assert.ok(!response.body.includes('/var/lib/was'))
    const body = response.json() as {
      type: string
      title: string
      errors: Array<{ detail: string }>
    }
    assert.match(body.type, /storage-error/)
    assert.equal(body.title, 'Storage Error (Resource)')
    assert.equal(body.errors[0]?.detail, 'An internal storage error occurred.')
  })
})
