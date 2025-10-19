/**
 * Storage tests
 * Using Node.js test runner
 * @see https://nodejs.org/api/test.html
 */
import { it, describe } from 'node:test'
import assert from 'node:assert'
import { fileNameFor } from '../src/storage.js'

describe('Storage API', () => {
  describe('fileNameFor()', () => {
    it('should map a content type to filename', () => {
      const filename = fileNameFor({
        resourceId: '12345', shortname: 'blog-post', contentType: 'application/json'
      })
      assert.equal(filename, 'r.12345.application%2Fjson.json')
    })
  })
})
