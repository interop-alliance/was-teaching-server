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
import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import * as tar from 'tar-stream'
import YAML from 'yaml'

import { extractTarEntries } from '../src/lib/importTar.js'
import {
  anHourFromNow,
  client,
  delegate,
  openTempBackend,
  startTestServer,
  zcapClients
} from './helpers.js'

const NOT_FOUND_TYPE = 'https://w3id.org/pws#not-found'
const INVALID_IMPORT_TYPE = 'https://w3id.org/pws#invalid-import'

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
  let fastify: FastifyInstance, serverUrl: string, alice: any, bob: any
  const sourceSpaceId = `export-src-${crypto.randomUUID()}`
  const collectionId = 'notes'
  const resourceId = 'note1'

  beforeAll(async () => {
    ;({ fastify, serverUrl } = await startTestServer({
      backend: await openTempBackend()
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

    it("carries the served Service Description as the archive's service.json", async () => {
      const response = await alice.was.request({
        path: `/space/${sourceSpaceId}/export`,
        method: 'POST'
      })
      const entries = await extractTarEntries(
        Readable.from(Buffer.from(await response.arrayBuffer()))
      )
      const names = [...entries.keys()]
      // Written immediately after the manifest, which the reader relies on.
      assert.deepEqual(names.slice(0, 2), ['manifest.yml', 'service.json'])

      const served = await fetch(new URL('/service', serverUrl))
      assert.equal(served.status, 200)
      assert.deepEqual(
        JSON.parse(entries.get('service.json')!.body!.toString('utf8')),
        await served.json()
      )
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
      // Alice invoked the root capability, so the archived Space Metadata
      // object's user-writable members were applied.
      assert.equal(stats.spaceMetadata, 'restored')
      // This server has no identity, so its export carries no provenance:
      // every object it holds is counted unattested, and nothing else.
      const { unattested, ...attested } = stats.provenance
      assert.ok(unattested >= 3, 'expected unattested objects counted')
      assert.deepStrictEqual(attested, {
        verified: 0,
        proofInvalid: 0,
        contentMismatch: 0,
        unknownSigner: 0
      })

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

  describe("the Space Metadata object's server-derived backends", () => {
    it('is served on Read Space, naming the server default backend', async () => {
      const response = await alice.was.request({
        path: `/space/${sourceSpaceId}/meta`,
        method: 'GET'
      })
      assert.equal(response.status, 200)
      const { backends } = response.data
      assert.ok(Array.isArray(backends), 'expected a backends array')
      assert.ok(
        backends.some((backend: any) => backend.id === 'default'),
        "expected the server's default backend in the listing"
      )
      // The same listing `GET /space/{id}/backends` serves.
      const served = await alice.was.request({
        path: `/space/${sourceSpaceId}/backends`,
        method: 'GET'
      })
      assert.deepEqual(backends, served.data)
    })

    it("rides along in the archive's Space Metadata entry", async () => {
      const response = await alice.was.request({
        path: `/space/${sourceSpaceId}/export`,
        method: 'POST'
      })
      const entries = await extractTarEntries(
        Readable.from(Buffer.from(await response.arrayBuffer()))
      )
      const archived = JSON.parse(
        entries
          .get(`space/${sourceSpaceId}/.space.${sourceSpaceId}.json`)!
          .body!.toString('utf8')
      )
      assert.ok(
        archived.backends.some((backend: any) => backend.id === 'default'),
        'expected the backends listing in the archived object'
      )
      // The archived generation still travels beside it; the local counter
      // does not.
      assert.equal(typeof archived._generation, 'string')
      assert.equal(archived._local, undefined)
    })

    it('is ignored when a write body supplies one', async () => {
      const spaceId = `backends-write-${crypto.randomUUID()}`
      const created = await alice.was.request({
        path: `/space/${spaceId}/meta`,
        method: 'PUT',
        json: {
          id: spaceId,
          name: 'Supplied backends',
          controller: alice.did,
          backends: [{ id: 'forged', managedBy: 'server' }]
        }
      })
      assert.equal(created.status, 201)
      assert.ok(
        !created.data.backends.some((backend: any) => backend.id === 'forged'),
        'expected the supplied backends to be dropped from the create echo'
      )

      const updated = await alice.was.request({
        path: `/space/${spaceId}/meta`,
        method: 'PUT',
        json: {
          id: spaceId,
          name: 'Supplied backends again',
          controller: alice.did,
          backends: [{ id: 'forged', managedBy: 'server' }]
        }
      })
      assert.equal(updated.status, 204)

      const read = await alice.was.request({
        path: `/space/${spaceId}/meta`,
        method: 'GET'
      })
      assert.ok(
        !read.data.backends.some((backend: any) => backend.id === 'forged'),
        'expected the supplied backends never to be stored'
      )
    })
  })

  describe('import and the archived Space Metadata object', () => {
    /**
     * Provisions a Space carrying a distinctive `name` (and the given `type`),
     * and exports it. The archive's Space Metadata entry is what each case
     * below restores (or declines to restore) into a fresh destination Space.
     *
     * @param options {object}
     * @param [options.type] {string[]}   the source Space's `type`; the
     *   destination's is the default `['Space']`
     * @returns {Promise<{ tarBytes: Uint8Array, type: string[], name: string }>}
     */
    async function archivedSource({
      type = ['Space']
    }: { type?: string[] } = {}): Promise<{
      tarBytes: Uint8Array
      type: string[]
      name: string
    }> {
      const spaceId = `meta-src-${crypto.randomUUID()}`
      const name = 'Archived Name'
      const created = await alice.was.request({
        path: `/space/${spaceId}/meta`,
        method: 'PUT',
        json: { id: spaceId, type, name, controller: alice.did }
      })
      assert.equal(created.status, 201)
      const exported = await alice.was.request({
        path: `/space/${spaceId}/export`,
        method: 'POST'
      })
      return {
        tarBytes: new Uint8Array(await exported.arrayBuffer()),
        type,
        name
      }
    }

    /**
     * Provisions a plain destination Space to import into.
     *
     * @returns {Promise<string>}   the destination Space id
     */
    async function destination(): Promise<string> {
      const spaceId = `meta-dest-${crypto.randomUUID()}`
      await alice.was.createSpace({
        id: spaceId,
        name: 'Destination Name',
        controller: alice.did
      })
      return spaceId
    }

    it('restores the archived name under a root invocation', async () => {
      const { tarBytes, type, name } = await archivedSource()
      const destSpaceId = await destination()

      const imported = await alice.was.request({
        path: `/space/${destSpaceId}/import`,
        method: 'POST',
        body: tarBytes,
        headers: { 'content-type': 'application/x-tar' }
      })
      assert.equal(imported.status, 200)
      assert.equal(imported.data.spaceMetadata, 'restored')

      const read = await alice.was.request({
        path: `/space/${destSpaceId}/meta`,
        method: 'GET'
      })
      assert.equal(read.data.name, name)
      assert.deepEqual(read.data.type, [...type].sort())
      // Never the controller, and never a server-derived member: the
      // destination keeps its own.
      assert.equal(read.data.controller, alice.did)
      assert.equal(read.data.id, destSpaceId)
      assert.equal(read.data.url, `/space/${destSpaceId}/`)
    })

    it("refuses an archive whose type differs from the destination's (400 invalid-import)", async () => {
      // A Space's `type` is immutable once it exists, so an archive of a
      // Space of another kind is refused rather than applied -- before
      // anything is written, so the destination keeps its name too.
      const { tarBytes } = await archivedSource({
        type: ['AuxiliarySpace', 'Space']
      })
      const destSpaceId = await destination()

      let expectedError: any
      try {
        await alice.was.request({
          path: `/space/${destSpaceId}/import`,
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
      assert.match(expectedError.data.errors[0].detail, /"type" does not match/)

      const read = await alice.was.request({
        path: `/space/${destSpaceId}/meta`,
        method: 'GET'
      })
      assert.equal(read.data.name, 'Destination Name')
      assert.deepEqual(read.data.type, ['Space'])
    })

    it('treats a Space Metadata entry that is not a JSON object as absent', async () => {
      // A garbage entry is not a Space Metadata object; the rest of the
      // archive imports as it would with no entry at all.
      const destSpaceId = await destination()
      const tarBytes = await packTar([
        ['manifest.yml', validManifestYaml()],
        ['space/', null],
        [`space/${destSpaceId}/`, null],
        [`space/${destSpaceId}/.space.${destSpaceId}.json`, '{not json'],
        [`space/${destSpaceId}/notes/`, null]
      ])
      const imported = await alice.was.request({
        path: `/space/${destSpaceId}/import`,
        method: 'POST',
        body: tarBytes,
        headers: { 'content-type': 'application/x-tar' }
      })
      assert.equal(imported.status, 200)
      assert.equal(imported.data.spaceMetadata, 'absent')
      assert.equal(imported.data.collectionsCreated, 1)

      const read = await alice.was.request({
        path: `/space/${destSpaceId}/meta`,
        method: 'GET'
      })
      assert.equal(read.data.name, 'Destination Name')
    })

    it('skips them under a delegated chain, reporting "skipped"', async () => {
      const { tarBytes, name } = await archivedSource()
      const destSpaceId = await destination()

      // A Space-subtree grant to Bob: it reaches the import route by
      // attenuation, but it is not an invocation of the root capability.
      const spaceUrl = new URL(`/space/${destSpaceId}/`, serverUrl).toString()
      const capability = await delegate({
        signer: alice.signer,
        capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
        invocationTarget: spaceUrl,
        controller: bob.did,
        allowedActions: ['GET', 'PUT', 'POST', 'DELETE'],
        expires: anHourFromNow()
      })
      const imported = await client({ signer: bob.signer }).request({
        url: new URL(`/space/${destSpaceId}/import`, serverUrl).toString(),
        method: 'POST',
        action: 'POST',
        capability,
        headers: { 'content-type': 'application/x-tar' },
        body: Buffer.from(tarBytes)
      })
      assert.equal(imported.status, 200)
      assert.equal((imported.data as any).spaceMetadata, 'skipped')

      const read = await alice.was.request({
        path: `/space/${destSpaceId}/meta`,
        method: 'GET'
      })
      assert.equal(read.data.name, 'Destination Name')
      assert.notEqual(read.data.name, name)
      assert.deepEqual(read.data.type, ['Space'])
      assert.equal(read.data.controller, alice.did)
    })

    it('reports "absent" for an archive carrying no Space Metadata entry', async () => {
      const destSpaceId = await destination()
      const tarBytes = await packTar([
        ['manifest.yml', validManifestYaml()],
        ['space/', null],
        [`space/${destSpaceId}/`, null],
        [`space/${destSpaceId}/notes/`, null]
      ])
      const imported = await alice.was.request({
        path: `/space/${destSpaceId}/import`,
        method: 'POST',
        body: tarBytes,
        headers: { 'content-type': 'application/x-tar' }
      })
      assert.equal(imported.status, 200)
      assert.equal(imported.data.spaceMetadata, 'absent')

      const read = await alice.was.request({
        path: `/space/${destSpaceId}/meta`,
        method: 'GET'
      })
      assert.equal(read.data.name, 'Destination Name')
    })
  })
})
