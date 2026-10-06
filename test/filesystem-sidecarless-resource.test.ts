/**
 * How the filesystem backend finds a Resource's representation file (Vitest).
 * Every write that leaves a live Resource or chunk records the basename of the
 * file it wrote as the sidecar's `fileName`, and a read opens exactly that
 * name. So a file no sidecar names is not a live Resource on any read path:
 * the backend reports no metadata, the read routes answer 404, and the changes
 * feed leaves it out. Every committed write leaves a sidecar, so such a file is
 * a write that never committed. A live sidecar that names a missing file is
 * damage, answered 500. The `fileName` is server-local: a tombstone has none,
 * export strips it, and import records the file it writes.
 */
import { it, describe, beforeAll, afterAll, afterEach } from 'vitest'
import assert from 'node:assert'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'

import { fileNameFor, metaSidecarFileName } from '@interop/space-archive'
import { isResourceChange } from '@interop/storage-core'

import { extractTarEntries } from '../src/lib/importTar.js'
import type { TempFileSystemBackend } from '../src/testing.js'
import {
  importArchive,
  openTempBackend,
  responseOf,
  startTestServer,
  zcapClients
} from './helpers.js'

describe('FileSystemBackend: Resource with no metadata sidecar', () => {
  const collectionId = 'bare'
  const bareId = 'no-sidecar'
  const bareBody = JSON.stringify({ n: bareId })
  let fastify: FastifyInstance,
    serverUrl: string,
    backend: TempFileSystemBackend,
    alice: any

  beforeAll(async () => {
    backend = await openTempBackend()
    ;({ fastify, serverUrl } = await startTestServer({ backend }))
    ;({ alice } = await zcapClients({ serverUrl }))

    const space = await alice.was.createSpace({
      id: alice.space1.id,
      name: "Alice's Space #1 (Home)",
      controller: alice.did
    })
    const collection = await space.createCollection({
      id: collectionId,
      name: collectionId
    })
    await collection.put('normal', { n: 'normal' })

    // The representation file alone, named as the backend names it, with no
    // `.meta.<id>.json` sidecar beside it.
    await writeFile(
      path.join(
        backend.spacesDir,
        alice.space1.id,
        collectionId,
        fileNameFor({ resourceId: bareId, contentType: 'application/json' })
      ),
      bareBody
    )
  })
  afterAll(async () => {
    await fastify.close()
  })

  function resourceUrl(resourceId: string): string {
    return new URL(
      `/space/${alice.space1.id}/${collectionId}/${resourceId}`,
      serverUrl
    ).toString()
  }

  it('reports no metadata from the backend', async () => {
    const metadata = await backend.getResourceMetadata({
      spaceId: alice.space1.id,
      collectionId,
      resourceId: bareId
    })
    assert.equal(metadata, undefined)
  })

  it('answers /meta with 404', async () => {
    const response = await responseOf(
      alice.was.request({ url: `${resourceUrl(bareId)}/meta`, method: 'GET' })
    )
    assert.equal(response.status, 404)
  })

  it('leaves the Resource out of the changes feed', async () => {
    const { data } = await alice.was.request({
      url: new URL(
        `/space/${alice.space1.id}/${collectionId}/query`,
        serverUrl
      ).toString(),
      method: 'POST',
      json: { profile: 'changes', limit: 10 }
    })
    assert.deepEqual(
      data.documents.filter(isResourceChange).map((doc: any) => doc.id),
      ['normal']
    )
  })

  it('answers a read of its bytes with 404', async () => {
    const response = await responseOf(
      alice.was.request({ url: resourceUrl(bareId), method: 'GET' })
    )
    assert.equal(response.status, 404)
  })

  it('answers 500 when a live sidecar names a missing file', async () => {
    const resourceId = 'renamed'
    await alice.was.request({
      url: resourceUrl(resourceId),
      method: 'PUT',
      json: { n: resourceId }
    })
    const sidecarPath = path.join(
      backend.spacesDir,
      alice.space1.id,
      collectionId,
      metaSidecarFileName(resourceId)
    )
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8'))
    // A name the backend could have written, for a file that is not there.
    await writeFile(
      sidecarPath,
      JSON.stringify({
        ...sidecar,
        fileName: fileNameFor({ resourceId, contentType: 'text/plain' })
      })
    )
    const response = await responseOf(
      alice.was.request({ url: resourceUrl(resourceId), method: 'GET' })
    )
    assert.equal(response.status, 500)
  })

  it('still serves a Resource written through the API', async () => {
    const response = await alice.was.request({
      url: resourceUrl('normal'),
      method: 'GET'
    })
    assert.equal(response.status, 200)
    assert.deepEqual(response.data, { n: 'normal' })
    assert.notEqual(response.headers.get('etag'), null)
  })
})

