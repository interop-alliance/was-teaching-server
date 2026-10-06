/**
 * Delete Chunk removes the chunk's sidecar before its file (Vitest, backend
 * level, no server). The sidecar is the record that a chunk stands, so a read
 * that runs between the two removals must find the sidecar gone and answer
 * 404, never a live sidecar naming a missing file (a 500). The window is too
 * narrow to race, so the read is run from inside the first `rm` the delete
 * makes.
 */
import { it, describe, beforeEach, afterEach, vi } from 'vitest'
import assert from 'node:assert'

// Runs once, right after the next `rm` completes. Set by a test.
const hook = vi.hoisted(() => ({
  afterRemove: undefined as (() => Promise<void>) | undefined
}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    default: actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      await actual.rm(...args)
      const afterRemove = hook.afterRemove
      hook.afterRemove = undefined
      await afterRemove?.()
    }
  }
})

const { ResourceNotFoundError } = await import('../src/errors.js')
const { openTempBackend } = await import('./helpers.js')

const controller = 'did:key:z6MkChunkDeleteOrderTestController'
const spaceId = 'chunk-delete-order-space'
const collectionId = 'docs'

describe('FileSystemBackend: Delete Chunk removes the sidecar first', () => {
  let backend: Awaited<ReturnType<typeof openTempBackend>>

  beforeEach(async () => {
    backend = await openTempBackend()
    await backend.writeSpace({
      spaceId,
      spaceMetadata: { id: spaceId, type: ['Space'], controller }
    })
    await backend.writeCollection({
      spaceId,
      collectionId,
      collectionMetadata: { id: collectionId, type: ['Collection'] }
    })
    await backend.writeResource({
      spaceId,
      collectionId,
      resourceId: 'parent',
      input: { kind: 'json', contentType: 'application/json', data: {} }
    })
    await backend.writeChunk({
      spaceId,
      collectionId,
      resourceId: 'parent',
      chunkIndex: 0,
      input: { kind: 'json', contentType: 'application/json', data: {} }
    })
  })

  afterEach(async () => {
    hook.afterRemove = undefined
    await backend.close()
  })

  it('a read between the two removals finds the chunk absent', async () => {
    let outcome: unknown
    hook.afterRemove = async () => {
      outcome = await backend
        .getChunk({
          spaceId,
          collectionId,
          resourceId: 'parent',
          chunkIndex: 0
        })
        .then(
          () => 'found',
          (err: unknown) => err
        )
    }
    assert.equal(
      await backend.deleteChunk({
        spaceId,
        collectionId,
        resourceId: 'parent',
        chunkIndex: 0
      }),
      true
    )
    assert.ok(
      outcome instanceof ResourceNotFoundError,
      `expected a 404, got ${String(outcome)}`
    )
  })
})
