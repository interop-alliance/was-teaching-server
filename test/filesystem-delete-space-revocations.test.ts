/**
 * The filesystem backend's Space-scoped zcap revocations, which live in the
 * `.revocations/` subdirectory of the Space dir. Delete Space is the one
 * removal of the Space dir, which takes the revocations with it, and the
 * subdirectory is no Collection: the Collection listing and the Space export
 * leave it out, while its bytes count toward the Space's usage.
 */
import { it, describe, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ARCHIVE_REVOCATIONS_DIR,
  spaceMetadataFileName
} from '@interop/space-archive'

import { FileSystemBackend } from '../src/backends/filesystem.js'

const controller = 'did:key:z6MkDeleteSpaceRevocationsController'
const spaceId = 'revoked-space'
const summary = {
  capabilityId: 'urn:uuid:delete-space-test-capability',
  delegator: controller
}

describe('FileSystemBackend Delete Space and the Space revocations', () => {
  let dataDir: string
  let backend: FileSystemBackend
  let spaceDir: string
  let revocationDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-delete-space-'))
    backend = await FileSystemBackend.open({ dataDir })
    spaceDir = path.join(dataDir, 'spaces', spaceId)
    revocationDir = path.join(spaceDir, ARCHIVE_REVOCATIONS_DIR)
    await backend.writeSpace({
      spaceId,
      spaceMetadata: { id: spaceId, type: ['Space'], controller }
    })
    await backend.insertRevocation({
      scope: { spaceId },
      record: {
        capability: { id: summary.capabilityId },
        meta: {
          delegator: controller,
          rootTarget: `https://example.test/space/${spaceId}/`,
          created: new Date().toISOString()
        }
      }
    })
    assert.equal((await readdir(revocationDir)).length, 1)
  })

  afterEach(async () => {
    await backend.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('stores the revocations under the Space dir and finds them there', async () => {
    assert.equal(path.basename(revocationDir), '.revocations')
    assert.equal(
      await backend.isRevoked({ scope: { spaceId }, capabilities: [summary] }),
      true
    )
  })

  it('removes the Space and its revocations in one step', async () => {
    await backend.deleteSpace({ spaceId })
    assert.deepEqual(await readdir(path.join(dataDir, 'spaces')), [])
    await assert.rejects(stat(revocationDir), { code: 'ENOENT' })
    assert.equal(
      await backend.isRevoked({ scope: { spaceId }, capabilities: [summary] }),
      false
    )
  })

  it('a Space re-created under the id starts with no revocations', async () => {
    await backend.deleteSpace({ spaceId })
    await backend.writeSpace({
      spaceId,
      spaceMetadata: { id: spaceId, type: ['Space'], controller }
    })
    assert.equal(
      await backend.isRevoked({ scope: { spaceId }, capabilities: [summary] }),
      false
    )
  })

  it('a Space re-created over a torn delete inherits none of the old life', async () => {
    // A kill mid-rm: the Metadata file is gone, the revocation dir and a
    // Collection dir survive.
    await rm(path.join(spaceDir, spaceMetadataFileName(spaceId)))
    await mkdir(path.join(spaceDir, 'leftover'))
    assert.equal(await backend.getSpaceMetadata({ spaceId }), undefined)
    const { created } = await backend.writeSpace({
      spaceId,
      spaceMetadata: { id: spaceId, type: ['Space'], controller }
    })
    assert.equal(created, true)
    assert.equal(
      await backend.isRevoked({ scope: { spaceId }, capabilities: [summary] }),
      false
    )
    await assert.rejects(stat(path.join(spaceDir, 'leftover')), {
      code: 'ENOENT'
    })
    assert.deepEqual(
      (await backend.listCollections({ spaceId })).items.map(item => item.id),
      []
    )
  })

  it('a repeat delete removes what a torn delete left without a Metadata file', async () => {
    await rm(path.join(spaceDir, spaceMetadataFileName(spaceId)))
    await backend.deleteSpace({ spaceId })
    assert.deepEqual(await readdir(path.join(dataDir, 'spaces')), [])
  })

  it('a Space at capacity still accepts a revocation', async () => {
    const fullDir = await mkdtemp(path.join(tmpdir(), 'was-full-space-'))
    const full = await FileSystemBackend.open({
      dataDir: fullDir,
      capacityBytes: 1
    })
    try {
      await full.writeSpace({
        spaceId,
        spaceMetadata: { id: spaceId, type: ['Space'], controller }
      })
      await full.insertRevocation({
        scope: { spaceId },
        record: {
          capability: { id: summary.capabilityId },
          meta: {
            delegator: controller,
            rootTarget: `https://example.test/space/${spaceId}/`,
            created: new Date().toISOString()
          }
        }
      })
      assert.equal(
        await full.isRevoked({ scope: { spaceId }, capabilities: [summary] }),
        true
      )
    } finally {
      await full.close()
      await rm(fullDir, { recursive: true, force: true })
    }
  })

  it('the revocation dir is no Collection', async () => {
    await backend.writeCollection({
      spaceId,
      collectionId: 'notes',
      collectionMetadata: { id: 'notes', type: ['Collection'] }
    })
    const listing = await backend.listCollections({ spaceId })
    assert.deepEqual(
      listing.items.map(item => item.id),
      ['notes']
    )
    assert.equal(listing.totalItems, 1)
  })

  it('the revocation records count toward the quota, under no Collection', async () => {
    const before = (await backend.reportUsage({ spaceId })).usageBytes
    await backend.insertRevocation({
      scope: { spaceId },
      record: {
        capability: { id: 'urn:uuid:second-capability' },
        meta: {
          delegator: controller,
          rootTarget: `https://example.test/space/${spaceId}/`,
          created: new Date().toISOString()
        }
      }
    })
    const after = await backend.reportUsage({
      spaceId,
      includeCollections: true
    })
    assert.ok(after.usageBytes > before)
    assert.deepEqual(after.usageByCollection, [])
  })
})
