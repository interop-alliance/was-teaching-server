/**
 * WAS conformance tests — Server
 * Using Node.js test runner
 * @see https://nodejs.org/api/test.html
 */
import { it, describe } from 'node:test'
import assert from 'node:assert'

import { serverUrl } from './config.js'

describe('Server', () => {
  it('should GET /', async () => {
    const response = await fetch(serverUrl)
    assert.equal(response.status, 200)
  })
})
