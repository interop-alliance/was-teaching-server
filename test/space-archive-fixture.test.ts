/**
 * The counterpart test for the per-Space archive codec, which now lives in
 * `@interop/space-archive` and is shared by this server and any wallet reading
 * a backup. The package publishes a fixture archive
 * (`@interop/space-archive/fixtures/space-archive.tar`) packed by its own
 * writer from a small fixed entry tree; this suite stages that same tree in a
 * `FileSystemBackend`'s on-disk layout, runs the server's real `exportSpace`
 * path over it, and asserts the bytes are identical. So the two parties to the
 * dialect -- the package's writer and this server's entry-tree construction
 * (its directory walk, sort order, chunk-directory handling and the sibling
 * revocations directory) -- are pinned to one byte sequence.
 *
 * The tree has the layout this server writes and exports. The two Metadata
 * files, the governing history log record and the Resource sidecar each carry
 * a write stamp (`updatedAt`, `updatedAtCounter`, `originId`), all the epoch
 * with counter 0 under the origin id `zFixtureOrigin`. The sidecar also
 * carries its `/meta` record's stamp and generation under `meta`. A Metadata
 * file embeds its generation as `_generation`; the log record and the sidecar
 * carry theirs as `generation`.
 *
 * Why the tree is staged on disk rather than imported through `importSpace`:
 * an import re-stamps every record with the importing server's clock, so an
 * imported record could never re-export to the fixture's bytes, and the
 * fixture's revocation record is a stub the import path refuses. The
 * fixture's governing history log is a stored log record
 * (`{ generation, updatedAt, updatedAtCounter, originId, body }`); the last
 * case here pins that form from the other side, packing the same tree with a
 * bare JSON Lines log and asserting the import refuses it.
 *
 * A second fixture carries the two provenance root entries beside the
 * manifest (`provenance.jsonl`, `did.jsonl`). The package packs their bodies
 * verbatim; this server wrote them, by exporting the same tree at
 * `https://was.example` with the export-signing key derived from the all-`0x01`
 * seed. The case below stages the fixture's own `did.jsonl` as this server's
 * history log, derives the key from the same seed, and asserts the export is
 * byte-identical to that fixture, statements and all. Ed25519 signatures are
 * deterministic and the proofs carry no `created`, so the signing is
 * reproducible.
 *
 * The Postgres backend gets no arm here: its entry tree is built out of rows
 * written through its own API, which stamps the same validators, so the
 * fixture tree cannot be staged there verbatim either -- and the Postgres
 * suites need a live database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import assert from 'node:assert'
import { pino } from 'pino'
import {
  fileNameFor,
  packSpaceArchive,
  readSpaceArchive
} from '@interop/space-archive'
import type { TempFileSystemBackend } from '../src/testing.js'
import { loadExportAttestor } from '../src/lib/exportProvenance.js'
import {
  createServerSigningKey,
  SERVER_IDENTITY_COLLECTION_ID,
  SERVER_SPACE_ID
} from '../src/lib/serverIdentity.js'
import {
  importArchive,
  openTempBackend,
  verifyProvenanceOffline
} from './helpers.js'

const SPACE_ID = 'zFixtureSpace'
const COLLECTION_ID = 'notes'
// Dotted on purpose: the fixture exercises the file-name codec's dot-escaping.
const RESOURCE_ID = 'note.1'

/**
 * The fixture archive's bytes. The package publishes the fixture as a subpath
 * export, so this reads the bytes of the version this server depends on rather
 * than a checkout it would have to find on disk.
 * @returns {Buffer}
 */
function readFixtureArchive(): Buffer {
  return fs.readFileSync(
    fileURLToPath(
      import.meta.resolve('@interop/space-archive/fixtures/space-archive.tar')
    )
  )
}

/**
 * The provenance fixture archive's bytes: the same tree, plus the
 * `provenance.jsonl` and `did.jsonl` root entries.
 * @returns {Buffer}
 */
function readProvenanceFixtureArchive(): Buffer {
  return fs.readFileSync(
    fileURLToPath(
      import.meta
        .resolve('@interop/space-archive/fixtures/space-archive-provenance.tar')
    )
  )
}

/**
 * The base URL and export-signing key seed the provenance fixture was
 * written under.
 */
const PROVENANCE_FIXTURE_SERVER_URL = 'https://was.example'
const PROVENANCE_FIXTURE_SEED = new Uint8Array(32).fill(1)

/**
 * The write stamp every stamped record in the fixture carries.
 */
