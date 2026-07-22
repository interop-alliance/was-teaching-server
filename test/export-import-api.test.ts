/**
 * Wire-level tests (Vitest) for the Space export/import HTTP handlers
 * (`POST /space/:spaceId/export` and `POST /space/:spaceId/import`). These
 * cover the request layer only -- status codes, response headers, 404 authz
 * masking for non-controllers, the `application/x-tar` request/response
 * content-types, the streamed export/import round-trip, the `ImportStats`
 * response body shape, and the `invalid-import` problem-details shapes that a
 * malformed upload produces. The archive-building/parsing logic itself is
 * covered separately at the lib layer in `test/importTar.test.ts`; this suite
 * does not duplicate it.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Buffer } from 'node:buffer'
import type { FastifyInstance } from 'fastify'
import * as tar from 'tar-stream'
import YAML from 'yaml'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { startTestServer, zcapClients } from './helpers.js'

const NOT_FOUND_TYPE = 'https://wallet.storage/spec#not-found'
const INVALID_IMPORT_TYPE = 'https://wallet.storage/spec#invalid-import'

/**
 * Serializes a set of tar entries to a `Uint8Array`, for a signed `x-tar`
 * import body. A `null` body marks a directory entry; a string body is packed
 * as a UTF-8 file.
 *
 * @param entries {Array<[string, string | null]>}   `[name, body]` pairs
 * @returns {Promise<Uint8Array>}
 */
