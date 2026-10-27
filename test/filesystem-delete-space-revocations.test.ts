/**
 * The filesystem backend's Delete Space against its Space-scoped zcap
 * revocations, which live beside the Space tree rather than under it. Delete
 * Space removes the Space dir first and the revocation dir after it, so a
 * process killed between the two leaves either the Space whole, revocations
 * and all, or a revocation dir with no Space, which the next delete of the id
 * and the next boot remove. The cut is made with real syscalls: the Space dir
 * is made unwritable, so its removal fails before the revocations are
 * touched. That cut does not hold for root, whom the permission bits do not
 * refuse, so the case is skipped under uid 0 (a root container's CI).
 */
import { it, describe, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { FileSystemBackend } from '../src/backends/filesystem.js'

const controller = 'did:key:z6MkDeleteSpaceRevocationsController'
const spaceId = 'revoked-space'
const summary = {
  capabilityId: 'urn:uuid:delete-space-test-capability',
  delegator: controller
}

async function revoke({
  backend,
  spaceId,
  capabilityId
}: {
  backend: FileSystemBackend
  spaceId: string
  capabilityId: string
}): Promise<void> {
  await backend.insertRevocation({
    scope: { spaceId },
    record: {
      capability: { id: capabilityId },
      meta: {
        delegator: controller,
        rootTarget: `https://example.test/space/${spaceId}/`,
        created: new Date().toISOString()
      }
    }
  })
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
    revocationDir = path.join(dataDir, 'space-revocations', spaceId)
    await backend.writeSpace({
      spaceId,
      spaceMetadata: { id: spaceId, type: ['Space'], controller }
    })
    await revoke({ backend, spaceId, capabilityId: summary.capabilityId })
    assert.equal((await readdir(revocationDir)).length, 1)
  })

  afterEach(async () => {
    await backend.close()
    await chmod(spaceDir, 0o755).catch(() => undefined)
    await rm(dataDir, { recursive: true, force: true })
  })

  it.skipIf(process.getuid?.() === 0)(
    'a delete cut short at the Space dir leaves the Space whole, its revocations included',
    async () => {
      // An unwritable Space dir fails the first removal, as a kill between the
      // two would.
      await chmod(spaceDir, 0o555)
      await assert.rejects(
        backend.deleteSpace({ spaceId }),
        (err: unknown) => (err as NodeJS.ErrnoException).code === 'EACCES'
      )
      assert.ok(await backend.getSpaceMetadata({ spaceId }))
      assert.equal(
        await backend.isRevoked({
          scope: { spaceId },
          capabilities: [summary]
        }),
        true
      )
      await chmod(spaceDir, 0o755)
      await backend.deleteSpace({ spaceId })
      assert.deepEqual(await readdir(path.join(dataDir, 'spaces')), [])
      assert.deepEqual(
        await readdir(path.join(dataDir, 'space-revocations')),
        []
      )
    }
  )

  it('a retried delete removes the revocations a cut-short delete left without a Space', async () => {
    // The state a kill after the Space dir's removal leaves.
    await rm(spaceDir, { recursive: true })
    await backend.deleteSpace({ spaceId })
    assert.deepEqual(await readdir(path.join(dataDir, 'space-revocations')), [])
  })

  it('a Space re-created under the id does not inherit the revocations a cut-short delete left', async () => {
    await rm(spaceDir, { recursive: true })
    await backend.writeSpace({
      spaceId,
      spaceMetadata: { id: spaceId, type: ['Space'], controller }
    })
    assert.equal(
      await backend.isRevoked({ scope: { spaceId }, capabilities: [summary] }),
      false
    )
  })

  it('boot removes the revocations of a Space dir a torn delete left with no Metadata file', async () => {
    // A kill mid-rm: the Metadata file is gone, a Collection dir survives.
    await rm(path.join(spaceDir, `.space.${spaceId}.json`))
    await mkdir(path.join(spaceDir, 'leftover'))
    await backend.close()
    backend = await FileSystemBackend.open({ dataDir })
    assert.deepEqual(await readdir(path.join(dataDir, 'space-revocations')), [])
  })

  it('boot removes the revocations of a Space that is gone, and keeps those of one that stands', async () => {
    const otherId = 'standing-space'
    await backend.writeSpace({
      spaceId: otherId,
      spaceMetadata: { id: otherId, type: ['Space'], controller }
    })
    await revoke({
      backend,
      spaceId: otherId,
      capabilityId: 'urn:uuid:other-capability'
    })
    // A stray file at the revocation root is no Space's dir and is left alone.
    await writeFile(path.join(dataDir, 'space-revocations', 'note'), 'x')
    await rm(spaceDir, { recursive: true })
    await backend.close()
    backend = await FileSystemBackend.open({ dataDir })
    assert.deepEqual(
      (await readdir(path.join(dataDir, 'space-revocations'))).sort(),
      ['note', otherId]
    )
    assert.equal(
      await backend.isRevoked({
        scope: { spaceId: otherId },
        capabilities: [
          { capabilityId: 'urn:uuid:other-capability', delegator: controller }
        ]
      }),
      true
    )
  })

  it('an empty revocation root and a missing one are no error at boot', async () => {
    await backend.close()
    await rm(path.join(dataDir, 'space-revocations'), { recursive: true })
    backend = await FileSystemBackend.open({ dataDir })
    await mkdir(path.join(dataDir, 'space-revocations'))
    await backend.close()
    backend = await FileSystemBackend.open({ dataDir })
  })
})
