/**
 * Unit tests for the access-control policy core (`src/policy.ts`,
 * `src/authorize.ts`): an info line when a policy grants
 * public access, and a warn when an unrecognized policy type is fail-closed.
 * These run against lightweight mocks (a recording logger and a stub storage),
 * with no HTTP round-trip; the `policy-api` suite covers end-to-end behavior.
 */
import { it, describe } from 'vitest'
import assert from 'node:assert'
import type { FastifyBaseLogger, FastifyRequest } from 'fastify'

import { policyGrants } from '../src/policy.js'
import { authorize } from '../src/authorize.js'
import { UnauthorizedError } from '../src/errors.js'
import type { IDID, PolicyDocument, StorageBackend } from '../src/types.js'

/** A logger that records its `info` / `warn` calls for assertion. */
function recordingLogger() {
  const calls = {
    info: [] as Array<{ obj: unknown; msg?: string }>,
    warn: [] as Array<{ obj: unknown; msg?: string }>
  }
  const logger = {
    info: (obj: unknown, msg?: string) => calls.info.push({ obj, msg }),
    warn: (obj: unknown, msg?: string) => calls.warn.push({ obj, msg })
  } as unknown as FastifyBaseLogger
  return { logger, calls }
}

/** A storage stub whose `getPolicy` resolves the given (fixed) policy. */
function stubStorage(policy?: PolicyDocument): StorageBackend {
  return { getPolicy: async () => policy } as unknown as StorageBackend
}

/** Builds an anonymous (no auth headers) GET request to a resource target. */
function anonRequest({
  storage,
  logger
}: {
  storage: StorageBackend
  logger: FastifyBaseLogger
}): FastifyRequest {
  return {
    url: '/space/s1/c1/r1',
    method: 'GET',
    headers: {},
    log: logger,
    server: { serverUrl: 'http://localhost', storage }
  } as unknown as FastifyRequest
}

describe('policyGrants', () => {
  it('PublicCanRead grants read but not write', () => {
    const policy: PolicyDocument = { type: 'PublicCanRead' }
    assert.equal(policyGrants({ policy, action: 'read' }), true)
    assert.equal(policyGrants({ policy, action: 'write' }), false)
  })

  it('an absent policy grants nothing', () => {
    assert.equal(policyGrants({ action: 'read' }), false)
  })

  it('an unrecognized type grants nothing and warns (fail-closed)', () => {
    const { logger, calls } = recordingLogger()
    const granted = policyGrants({
      policy: { type: 'SomethingUnsupported' },
      action: 'read',
      logger
    })
    assert.equal(granted, false)
    assert.equal(calls.warn.length, 1)
    assert.match(calls.warn[0]!.msg!, /Unrecognized access-control policy type/)
    assert.deepEqual(calls.warn[0]!.obj, { policyType: 'SomethingUnsupported' })
  })

  it('does not require a logger for the fail-closed path', () => {
    assert.equal(
      policyGrants({
        policy: { type: 'SomethingUnsupported' },
        action: 'read'
      }),
      false
    )
  })
})

describe('authorize', () => {
  const controller = 'did:key:zAlice' as IDID

  it('logs an info line when a policy grants the read', async () => {
    const { logger, calls } = recordingLogger()
    const request = anonRequest({
      storage: stubStorage({ type: 'PublicCanRead' }),
      logger
    })
    await authorize({
      request,
      allowedTarget: 'http://localhost/space/s1/c1/r1',
      spaceId: 's1',
      collectionId: 'c1',
      resourceId: 'r1',
      spaceController: controller,
      requestName: 'Get Resource'
    })
    assert.equal(calls.info.length, 1)
    assert.match(calls.info[0]!.msg!, /granted by access-control policy/i)
    assert.deepEqual(calls.info[0]!.obj, {
      spaceId: 's1',
      collectionId: 'c1',
      resourceId: 'r1',
      action: 'read',
      policyType: 'PublicCanRead'
    })
  })

  it('throws (and logs no grant) when no policy authorizes', async () => {
    const { logger, calls } = recordingLogger()
    const request = anonRequest({ storage: stubStorage(undefined), logger })
    await assert.rejects(
      authorize({
        request,
        allowedTarget: 'http://localhost/space/s1/c1/r1',
        spaceId: 's1',
        collectionId: 'c1',
        resourceId: 'r1',
        spaceController: controller,
        requestName: 'Get Resource'
      }),
      UnauthorizedError
    )
    assert.equal(calls.info.length, 0)
  })
})
