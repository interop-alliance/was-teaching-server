/**
 * Storage tests (Vitest).
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import * as tar from 'tar-stream'
import YAML from 'yaml'
import { FileSystemBackend, fileNameFor } from '../src/backends/filesystem.js'

/**
 * Consumes a readable stream into a single string (test helper).
 * @param stream {Readable}
 * @returns {Promise<string>}
 */
async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

describe('Storage API', () => {
  describe('fileNameFor()', () => {
    it('should map a content type to filename', () => {
      const filename = fileNameFor({
        resourceId: '12345',
        contentType: 'application/json'
      })
      assert.equal(filename, 'r.12345.application%2Fjson.json')
    })
  })

  describe('FileSystemBackend.exportSpace()', () => {
    it('should export space tarball with manifest and serialized files', async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'was-export-test-'))
      await mkdir(path.join(tempDir, 'spaces'))
      const backend = new FileSystemBackend({ dataDir: tempDir })
      const spaceId = 'test-space'
      const collectionId = 'credentials'
      const resourceId = 'credential-1'

      try {
        await backend.writeSpace({
          spaceId,
          spaceDescription: {
            id: spaceId,
            type: ['Space'],
            name: 'Export Test Space',
            controller: 'did:key:test-controller'
          }
        })
        await backend.writeCollection({
          spaceId,
          collectionId,
          collectionDescription: {
            id: collectionId,
            type: ['Collection'],
            name: 'Verifiable Credentials'
          }
        })
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId,
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: {
              id: resourceId,
              type: ['VerifiableCredential']
            }
          }
        })

        const pack = await backend.exportSpace({ spaceId })
        const entries: Array<{ name: string; body: Buffer }> = []
        const extract = tar.extract()

        await new Promise<void>((resolve, reject) => {
          extract.on('entry', (header, stream, next) => {
            const chunks: Buffer[] = []
            stream.on('data', chunk => chunks.push(Buffer.from(chunk)))
            stream.on('end', () => {
              entries.push({
                name: header.name,
                body: Buffer.concat(chunks)
              })
              next()
            })
            stream.on('error', reject)
          })
          extract.on('finish', resolve)
          extract.on('error', reject)
          pack.on('error', reject)
          pack.pipe(extract)
        })

        const resourceFilename = fileNameFor({
          resourceId,
          contentType: 'application/json'
        })
        const entryNames = entries.map(entry => entry.name)

        assert.ok(entryNames.includes('manifest.yml'))
        assert.ok(entryNames.includes('space/'))
        assert.ok(entryNames.includes(`space/${spaceId}/`))
        assert.ok(
          entryNames.includes(`space/${spaceId}/.space.${spaceId}.json`)
        )
        assert.ok(entryNames.includes(`space/${spaceId}/${collectionId}/`))
        assert.ok(
          entryNames.includes(
            `space/${spaceId}/${collectionId}/.collection.${collectionId}.json`
          )
        )
        assert.ok(
          entryNames.includes(
            `space/${spaceId}/${collectionId}/${resourceFilename}`
          )
        )

        const manifestEntry = entries.find(
          entry => entry.name === 'manifest.yml'
        )
        assert.ok(manifestEntry)
        const manifest = YAML.parse(manifestEntry.body.toString('utf8'))

        assert.equal(manifest['ubc-version'], '0.1')
        assert.equal(
          manifest.contents.space.url,
          'https://digitalcredentials.github.io/wallet-attached-storage-spec/#spaces'
        )
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })
  })

  describe('FileSystemBackend export/import round-trips policies', () => {
    it('restores space, collection, and resource policies', async () => {
      const tempDir = await mkdtemp(
        path.join(os.tmpdir(), 'was-policy-roundtrip-')
      )
      await mkdir(path.join(tempDir, 'spaces'))
      const backend = new FileSystemBackend({ dataDir: tempDir })
      const src = 'source-space'
      const dst = 'target-space'
      const collectionId = 'credentials'
      const resourceId = 'vc-1'

      try {
        // Populate the source space with a policy at every level.
        await backend.writeSpace({
          spaceId: src,
          spaceDescription: {
            id: src,
            type: ['Space'],
            name: 'Source',
            controller: 'did:key:test-controller'
          }
        })
        await backend.writeCollection({
          spaceId: src,
          collectionId,
          collectionDescription: {
            id: collectionId,
            type: ['Collection'],
            name: 'Verifiable Credentials'
          }
        })
        await backend.writeResource({
          spaceId: src,
          collectionId,
          resourceId,
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { id: resourceId }
          }
        })
        await backend.writePolicy({
          spaceId: src,
          policy: { type: 'SpaceLevelPolicy' }
        })
        await backend.writePolicy({
          spaceId: src,
          collectionId,
          policy: { type: 'PublicCanRead' }
        })
        await backend.writePolicy({
          spaceId: src,
          collectionId,
          resourceId,
          policy: { type: 'ResourceLevelPolicy' }
        })

        // Export the source, then import the archive into a fresh target space.
        const pack = await backend.exportSpace({ spaceId: src })
        await backend.writeSpace({
          spaceId: dst,
          spaceDescription: {
            id: dst,
            type: ['Space'],
            name: 'Target',
            controller: 'did:key:test-controller'
          }
        })
        const stats = await backend.importSpace({
          spaceId: dst,
          tarStream: pack
        })

        assert.equal(stats.policiesCreated, 3)
        assert.equal(stats.policiesSkipped, 0)
        assert.deepEqual(await backend.getPolicy({ spaceId: dst }), {
          type: 'SpaceLevelPolicy'
        })
        assert.deepEqual(
          await backend.getPolicy({ spaceId: dst, collectionId }),
          { type: 'PublicCanRead' }
        )
        assert.deepEqual(
          await backend.getPolicy({ spaceId: dst, collectionId, resourceId }),
          { type: 'ResourceLevelPolicy' }
        )
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('restores resource metadata sidecars (custom + timestamps)', async () => {
      const tempDir = await mkdtemp(
        path.join(os.tmpdir(), 'was-meta-roundtrip-')
      )
      await mkdir(path.join(tempDir, 'spaces'))
      const backend = new FileSystemBackend({ dataDir: tempDir })
      const src = 'source-space'
      const dst = 'target-space'
      const collectionId = 'credentials'
      const resourceId = 'vc-1'

      try {
        await backend.writeSpace({
          spaceId: src,
          spaceDescription: {
            id: src,
            type: ['Space'],
            name: 'Source',
            controller: 'did:key:test-controller'
          }
        })
        await backend.writeCollection({
          spaceId: src,
          collectionId,
          collectionDescription: {
            id: collectionId,
            type: ['Collection'],
            name: 'Verifiable Credentials'
          }
        })
        await backend.writeResource({
          spaceId: src,
          collectionId,
          resourceId,
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { id: resourceId }
          }
        })
        await backend.writeResourceMetadata({
          spaceId: src,
          collectionId,
          resourceId,
          custom: { name: 'Credential One', tags: { status: 'final' } }
        })
        const before = await backend.getResourceMetadata({
          spaceId: src,
          collectionId,
          resourceId
        })

        const pack = await backend.exportSpace({ spaceId: src })
        await backend.writeSpace({
          spaceId: dst,
          spaceDescription: {
            id: dst,
            type: ['Space'],
            name: 'Target',
            controller: 'did:key:test-controller'
          }
        })
        await backend.importSpace({ spaceId: dst, tarStream: pack })

        const after = await backend.getResourceMetadata({
          spaceId: dst,
          collectionId,
          resourceId
        })
        assert.deepEqual(after!.custom, {
          name: 'Credential One',
          tags: { status: 'final' }
        })
        // Timestamps survive the roundtrip unchanged (sidecar carried verbatim).
        assert.equal(after!.createdAt, before!.createdAt)
        assert.equal(after!.updatedAt, before!.updatedAt)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('carries tombstones across an export/import roundtrip', async () => {
      const tempDir = await mkdtemp(
        path.join(os.tmpdir(), 'was-tombstone-roundtrip-')
      )
      await mkdir(path.join(tempDir, 'spaces'))
      const backend = new FileSystemBackend({ dataDir: tempDir })
      const src = 'source-space'
      const dst = 'target-space'
      const collectionId = 'notes'

      try {
        await backend.writeSpace({
          spaceId: src,
          spaceDescription: {
            id: src,
            type: ['Space'],
            name: 'Source',
            controller: 'did:key:test-controller'
          }
        })
        await backend.writeCollection({
          spaceId: src,
          collectionId,
          collectionDescription: { id: collectionId, type: ['Collection'], name: 'Notes' }
        })
        // A live resource and a soft-deleted one (a tombstone), in the same
        // Collection.
        await backend.writeResource({
          spaceId: src,
          collectionId,
          resourceId: 'live',
          input: { kind: 'json', contentType: 'application/json', data: { v: 1 } }
        })
        await backend.writeResource({
          spaceId: src,
          collectionId,
          resourceId: 'gone',
          input: { kind: 'json', contentType: 'application/json', data: { v: 1 } }
        })
        await backend.deleteResource({ spaceId: src, collectionId, resourceId: 'gone' })
        const srcTombstone = await backend._readMetaSidecar({
          collectionDir: path.join(tempDir, 'spaces', src, collectionId),
          resourceId: 'gone'
        })

        const pack = await backend.exportSpace({ spaceId: src })
        await backend.writeSpace({
          spaceId: dst,
          spaceDescription: {
            id: dst,
            type: ['Space'],
            name: 'Target',
            controller: 'did:key:test-controller'
          }
        })
        await backend.importSpace({ spaceId: dst, tarStream: pack })

        // The tombstone survives: no content file, a `deleted` sidecar carried
        // verbatim, and it stays invisible to normal reads on the target.
        const dstCollectionDir = path.join(tempDir, 'spaces', dst, collectionId)
        const dstTombstone = await backend._readMetaSidecar({
          collectionDir: dstCollectionDir,
          resourceId: 'gone'
        })
        assert.deepEqual(dstTombstone, srcTombstone, 'tombstone sidecar carried verbatim')
        const dstFiles = (await readdir(dstCollectionDir)).filter(name =>
          name.startsWith('r.gone.')
        )
        assert.deepEqual(dstFiles, [], 'no content file for the carried tombstone')

        const listing = await backend.listCollectionItems({
          spaceId: dst,
          collectionId
        })
        assert.deepEqual(
          listing.items.map(item => item.id),
          ['live'],
          'listing shows the live resource but not the tombstone'
        )
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })
  })

  describe('FileSystemBackend resourceId prefix collisions', () => {
    it('does not match a resourceId that is a prefix of another', async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'was-prefix-test-'))
      await mkdir(path.join(tempDir, 'spaces'))
      const backend = new FileSystemBackend({ dataDir: tempDir })
      const spaceId = 'test-space'
      const collectionId = 'notes'

      try {
        await backend.writeSpace({
          spaceId,
          spaceDescription: {
            id: spaceId,
            type: ['Space'],
            name: 'Prefix Test Space',
            controller: 'did:key:test-controller'
          }
        })
        await backend.writeCollection({
          spaceId,
          collectionId,
          collectionDescription: {
            id: collectionId,
            type: ['Collection'],
            name: 'Notes'
          }
        })
        // `note` is a prefix of `notebook`; the loose `r.note*` glob would have
        // matched both.
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'note',
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { which: 'note' }
          }
        })
        await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'notebook',
          input: {
            kind: 'json',
            contentType: 'application/json',
            data: { which: 'notebook' }
          }
        })

        // getResource resolves the exact id, not the prefix-sharing sibling.
        const noteResult = await backend.getResource({
          spaceId,
          collectionId,
          resourceId: 'note'
        })
        assert.deepEqual(
          JSON.parse(await streamToString(noteResult.resourceStream)),
          {
            which: 'note'
          }
        )

        // deleteResource removes only the exact id, leaving the sibling intact.
        await backend.deleteResource({
          spaceId,
          collectionId,
          resourceId: 'note'
        })

        const remaining = (
          await readdir(path.join(tempDir, 'spaces', spaceId, collectionId))
        ).filter(name => name.startsWith('r.'))
        assert.deepEqual(remaining, ['r.notebook.application%2Fjson.json'])

        const notebookResult = await backend.getResource({
          spaceId,
          collectionId,
          resourceId: 'notebook'
        })
        assert.deepEqual(
          JSON.parse(await streamToString(notebookResult.resourceStream)),
          { which: 'notebook' }
        )
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })
  })

  describe('FileSystemBackend tombstone soft-delete', () => {
    /**
     * Provisions a Space + Collection holding one JSON Resource, and returns the
     * backend, the temp dir, and the Collection dir path.
     */
    async function provisionResource() {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'was-tombstone-'))
      await mkdir(path.join(tempDir, 'spaces'))
      const backend = new FileSystemBackend({ dataDir: tempDir })
      const spaceId = 'test-space'
      const collectionId = 'notes'
      await backend.writeSpace({
        spaceId,
        spaceDescription: {
          id: spaceId,
          type: ['Space'],
          name: 'Tombstone Test Space',
          controller: 'did:key:test-controller'
        }
      })
      await backend.writeCollection({
        spaceId,
        collectionId,
        collectionDescription: { id: collectionId, type: ['Collection'], name: 'Notes' }
      })
      await backend.writeResource({
        spaceId,
        collectionId,
        resourceId: 'note',
        input: { kind: 'json', contentType: 'application/json', data: { v: 1 } }
      })
      const collectionDir = path.join(tempDir, 'spaces', spaceId, collectionId)
      return { backend, tempDir, spaceId, collectionId, collectionDir }
    }

    it('drops the content file but keeps the sidecar as a tombstone', async () => {
      const { backend, tempDir, spaceId, collectionId, collectionDir } =
        await provisionResource()
      try {
        await backend.deleteResource({ spaceId, collectionId, resourceId: 'note' })

        // No content representation remains, but the sidecar lingers.
        const entries = await readdir(collectionDir)
        assert.deepEqual(
          entries.filter(name => name.startsWith('r.')),
          [],
          'content file should be gone'
        )
        assert.ok(
          entries.includes('.meta.note.json'),
          'sidecar should remain as the tombstone'
        )

        // The tombstone records `deleted`, a bumped `version`, and the
        // last-known content-type (the content filename no longer carries it).
        const sidecar = await backend._readMetaSidecar({
          collectionDir,
          resourceId: 'note'
        })
        assert.equal(sidecar?.deleted, true)
        assert.equal(sidecar?.version, 2, 'version bumped from 1 to 2 on delete')
        assert.equal(sidecar?.contentType, 'application/json')
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('is invisible to getResource / getResourceMetadata after deletion', async () => {
      const { backend, tempDir, spaceId, collectionId } = await provisionResource()
      try {
        await backend.deleteResource({ spaceId, collectionId, resourceId: 'note' })

        await assert.rejects(
          backend.getResource({ spaceId, collectionId, resourceId: 'note' }),
          'getResource 404s on a tombstone'
        )
        const meta = await backend.getResourceMetadata({
          spaceId,
          collectionId,
          resourceId: 'note'
        })
        assert.equal(meta, undefined, 'getResourceMetadata 404s on a tombstone')

        const listing = await backend.listCollectionItems({ spaceId, collectionId })
        assert.deepEqual(listing.items, [], 'listing skips the tombstone')
        assert.equal(listing.totalItems, 0)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('continues the monotonic version when a tombstoned id is re-created', async () => {
      const { backend, tempDir, spaceId, collectionId, collectionDir } =
        await provisionResource()
      try {
        await backend.deleteResource({ spaceId, collectionId, resourceId: 'note' })
        const { version } = await backend.writeResource({
          spaceId,
          collectionId,
          resourceId: 'note',
          input: { kind: 'json', contentType: 'application/json', data: { v: 2 } }
        })
        assert.equal(version, 3, 're-create continues 1 -> 2 (tombstone) -> 3')

        // The revived Resource is readable and no longer a tombstone.
        const result = await backend.getResource({
          spaceId,
          collectionId,
          resourceId: 'note'
        })
        assert.deepEqual(JSON.parse(await streamToString(result.resourceStream)), {
          v: 2
        })
        const sidecar = await backend._readMetaSidecar({
          collectionDir,
          resourceId: 'note'
        })
        assert.equal(sidecar?.deleted, undefined, 'tombstone flag cleared on revive')
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('is idempotent: re-deleting a tombstone does not churn its version', async () => {
      const { backend, tempDir, spaceId, collectionId, collectionDir } =
        await provisionResource()
      try {
        await backend.deleteResource({ spaceId, collectionId, resourceId: 'note' })
        const first = await backend._readMetaSidecar({
          collectionDir,
          resourceId: 'note'
        })
        await backend.deleteResource({ spaceId, collectionId, resourceId: 'note' })
        const second = await backend._readMetaSidecar({
          collectionDir,
          resourceId: 'note'
        })
        assert.equal(second?.version, first?.version, 'version unchanged')
        assert.equal(second?.updatedAt, first?.updatedAt, 'updatedAt unchanged')
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })
  })

  describe('FileSystemBackend.reportUsage()', () => {
    /**
     * Provisions a Space with one Collection holding one JSON Resource, on a
     * backend with the given (optional) configured capacity.
     */
    async function provision(capacityBytes?: number) {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'was-usage-test-'))
      await mkdir(path.join(tempDir, 'spaces'))
      // Provision unlimited so the writes below are never blocked by quota
      // enforcement, then apply the capacity afterward -- these tests exercise
      // reportUsage()'s state derivation, not the write-path enforcement.
      const backend = new FileSystemBackend({ dataDir: tempDir })
      const spaceId = 'usage-space'
      const collectionId = 'credentials'
      await backend.writeSpace({
        spaceId,
        spaceDescription: {
          id: spaceId,
          type: ['Space'],
          name: 'Usage Test Space',
          controller: 'did:key:test-controller'
        }
      })
      await backend.writeCollection({
        spaceId,
        collectionId,
        collectionDescription: {
          id: collectionId,
          type: ['Collection'],
          name: 'Credentials'
        }
      })
      await backend.writeResource({
        spaceId,
        collectionId,
        resourceId: 'vc-1',
        input: {
          kind: 'json',
          contentType: 'application/json',
          data: { id: 'vc-1', name: 'A Verifiable Credential' }
        }
      })
      backend.capacityBytes = capacityBytes
      return { backend, spaceId, collectionId, tempDir }
    }

    it('reports non-zero usage and an unlimited limit by default', async () => {
      const { backend, spaceId, collectionId, tempDir } = await provision()
      try {
        const usage = await backend.reportUsage({ spaceId })
        assert.equal(usage.id, 'default')
        assert.equal(usage.managedBy, 'server')
        assert.equal(usage.state, 'ok')
        assert.ok(usage.usageBytes > 0)
        assert.deepStrictEqual(usage.limit, { isUnlimited: true })
        assert.deepStrictEqual(usage.restrictedActions, [])
        // The per-Collection breakdown is opt-in (spec `?include=collections`),
        // so it is omitted by default and included only when requested.
        assert.equal(usage.usageByCollection, undefined)
        const detailed = await backend.reportUsage({
          spaceId,
          includeCollections: true
        })
        assert.ok(detailed.usageByCollection)
        assert.deepStrictEqual(
          detailed.usageByCollection!.map(collection => collection.id),
          [collectionId]
        )
        assert.ok(detailed.usageByCollection![0].usageBytes > 0)
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('reports near-limit / over-quota states against a configured capacity', async () => {
      // Measure actual usage first, then size a capacity to land in each band.
      const probe = await provision()
      const usageBytes = (
        await probe.backend.reportUsage({
          spaceId: probe.spaceId
        })
      ).usageBytes
      await rm(probe.tempDir, { recursive: true, force: true })

      // near-limit: usage is at/above 90% but below capacity.
      const near = await provision(Math.ceil(usageBytes / 0.95))
      try {
        const usage = await near.backend.reportUsage({ spaceId: near.spaceId })
        assert.equal(usage.state, 'near-limit')
        assert.equal(usage.limit.isUnlimited, false)
        assert.deepStrictEqual(usage.restrictedActions, [])
      } finally {
        await rm(near.tempDir, { recursive: true, force: true })
      }

      // over-quota: usage meets/exceeds capacity; writes become restricted.
      const over = await provision(Math.floor(usageBytes / 2))
      try {
        const usage = await over.backend.reportUsage({ spaceId: over.spaceId })
        assert.equal(usage.state, 'over-quota')
        assert.deepStrictEqual(usage.restrictedActions, ['POST', 'PUT'])
      } finally {
        await rm(over.tempDir, { recursive: true, force: true })
      }
    })
  })
})
