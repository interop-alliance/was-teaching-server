/**
 * The counterpart test for the per-Space archive codec, which now lives in
 * `@interop/space-archive` and is shared by this server and any wallet reading
 * a backup. The package checks in a fixture archive
 * (`test/fixtures/space-archive/space-archive.tar`) packed by its own writer
 * from a small fixed entry tree; this suite stages that same tree in a
 * `FileSystemBackend`'s on-disk layout, runs the server's real `exportSpace`
 * path over it, and asserts the bytes are identical. So the two parties to the
 * dialect -- the package's writer and this server's entry-tree construction
 * (its directory walk, sort order, chunk-directory handling and the sibling
 * revocations directory) -- are pinned to one byte sequence.
 *
 * Why the tree is staged on disk rather than imported through `importSpace`:
 * `.collection.notes.json` and `.space.zFixtureSpace.json` carry no
 * `_generation` / `_version` members. An import mints those validators and
 * re-stamps `updatedAt`, so an imported Collection's Metadata object could
 * never re-export to the fixture's bytes, and its revocation record is a stub
 * the import path refuses. The fixture's governing history log is the server's
 * own stored record (`{ body, generation, version }`); the last case here pins
 * that form from the other side, packing the same tree with a bare JSON Lines
 * log and asserting the import refuses it.
 *
 * The Postgres backend gets no arm here: its entry tree is built out of rows
 * written through its own API, which stamps the same validators, so the
 * fixture tree cannot be staged there verbatim either -- and the Postgres
 * suites need a live database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { fileNameFor, packSpaceArchive } from '@interop/space-archive'
import { FileSystemBackend } from '../src/backends/filesystem.js'

const SPACE_ID = 'zFixtureSpace'
const COLLECTION_ID = 'notes'
// Dotted on purpose: the fixture exercises the file-name codec's dot-escaping.
const RESOURCE_ID = 'note.1'

/**
 * The checked-in fixture archive's bytes. The package publishes only `dist`,
 * so the fixture is reached by resolving the package entry point through the
 * `link:` dependency and walking up out of `dist/`.
 * @returns {Buffer}
 */
function readFixtureArchive(): Buffer {
  const packageDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.resolve('@interop/space-archive'))),
    '..'
  )
  return fs.readFileSync(
    path.join(packageDir, 'test/fixtures/space-archive/space-archive.tar')
  )
}

/**
 * Writes the fixture's entry tree into a `FileSystemBackend`'s layout: the
 * Space directory with its Metadata dot-file, one Collection directory holding
 * its Metadata, its governing history log, a Resource representation and that
 * Resource's metadata sidecar, and one record in the sibling per-Space
 * revocations directory.
 * @param dataDir {string}
 * @returns {void}
 */
function stageFixtureTree(dataDir: string): void {
  const spaceDir = path.join(dataDir, 'spaces', SPACE_ID)
  const collectionDir = path.join(spaceDir, COLLECTION_ID)
  fs.mkdirSync(collectionDir, { recursive: true })

  fs.writeFileSync(
    path.join(spaceDir, `.space.${SPACE_ID}.json`),
    JSON.stringify({
      id: SPACE_ID,
      controller: 'did:key:z6MkfixtureController',
      type: ['Space']
    })
  )
  fs.writeFileSync(
    path.join(collectionDir, `.collection.${COLLECTION_ID}.json`),
    JSON.stringify({
      id: COLLECTION_ID,
      createdAt: '1970-01-01T00:00:00.000Z',
      updatedAt: '1970-01-01T00:00:00.000Z'
    })
  )
  fs.writeFileSync(
    path.join(collectionDir, `.collectionlog.${COLLECTION_ID}.json`),
    JSON.stringify({
      generation: 'zFixtureLogGeneration',
      version: 1,
      body: `${JSON.stringify({
        state: { type: 'WasEpochConfiguration', scheme: 'edv' }
      })}\n`
    })
  )
  fs.writeFileSync(
    path.join(collectionDir, `.meta.${RESOURCE_ID}.json`),
    JSON.stringify({ custom: { title: 'A note' } })
  )
  fs.writeFileSync(
    path.join(
      collectionDir,
      fileNameFor({
        resourceId: RESOURCE_ID,
        contentType: 'application/json'
      })
    ),
    JSON.stringify({ note: 'hello' })
  )

  const revocationsDir = path.join(dataDir, 'space-revocations', SPACE_ID)
  fs.mkdirSync(revocationsDir, { recursive: true })
  fs.writeFileSync(
    path.join(revocationsDir, 'urn%3Auuid%3Afixture-revocation.json'),
    JSON.stringify({ id: 'urn:uuid:fixture-revocation' })
  )
}

/**
 * Drains a Space export (a Node `Readable`, or the tar-stream pack the
 * package's writer resolves, wrapped the way the backends wrap it) into its
 * bytes.
 * @param source {Readable | Iterable<unknown> | AsyncIterable<unknown>}
 * @returns {Promise<Buffer>}
 */
async function collect(
  source: Readable | Iterable<unknown> | AsyncIterable<unknown>
): Promise<Buffer> {
  const stream = source instanceof Readable ? source : Readable.from(source)
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer))
  }
  return Buffer.concat(chunks)
}

describe('Space archive fixture (@interop/space-archive counterpart)', () => {
  let dataDir: string
  let backend: FileSystemBackend
  const fixture = readFixtureArchive()

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'was-archive-fixture-'))
    backend = new FileSystemBackend({ dataDir })
    stageFixtureTree(dataDir)
  })

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it("exports bytes identical to the package's fixture archive", async () => {
    const exported = await collect(
      await backend.exportSpace({ spaceId: SPACE_ID })
    )
    expect(exported.equals(fixture)).toBe(true)
  })

  it('refuses an archive whose history log is unwrapped', async () => {
    // The same tree the fixture carries, with the Collection log written as
    // the bare JSON Lines body instead of the stored record. Packed through
    // the package's own writer, so the refusal is measured against a
    // well-formed archive that differs in exactly that one entry.
    const unwrapped = await collect(
      await packSpaceArchive({
        spaceId: SPACE_ID,
        entries: [
          {
            name: `.space.${SPACE_ID}.json`,
            bytes: Buffer.from(
              JSON.stringify({
                id: SPACE_ID,
                controller: 'did:key:z6MkfixtureController',
                type: ['Space']
              })
            )
          },
          {
            name: COLLECTION_ID,
            files: [
              {
                name: `.collection.${COLLECTION_ID}.json`,
                bytes: Buffer.from(JSON.stringify({ id: COLLECTION_ID }))
              },
              {
                name: `.collectionlog.${COLLECTION_ID}.json`,
                bytes: Buffer.from(
                  `${JSON.stringify({
                    state: { type: 'WasEpochConfiguration', scheme: 'edv' }
                  })}\n`
                )
              }
            ]
          }
        ]
      })
    )
    const importDataDir = await mkdtemp(
      path.join(os.tmpdir(), 'was-archive-import-')
    )
    const importBackend = new FileSystemBackend({ dataDir: importDataDir })
    try {
      await importBackend.writeSpace({
        spaceId: SPACE_ID,
        spaceMetadata: {
          id: SPACE_ID,
          controller: 'did:key:z6MkfixtureController',
          type: ['Space']
        }
      })
      await expect(
        importBackend.importSpace({
          spaceId: SPACE_ID,
          tarStream: Readable.from(unwrapped)
        })
      ).rejects.toThrow(/history log of Collection 'notes'/)
    } finally {
      await rm(importDataDir, { recursive: true, force: true })
    }
  })
})