const FIXTURE_STAMP = {
  updatedAt: '1970-01-01T00:00:00.000Z',
  updatedAtCounter: 0,
  originId: 'zFixtureOrigin'
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
    // Stored without `backends`: the export derives that listing and writes
    // it after the stamp members.
    JSON.stringify({
      id: SPACE_ID,
      controller: 'did:key:z6MkfixtureController',
      type: ['Space'],
      ...FIXTURE_STAMP,
      _generation: 'zFixtureSpaceGeneration'
    })
  )
  fs.writeFileSync(
    path.join(collectionDir, `.collection.${COLLECTION_ID}.json`),
    JSON.stringify({
      id: COLLECTION_ID,
      createdAt: '1970-01-01T00:00:00.000Z',
      ...FIXTURE_STAMP,
      _generation: 'zFixtureNotesGeneration'
    })
  )
  fs.writeFileSync(
    path.join(collectionDir, `.collectionlog.${COLLECTION_ID}.json`),
    JSON.stringify({
      generation: 'zFixtureLogGeneration',
      ...FIXTURE_STAMP,
      body: `${JSON.stringify({
        state: { type: 'WasEpochConfiguration', scheme: 'edv' }
      })}\n`
    })
  )
  fs.writeFileSync(
    path.join(collectionDir, `.meta.${RESOURCE_ID}.json`),
    JSON.stringify({
      createdAt: '1970-01-01T00:00:00.000Z',
      ...FIXTURE_STAMP,
      generation: 'zFixtureNoteGeneration',
      meta: { ...FIXTURE_STAMP, generation: 'zFixtureNoteMetaGeneration' },
      custom: { title: 'A note' }
    })
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
  let backend: TempFileSystemBackend
  const fixture = readFixtureArchive()

  beforeAll(async () => {
    backend = await openTempBackend({ prefix: 'was-archive-fixture-' })
    stageFixtureTree(backend.dataDir)
  })

  afterAll(async () => {
    await backend.close()
  })

  it("exports bytes identical to the package's fixture archive", async () => {
    const exported = await collect(
      await backend.exportSpace({ spaceId: SPACE_ID })
    )
    expect(exported.equals(fixture)).toBe(true)
  })

  it("exports bytes identical to the package's provenance fixture archive", async () => {
    const provenanceFixture = readProvenanceFixtureArchive()
    const { didLog } = await readSpaceArchive(provenanceFixture)
    assert.ok(didLog, 'the provenance fixture carries a did.jsonl')
    await backend.writeSpace({
      spaceId: SERVER_SPACE_ID,
      spaceMetadata: {
        id: SERVER_SPACE_ID,
        type: ['AuxiliarySpace', 'ServerInstanceSpace', 'Space'],
        controller: 'did:key:z6MkfixtureAdmin'
      }
    })
    await backend.writeCollection({
      spaceId: SERVER_SPACE_ID,
      collectionId: SERVER_IDENTITY_COLLECTION_ID,
      collectionMetadata: {
        id: SERVER_IDENTITY_COLLECTION_ID,
        type: ['Collection']
      }
    })
    await backend.writeResource({
      spaceId: SERVER_SPACE_ID,
      collectionId: SERVER_IDENTITY_COLLECTION_ID,
      resourceId: 'did.jsonl',
      input: {
        kind: 'binary',
        contentType: 'text/jsonl',
        stream: Readable.from([Buffer.from(didLog)])
      }
    })
    const loaded = await loadExportAttestor({
      storage: backend,
      serverUrl: PROVENANCE_FIXTURE_SERVER_URL,
      signingKey: await createServerSigningKey({
        seed: PROVENANCE_FIXTURE_SEED
      }),
      logger: pino({ level: 'silent' })
    })
    assert.ok('attestor' in loaded, 'the fixture log lists the seed key')
    const exported = await collect(
      await backend.exportSpace({
        spaceId: SPACE_ID,
        attestor: loaded.attestor
      })
    )
    expect(exported.equals(provenanceFixture)).toBe(true)
    const archive = await readSpaceArchive(provenanceFixture)
    await archive.close()
    const { statements } = await verifyProvenanceOffline({
      provenance: archive.provenance!,
      didLog: archive.didLog!
    })
    expect(statements).toHaveLength(3)
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
    const importBackend = await openTempBackend({
      prefix: 'was-archive-import-'
    })
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
        importArchive({
          backend: importBackend,
          spaceId: SPACE_ID,
          tarStream: Readable.from(unwrapped)
        })
      ).rejects.toThrow(/history log of Collection 'notes'/)
    } finally {
      await importBackend.close()
    }
  })
})