describe('FileSystemBackend: the sidecar names its representation file', () => {
  const spaceId = 'file-name-space'
  const collectionId = 'notes'
  const controller = 'did:key:z6MkFileNameTestController'
  const backends: TempFileSystemBackend[] = []

  afterEach(async () => {
    for (const opened of backends.splice(0)) {
      await opened.close()
    }
  })

  /**
   * A backend holding the test Space and Collection.
   * @returns {Promise<TempFileSystemBackend>}
   */
  async function provision(): Promise<TempFileSystemBackend> {
    const opened = await openTempBackend()
    backends.push(opened)
    await opened.writeSpace({
      spaceId,
      spaceMetadata: { id: spaceId, type: ['Space'], controller }
    })
    await opened.writeCollection({
      spaceId,
      collectionId,
      collectionMetadata: { id: collectionId, type: ['Collection'] }
    })
    return opened
  }

  /**
   * @param opened {TempFileSystemBackend}
   * @returns {string}
   */
  function collectionDirOf(opened: TempFileSystemBackend): string {
    return path.join(opened.spacesDir, spaceId, collectionId)
  }

  /**
   * The representation files on disk for one Resource.
   * @param opened {TempFileSystemBackend}
   * @param resourceId {string}
   * @returns {Promise<string[]>}
   */
  async function representationFiles(
    opened: TempFileSystemBackend,
    resourceId: string
  ): Promise<string[]> {
    return (await readdir(collectionDirOf(opened))).filter(name =>
      name.startsWith(`r.${resourceId}.`)
    )
  }

  /**
   * @param options {object}
   * @param options.opened {TempFileSystemBackend}
   * @param options.resourceId {string}
   * @param options.contentType {string}
   * @param options.body {string}
   * @returns {Promise<void>}
   */
  async function writeText({
    opened,
    resourceId,
    contentType,
    body
  }: {
    opened: TempFileSystemBackend
    resourceId: string
    contentType: string
    body: string
  }): Promise<void> {
    await opened.writeResource({
      spaceId,
      collectionId,
      resourceId,
      input: {
        kind: 'binary',
        contentType,
        declaredBytes: Buffer.byteLength(body),
        stream: Readable.from([Buffer.from(body)])
      }
    })
  }

  it('a content write records the file it wrote', async () => {
    const opened = await provision()
    await writeText({
      opened,
      resourceId: 'doc',
      contentType: 'text/plain',
      body: 'one'
    })
    const sidecar = await opened.readMetaSidecar({
      collectionDir: collectionDirOf(opened),
      resourceId: 'doc'
    })
    assert.deepEqual(await representationFiles(opened, 'doc'), [
      sidecar?.fileName
    ])
  })

  it('a content-type change records the new file and removes the old one', async () => {
    const opened = await provision()
    await writeText({
      opened,
      resourceId: 'doc',
      contentType: 'text/plain',
      body: 'one'
    })
    const before = await opened.readMetaSidecar({
      collectionDir: collectionDirOf(opened),
      resourceId: 'doc'
    })
    await writeText({
      opened,
      resourceId: 'doc',
      contentType: 'text/markdown',
      body: '# two'
    })
    const after = await opened.readMetaSidecar({
      collectionDir: collectionDirOf(opened),
      resourceId: 'doc'
    })
    assert.notEqual(after?.fileName, before?.fileName)
    assert.equal(after?.contentType, 'text/markdown')
    assert.deepEqual(await representationFiles(opened, 'doc'), [
      after?.fileName
    ])
  })

  it('a tombstone keeps its content-type and names no file', async () => {
    const opened = await provision()
    await writeText({
      opened,
      resourceId: 'doc',
      contentType: 'text/plain',
      body: 'one'
    })
    await opened.deleteResource({ spaceId, collectionId, resourceId: 'doc' })
    const tombstone = await opened.readMetaSidecar({
      collectionDir: collectionDirOf(opened),
      resourceId: 'doc'
    })
    assert.equal(tombstone?.deleted, true)
    assert.equal(tombstone?.contentType, 'text/plain')
    assert.equal('fileName' in tombstone!, false)
    assert.deepEqual(await representationFiles(opened, 'doc'), [])
  })

  it('export strips fileName and import records the file it writes', async () => {
    const source = await provision()
    await writeText({
      opened: source,
      resourceId: 'doc',
      contentType: 'text/plain',
      body: 'one'
    })
    await source.writeChunk({
      spaceId,
      collectionId,
      resourceId: 'doc',
      chunkIndex: 0,
      input: {
        kind: 'binary',
        contentType: 'application/octet-stream',
        declaredBytes: 3,
        stream: Readable.from([Buffer.from('abc')])
      }
    })
    const archive = await extractTarEntries(
      await source.exportSpace({ spaceId })
    )
    const sidecarEntries = [...archive].filter(([name]) =>
      path.basename(name).startsWith('.meta.')
    )
    // The Resource's sidecar and its chunk's.
    assert.equal(sidecarEntries.length, 2)
    for (const [name, entry] of sidecarEntries) {
      const archived = JSON.parse(entry.body?.toString('utf8') ?? '')
      assert.equal('fileName' in archived, false, `${name} carries fileName`)
      assert.equal('feedPosition' in archived, false)
    }

    const destination = await openTempBackend({ prefix: 'was-test-dst-' })
    backends.push(destination)
    await destination.writeSpace({
      spaceId,
      spaceMetadata: { id: spaceId, type: ['Space'], controller }
    })
    await importArchive({
      backend: destination,
      spaceId,
      tarStream: await source.exportSpace({ spaceId })
    })
    const imported = await destination.readMetaSidecar({
      collectionDir: collectionDirOf(destination),
      resourceId: 'doc'
    })
    assert.deepEqual(await representationFiles(destination, 'doc'), [
      imported?.fileName
    ])
    const chunk = await destination.getChunk({
      spaceId,
      collectionId,
      resourceId: 'doc',
      chunkIndex: 0
    })
    chunk.resourceStream.resume()
    assert.equal(chunk.storedResourceType, 'application/octet-stream')
  })
})
