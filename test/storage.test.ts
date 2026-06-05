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
})