async function packTar(
  entries: Array<[string, string | null]>
): Promise<Uint8Array> {
  const pack = tar.pack()
  for (const [name, body] of entries) {
    if (body === null) {
      pack.entry({ name, type: 'directory' })
    } else {
      pack.entry({ name }, body)
    }
  }
  pack.finalize()
  const chunks: Buffer[] = []
  for await (const chunk of pack) {
    chunks.push(chunk as Buffer)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

/** A minimal, valid UBC v0.1 manifest body (YAML). */
function validManifestYaml(): string {
  return YAML.stringify({
    'ubc-version': '0.1',
    contents: { space: { url: 'https://example/spec#spaces' } }
  })
}

describe('Export/Import Space API (wire level)', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    bob: any
  const sourceSpaceId = `export-src-${crypto.randomUUID()}`
  const collectionId = 'notes'
  const resourceId = 'note1'

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice, bob } = await zcapClients({ serverUrl }))

    // Provision a source Space with one Collection and one Resource, so the
    // export has real content to stream back and the round-trip has something
    // to reconstruct.
    const space = await alice.was.createSpace({
      id: sourceSpaceId,
      name: 'Export Source',
      controller: alice.did
    })
    await space.createCollection({ id: collectionId, name: 'Notes' })
    await alice.was.request({
      path: `/space/${sourceSpaceId}/${collectionId}/${resourceId}`,
      method: 'PUT',
      json: { id: resourceId, hello: 'world' }
    })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  describe('Export (POST /space/:spaceId/export)', () => {
    it('returns 200 with an application/x-tar body for the controller', async () => {
      const response = await alice.was.request({
        path: `/space/${sourceSpaceId}/export`,
        method: 'POST'
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type')!, /application\/x-tar/)
      const bytes = new Uint8Array(await response.arrayBuffer())
      assert.ok(bytes.length > 0, 'expected a non-empty tar body')
    })

    it('masks a non-controller export as 404 (not 403)', async () => {
      // Bob is not the Space controller. The privacy-merged authz convention
      // answers with `not-found` rather than leaking the Space's existence.
      let expectedError: any
      try {
        await bob.was.request({
          path: `/space/${sourceSpaceId}/export`,
          method: 'POST'
        })
      } catch (err) {
        expectedError = err
      }
      assert.ok(
        expectedError,
        'expected the non-controller export to be denied'
      )
      assert.equal(expectedError.response.status, 404)
      assert.equal(expectedError.data.type, NOT_FOUND_TYPE)
    })

    it('masks an export of a non-existent Space as 404', async () => {
      let expectedError: any
      try {
        await alice.was.request({
          path: `/space/${crypto.randomUUID()}/export`,
          method: 'POST'
        })
      } catch (err) {
        expectedError = err
      }
      assert.ok(expectedError)
      assert.equal(expectedError.response.status, 404)
      assert.equal(expectedError.data.type, NOT_FOUND_TYPE)
    })
  })

  describe('Import (POST /space/:spaceId/import)', () => {
    it('round-trips: an exported tar imports into a fresh Space (200 + ImportStats)', async () => {
      // Export the source Space, then import that same tar into a distinct,
      // pre-provisioned destination Space and confirm the Resource is restored.
      const exportResponse = await alice.was.request({
        path: `/space/${sourceSpaceId}/export`,
        method: 'POST'
      })
      const tarBytes = new Uint8Array(await exportResponse.arrayBuffer())

      const destSpaceId = `export-dest-${crypto.randomUUID()}`
      await alice.was.createSpace({
        id: destSpaceId,
        name: 'Import Destination',
        controller: alice.did
      })

      const importResponse = await alice.was.request({
        path: `/space/${destSpaceId}/import`,
        method: 'POST',
        body: tarBytes,
        headers: { 'content-type': 'application/x-tar' }
      })
      assert.equal(importResponse.status, 200)

      // ImportStats: all six tally fields present and numeric, with at least the
      // one Collection and one Resource from the source counted as created.
      const stats = importResponse.data
      for (const field of [
        'collectionsCreated',
        'collectionsSkipped',
        'resourcesCreated',
        'resourcesSkipped',
        'policiesCreated',
        'policiesSkipped'
      ]) {
        assert.equal(
          typeof stats[field],
          'number',
          `expected numeric ImportStats.${field}`
        )
      }
      assert.ok(stats.collectionsCreated >= 1, 'expected a Collection created')
      assert.ok(stats.resourcesCreated >= 1, 'expected a Resource created')

      // The imported Resource is readable in the destination Space.
      const readBack = await alice.was.request({
        path: `/space/${destSpaceId}/${collectionId}/${resourceId}`,
        method: 'GET'
      })
      assert.equal(readBack.status, 200)
      assert.equal(readBack.data.hello, 'world')
    })

    it('is idempotent on re-import: a second import skips the existing items', async () => {
      // A re-import over the same destination counts the pre-existing Collection
      // and Resource as skipped rather than created.
      const exportResponse = await alice.was.request({
        path: `/space/${sourceSpaceId}/export`,
        method: 'POST'
      })
      const tarBytes = new Uint8Array(await exportResponse.arrayBuffer())

      const destSpaceId = `export-dest-${crypto.randomUUID()}`
      await alice.was.createSpace({
        id: destSpaceId,
        name: 'Re-import Destination',
        controller: alice.did
      })

      const first = await alice.was.request({
        path: `/space/${destSpaceId}/import`,
        method: 'POST',
        body: tarBytes,
        headers: { 'content-type': 'application/x-tar' }
      })
      assert.equal(first.status, 200)
      assert.ok(first.data.collectionsCreated >= 1)

      const second = await alice.was.request({
        path: `/space/${destSpaceId}/import`,
        method: 'POST',
        body: tarBytes,
        headers: { 'content-type': 'application/x-tar' }
      })
      assert.equal(second.status, 200)
      assert.equal(second.data.collectionsCreated, 0)
      assert.ok(second.data.collectionsSkipped >= 1)
      assert.ok(second.data.resourcesSkipped >= 1)
    })

    it('masks a non-controller import as 404 (not 403)', async () => {
      // Authorization is checked before the archive is applied, so Bob's import
      // is denied with the privacy-merged `not-found` even with a valid tar.
      const tarBytes = await packTar([
        ['manifest.yml', validManifestYaml()],
        ['space/', null],
        [`space/${sourceSpaceId}/`, null],
        [
          `space/${sourceSpaceId}/.space.${sourceSpaceId}.json`,
          JSON.stringify({ id: sourceSpaceId })
        ]
      ])
      let expectedError: any
      try {
        await bob.was.request({
          path: `/space/${sourceSpaceId}/import`,
          method: 'POST',
          body: tarBytes,
          headers: { 'content-type': 'application/x-tar' }
        })
      } catch (err) {
        expectedError = err
      }
      assert.ok(
        expectedError,
        'expected the non-controller import to be denied'
      )
      assert.equal(expectedError.response.status, 404)
      assert.equal(expectedError.data.type, NOT_FOUND_TYPE)
    })

    it('rejects a non-tar body with 400 invalid-import', async () => {
      // Garbage bytes are not a decodable tar. The extractor throws a generic
      // Error, which the handler wraps as `invalid-import` (400) -- exercising
      // the catch-and-wrap branch for unexpected decode failures.
      const garbage = new TextEncoder().encode(
        'this is definitely not a tar archive'.repeat(8)
      )
      let expectedError: any
      try {
        await alice.was.request({
          path: `/space/${sourceSpaceId}/import`,
          method: 'POST',
          body: garbage,
          headers: { 'content-type': 'application/x-tar' }
        })
      } catch (err) {
        expectedError = err
      }
      assert.ok(expectedError, 'expected the garbage upload to be rejected')
      assert.equal(expectedError.response.status, 400)
      assert.equal(expectedError.data.type, INVALID_IMPORT_TYPE)
    })

    it('rejects a tar with no manifest with 400 invalid-import', async () => {
      // A well-formed tar that lacks `manifest.yml` fails the manifest check,
      // which throws a typed InvalidImportError -- passed through unchanged
      // (400 `invalid-import`) by the handler.
      const tarBytes = await packTar([['space/', null]])
      let expectedError: any
      try {
        await alice.was.request({
          path: `/space/${sourceSpaceId}/import`,
          method: 'POST',
          body: tarBytes,
          headers: { 'content-type': 'application/x-tar' }
        })
      } catch (err) {
        expectedError = err
      }
      assert.ok(expectedError)
      assert.equal(expectedError.response.status, 400)
      assert.equal(expectedError.data.type, INVALID_IMPORT_TYPE)
    })

    it('rejects a tar with an unsupported manifest version with 400 invalid-import', async () => {
      const tarBytes = await packTar([
        ['manifest.yml', YAML.stringify({ 'ubc-version': '0.2' })]
      ])
      let expectedError: any
      try {
        await alice.was.request({
          path: `/space/${sourceSpaceId}/import`,
          method: 'POST',
          body: tarBytes,
          headers: { 'content-type': 'application/x-tar' }
        })
      } catch (err) {
        expectedError = err
      }
      assert.ok(expectedError)
      assert.equal(expectedError.response.status, 400)
      assert.equal(expectedError.data.type, INVALID_IMPORT_TYPE)
    })

    it('rejects a valid manifest carrying no space data with 400 invalid-import', async () => {
      // The manifest validates, but there is no `space/<id>/` data to plan --
      // buildImportPlan throws a typed InvalidImportError.
      const tarBytes = await packTar([['manifest.yml', validManifestYaml()]])
      let expectedError: any
      try {
        await alice.was.request({
          path: `/space/${sourceSpaceId}/import`,
          method: 'POST',
          body: tarBytes,
          headers: { 'content-type': 'application/x-tar' }
        })
      } catch (err) {
        expectedError = err
      }
      assert.ok(expectedError)
      assert.equal(expectedError.response.status, 400)
      assert.equal(expectedError.data.type, INVALID_IMPORT_TYPE)
    })

    it('masks an import into a non-existent Space as 404', async () => {
      const tarBytes = await packTar([['manifest.yml', validManifestYaml()]])
      let expectedError: any
      try {
        await alice.was.request({
          path: `/space/${crypto.randomUUID()}/import`,
          method: 'POST',
          body: tarBytes,
          headers: { 'content-type': 'application/x-tar' }
        })
      } catch (err) {
        expectedError = err
      }
      assert.ok(expectedError)
      assert.equal(expectedError.response.status, 404)
      assert.equal(expectedError.data.type, NOT_FOUND_TYPE)
    })
  })
})
