/**
 * Quotas API unit tests (Vitest). Exercises the Space Quota report endpoint
 * (`GET /space/:spaceId/quotas`) end-to-end against an in-process server: the
 * default (unlimited) report with its per-Collection breakdown, and the
 * maximum-privacy 404 for an unauthorized caller.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { startTestServer, zcapClients } from './helpers.js'

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

interface BackendUsageBody {
  id: string
  name: string
  managedBy: string
  state: string
  usageBytes: number
  limit: { capacityBytes?: number; isUnlimited: boolean }
  restrictedActions: string[]
  measuredAt: string
  usageByCollection?: Array<{ id: string; usageBytes: number }>
}
interface QuotaReportBody {
  respondedAt: string
  backends: BackendUsageBody[]
}

describe('Quotas API', () => {
  let fastify: FastifyInstance, serverUrl: string, dataDir: string
  let alice: any, bob: any
  const spaceId = `quotas-space-${crypto.randomUUID()}`
  const collectionId = 'credentials'

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice, bob } = await zcapClients({ serverUrl }))

    // Provision a Space + Collection with one Resource so usage is non-zero.
    const space = await alice.was.createSpace({
      id: spaceId,
      name: 'Quotas Test Space',
      controller: alice.did
    })
    const collection = await space.createCollection({
      id: collectionId,
      name: 'Credentials'
    })
    await collection.put('vc-1', {
      id: 'vc-1',
      name: 'A Verifiable Credential'
    })
  })

  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('[root] reports the Space quota grouped by backend', async () => {
    const response = await alice.was.request({
      path: `/space/${spaceId}/quotas`,
      method: 'GET'
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type')!, /application\/json/)

    // The http-client auto-parses a JSON body into `response.data`.
    const report = response.data as QuotaReportBody
    assert.match(report.respondedAt, ISO_8601)
    assert.equal(report.backends.length, 1)

    const [entry] = report.backends
    assert.ok(entry)
    assert.equal(entry.id, 'default')
    assert.equal(entry.name, 'Server Filesystem')
    assert.equal(entry.managedBy, 'server')
    assert.equal(entry.state, 'ok')
    assert.ok(entry.usageBytes > 0, 'expected non-zero usage')
    // The default filesystem backend has no configured capacity (unlimited).
    assert.deepStrictEqual(entry.limit, { isUnlimited: true })
    assert.deepStrictEqual(entry.restrictedActions, [])
    assert.match(entry.measuredAt, ISO_8601)

    // The per-Collection breakdown is opt-in (spec `?include=collections`), so a
    // bare report omits it. See the `?include=collections` test below.
    assert.equal(entry.usageByCollection, undefined)
  })

  it('[root] ?include=collections returns the per-Collection breakdown', async () => {
    // A query string on a capability-signed request: the `allowTargetQuery` ZCap
    // path authorizes it against the bare `/quotas` target (the query selects a
    // representation, not a different target).
    const response = await alice.was.request({
      path: `/space/${spaceId}/quotas?include=collections`,
      method: 'GET'
    })
    assert.equal(response.status, 200)

    const report = response.data as QuotaReportBody
    const [entry] = report.backends
    assert.ok(entry)
    assert.ok(entry.usageByCollection, 'expected usageByCollection')
    const credentials = entry.usageByCollection!.find(
      collection => collection.id === collectionId
    )
    assert.ok(
      credentials,
      'expected the credentials collection in the breakdown'
    )
    assert.ok(credentials!.usageBytes > 0, 'expected non-zero collection usage')
    // The per-Collection totals never exceed the backend total.
    const summed = entry.usageByCollection!.reduce(
      (total, collection) => total + collection.usageBytes,
      0
    )
    assert.ok(summed <= entry.usageBytes)
  })

  it('an unauthorized caller gets 404 (maximum-privacy), not 403', async () => {
    // Bob is not the Space controller and there is no public-read policy, so his
    // capability does not authorize the read: the report 404s like any other.
    let thrown: any
    try {
      await bob.was.request({
        path: `/space/${spaceId}/quotas`,
        method: 'GET'
      })
    } catch (err) {
      thrown = err
    }
    assert.ok(thrown, 'expected an unauthorized quota read to be rejected')
    assert.equal(thrown.response.status, 404)
  })

  describe('Per-Collection quota', () => {
    it('[root] reports a single Collection scoped to its backend', async () => {
      const response = await alice.was.request({
        path: `/space/${spaceId}/${collectionId}/quota`,
        method: 'GET'
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type')!, /application\/json/)

      const entry = response.data as BackendUsageBody
      assert.equal(entry.id, 'default')
      assert.equal(entry.name, 'Server Filesystem')
      assert.equal(entry.managedBy, 'server')
      assert.equal(entry.state, 'ok')
      assert.ok(entry.usageBytes > 0, 'expected non-zero collection usage')
      assert.deepStrictEqual(entry.limit, { isUnlimited: true })
      assert.deepStrictEqual(entry.restrictedActions, [])
      assert.match(entry.measuredAt, ISO_8601)
      // A single-Collection report carries no per-Collection breakdown.
      assert.equal(entry.usageByCollection, undefined)
    })

    it('an unauthorized caller gets 404 (maximum-privacy), not 403', async () => {
      let thrown: any
      try {
        await bob.was.request({
          path: `/space/${spaceId}/${collectionId}/quota`,
          method: 'GET'
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected an unauthorized read to be rejected')
      assert.equal(thrown.response.status, 404)
    })

    it('a missing Collection yields 404', async () => {
      let thrown: any
      try {
        await alice.was.request({
          path: `/space/${spaceId}/no-such-collection/quota`,
          method: 'GET'
        })
      } catch (err) {
        thrown = err
      }
      assert.ok(thrown, 'expected a 404 for the missing collection')
      assert.equal(thrown.response.status, 404)
    })
  })
})
