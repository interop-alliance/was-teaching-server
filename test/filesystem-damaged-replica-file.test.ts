/**
 * The filesystem backend's replica listings against a registration file that
 * does not read: one with no stamp or generation, or one whose JSON does not
 * parse. The listings log and skip it, so one damaged file takes down neither
 * Read Space, which lists the registrations, nor the start of every pull loop
 * on the server. The damaged registration's own read still fails on it, so a
 * create under its id cannot overwrite it.
 */
import { it, describe, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import { StorageError } from '../src/errors.js'
import { openTempBackend, type TempFileSystemBackend } from '../src/testing.js'
import { replicaRegistration } from './helpers.js'

const controller = 'did:key:z6MkDamagedReplicaFileController'
const spaceId = 'damaged-replica-space'

describe('FileSystemBackend replica listings and a damaged registration file', () => {
  let backend: TempFileSystemBackend
  let spaceDir: string

  beforeEach(async () => {
    backend = await openTempBackend({ prefix: 'was-damaged-replica-' })
    spaceDir = path.join(backend.dataDir, 'spaces', spaceId)
    await backend.writeSpace({
      spaceId,
      spaceMetadata: { id: spaceId, type: ['Space'], controller }
    })
    await backend.createReplica({
      spaceId,
      record: replicaRegistration({ id: 'sound', spaceId }),
      pullsChunks: false
    })
  })

  afterEach(async () => {
    await backend.close()
  })

  for (const [name, content] of [
    ['no stamp', JSON.stringify({ id: 'damaged', role: 'source' })],
    ['unparsable JSON', '{not json']
  ] as const) {
    it(`lists the sound registrations past one with ${name}`, async () => {
      await writeFile(path.join(spaceDir, '.replica.damaged.json'), content)
      assert.deepEqual(
        (await backend.listReplicas({ spaceId })).map(
          replica => replica.record.id
        ),
        ['sound']
      )
      assert.deepEqual(
        (await backend.listAllReplicas()).map(replica => replica.record.id),
        ['sound']
      )
      // The damaged registration's own read still fails on it.
      await assert.rejects(
        backend.getReplica({ spaceId, replicaId: 'damaged' }),
        (err: unknown) =>
          err instanceof StorageError || err instanceof SyntaxError
      )
    })
  }
})
