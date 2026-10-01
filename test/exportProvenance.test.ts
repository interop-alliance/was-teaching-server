/**
 * Unit tests for `attestArchiveEntries` (`src/lib/exportProvenance.ts`) over
 * a hand-built entry tree: an object whose file is gone by the time it is
 * digested (deleted after the backend built the tree) gets no statement and
 * the export goes on, while any other read fault still fails it.
 */
import { it, describe, beforeAll } from 'vitest'
import assert from 'node:assert'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import {
  chunkDirName,
  collectionMetadataFileName,
  fileNameFor,
  metaSidecarFileName
} from '@interop/space-archive'
import type { ArchiveEntry, ArchiveFile } from '@interop/space-archive'

import { attestArchiveEntries } from '../src/lib/exportProvenance.js'
import type { ExportAttestor } from '../src/lib/exportProvenance.js'

const serverUrl = 'https://was.example'
const spaceId = 'space-1'
const collectionId = 'notes'

function present(name: string, text: string): ArchiveFile {
  return { name, read: async () => Buffer.from(text) }
}

function failing(name: string, code: string): ArchiveFile {
  return {
    name,
    read: async () => {
      throw Object.assign(new Error(`${code}: ${name}`), { code })
    }
  }
}

function representation(resourceId: string): string {
  return fileNameFor({ resourceId, contentType: 'text/plain' })
}

function statementIds(body: string): string[] {
  return body
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line).id)
}

describe('attestArchiveEntries', () => {
  let attestor: ExportAttestor

  beforeAll(async () => {
    const serverDid = 'did:webvh:scid:was.example:space:server:id'
    const generated = await Ed25519VerificationKey.generate()
    attestor = {
      serverUrl,
      serverDid,
      didLog: new Uint8Array(),
      didLogVersionId: '1-abc',
      keyPair: new Ed25519VerificationKey({
        id: `${serverDid}#${generated.publicKeyMultibase}`,
        controller: serverDid,
        publicKeyMultibase: generated.publicKeyMultibase,
        privateKeyMultibase: generated.privateKeyMultibase
      })
    }
  })

  it('skips an object whose file or chunk is gone, and attests the rest', async () => {
    const entries: ArchiveEntry[] = [
      {
        name: collectionId,
        files: [
          failing(collectionMetadataFileName(collectionId), 'ENOENT'),
          present(representation('kept'), 'hello'),
          present(metaSidecarFileName('kept'), '{"version":3}'),
          failing(representation('deleted'), 'ENOENT'),
          present(metaSidecarFileName('deleted'), '{"version":2}'),
          present(representation('chunked'), ''),
          {
            name: chunkDirName('chunked'),
            files: [
              present(representation('0'), 'first'),
              failing(representation('1'), 'ENOENT')
            ]
          }
        ]
      }
    ]
    const body = await attestArchiveEntries({ spaceId, entries, attestor })
    assert.deepEqual(statementIds(body), [
      `${serverUrl}/space/${spaceId}/${collectionId}/kept`
    ])
    assert.equal(JSON.parse(body).version, 3)
  })

  it('attests a Resource whose sidecar is gone, without its members', async () => {
    const entries: ArchiveEntry[] = [
      {
        name: collectionId,
        files: [
          present(representation('kept'), 'hello'),
          failing(metaSidecarFileName('kept'), 'ENOENT')
        ]
      }
    ]
    const statement = JSON.parse(
      await attestArchiveEntries({ spaceId, entries, attestor })
    )
    assert.equal(
      statement.id,
      `${serverUrl}/space/${spaceId}/${collectionId}/kept`
    )
    assert.equal(statement.version, undefined)
    assert.match(statement.digest, /^mh=/)
  })

  it('fails on a read fault other than a missing file', async () => {
    const entries: ArchiveEntry[] = [
      {
        name: collectionId,
        files: [failing(representation('locked'), 'EACCES')]
      }
    ]
    await assert.rejects(attestArchiveEntries({ spaceId, entries, attestor }), {
      code: 'EACCES'
    })
  })
})
