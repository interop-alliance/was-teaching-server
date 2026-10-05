/**
 * Unit tests for the Import Space revocation gate's cheap skips
 * (`installImportRevocations`): the records it drops before any chain
 * verification, and what it logs about them. The verified paths run against
 * a server in `test/export-import-api.test.ts` and in the storage contract
 * suite.
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'
import type { FastifyBaseLogger } from 'fastify'
import { installImportRevocations } from '../src/lib/importRevocations.js'
import type { IDID, StorageBackend } from '../src/types.js'

/**
 * A storage stub that refuses every write, and a logger that records its
 * `warn` calls.
 */
function harness() {
  const warnings: unknown[] = []
  const storage = {
    insertRevocation: async () => {
      assert.fail('nothing may be stored')
    }
  } as unknown as StorageBackend
  const logger = {
    warn: (...args: unknown[]) => {
      warnings.push(args)
    }
  } as unknown as FastifyBaseLogger
  const scope = {
    spaceId: 'S1',
    rootTarget: 'https://was.example/space/S1/',
    rootController: 'did:key:z6MkController' as IDID,
    webvh: { storage, serverUrl: 'https://was.example' },
    invocation: { rootInvocation: true }
  }
  return { warnings, storage, logger, scope }
}

describe('installImportRevocations', () => {
  it('skips an expired capability silently, without verifying it', async () => {
    const { warnings, storage, logger, scope } = harness()
    const result = await installImportRevocations({
      capabilities: [
        {
          id: 'urn:zcap:expired',
          expires: new Date(Date.now() - 60_000).toISOString()
        }
      ],
      scope,
      storage,
      logger
    })
    assert.deepEqual(result, { installed: 0, skipped: 1 })
    assert.deepEqual(warnings, [])
  })

  it('skips a root capability id with one warn line', async () => {
    const { warnings, storage, logger, scope } = harness()
    const result = await installImportRevocations({
      capabilities: [
        { id: `urn:zcap:root:${encodeURIComponent(scope.rootTarget)}` }
      ],
      scope,
      storage,
      logger
    })
    assert.deepEqual(result, { installed: 0, skipped: 1 })
    assert.equal(warnings.length, 1)
  })

  it('skips a capability it cannot read as a chain with one warn line, not a failure', async () => {
    const { warnings, storage, logger, scope } = harness()
    const result = await installImportRevocations({
      capabilities: [
        {
          id: 'urn:zcap:odd',
          parentCapability: 7,
          proof: { capabilityChain: 'not-an-array' }
        }
      ],
      scope,
      storage,
      logger
    })
    assert.deepEqual(result, { installed: 0, skipped: 1 })
    assert.equal(warnings.length, 1)
  })
})
