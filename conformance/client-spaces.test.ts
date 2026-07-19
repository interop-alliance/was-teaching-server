/**
 * WAS conformance tests — high-level WasClient: Spaces & Collections
 * Using Node.js test runner
 * @see https://nodejs.org/api/test.html
 *
 * Drives the published `@interop/was-client` against a live server over the
 * HTTP contract, rather than the low-level `ZcapClient` used by the `*-api`
 * suites. This is where the client's own integration coverage lives, so the
 * client repo can stay free of any dependency on this server.
 */
import { it, describe, before, after } from 'node:test'
import assert from 'node:assert'

import { NotFoundError } from '@interop/was-client'
import type { Space } from '@interop/was-client'

import {
  buildZcapClients,
  provisionSpace,
  withoutCreatedBy
} from './helpers.js'

describe('WasClient — Spaces & Collections', () => {
  let alice: any
  const createdSpaces: Space[] = []

  before(async () => {
    ;({ alice } = await buildZcapClients())
  })

  after(async () => {
    for (const space of createdSpaces) {
      try {
        await space.delete()
      } catch {
        /* best-effort cleanup */
      }
    }
  })

  /**
   * Creates a space via the high-level client and registers it for teardown.
   *
   * @param name {string}
   * @returns {Promise<Space>}
   */
  async function newSpace(name: string): Promise<Space> {
    const space = await provisionSpace({ was: alice.was, name })
    createdSpaces.push(space)
    return space
  }

  describe('spaces', () => {
    it('creates a space and reads it back', async () => {
      const space = await newSpace('Home')
      const description = await space.describe()
      assert.deepStrictEqual(withoutCreatedBy(description), {
        id: space.id,
        type: ['Space'],
        name: 'Home',
        controller: alice.did,
        url: `/space/${space.id}`,
        linkset: `/space/${space.id}/linkset`
      })
    })

    it('returns null when describing a missing space (404 conflation)', async () => {
      const missing = await alice.was.space('no-such-space').describe()
      assert.equal(missing, null)
    })

    it('deletes a space and is idempotent', async () => {
      const space = await newSpace('Disposable')
      await space.delete()
      assert.equal(await space.describe(), null)
      // Deleting again must not throw.
      await space.delete()
    })

    it('configures (updates) an existing space', async () => {
      const space = await newSpace('Original')
      const updated = await space.configure({ name: 'Renamed' })
      assert.equal(updated.name, 'Renamed')
      const reread = await space.describe()
      assert.equal(reread?.name, 'Renamed')
    })

    it('listSpaces includes a created space', async () => {
      // A persistent external server may hold other spaces for Alice from
      // earlier runs, so assert containment rather than exact contents.
      const space = await newSpace('Listed Space')
      const listing = await alice.was.listSpaces()
      assert.equal(listing.url, '/spaces/')
      assert.equal(listing.totalItems, listing.items.length)
      assert.deepStrictEqual(
        listing.items.find((item: { id: string }) => item.id === space.id),
        { id: space.id, name: 'Listed Space', url: `/space/${space.id}` }
      )
    })
  })

  describe('collections', () => {
    let space: Space

    before(async () => {
      space = await newSpace('Collections Space')
    })

    it('creates a collection by id and reads its description', async () => {
      const collection = await space.createCollection({
        id: 'credentials',
        name: 'Verifiable Credentials'
      })
      assert.equal(collection.id, 'credentials')
      assert.deepStrictEqual(withoutCreatedBy(await collection.describe()), {
        id: 'credentials',
        type: ['Collection'],
        name: 'Verifiable Credentials',
        backend: { id: 'default' },
        url: `/space/${space.id}/credentials`,
        linkset: `/space/${space.id}/credentials/linkset`
      })
    })

    it('lists collections in a space', async () => {
      const listing = await space.collections()
      assert.ok(listing)
      assert.ok(listing.totalItems >= 1)
      assert.ok(listing.items.some(item => item.id === 'credentials'))
    })

    it('throws NotFoundError adding to a collection in a missing space', async () => {
      const orphan = alice.was.space('missing-space').collection('c')
      await assert.rejects(
        orphan.add({ hello: 'world' }),
        (err: unknown) => err instanceof NotFoundError
      )
    })
  })

  describe('backend & quota', () => {
    let space: Space

    before(async () => {
      space = await newSpace('Backend & Quota Space')
    })

    it('reads the backend a collection is stored on', async () => {
      const collection = await space.createCollection({ id: 'backend-probe' })
      const backend = await collection.backend()
      assert.ok(backend)
      // The display name is server-specific (e.g. 'Server Filesystem' or
      // 'Server PostgreSQL'); the suite runs against any conforming server.
      const { name, ...rest } = backend
      assert.ok(typeof name === 'string' && name.length > 0)
      assert.deepStrictEqual(rest, {
        id: 'default',
        managedBy: 'server',
        storageMode: ['document', 'blob'],
        persistence: 'durable',
        features: [
          'conditional-writes',
          'changes-query',
          'blinded-index-query',
          'key-epochs',
          'chunked-streams'
        ]
      })
    })

    it('returns null reading the backend of a missing collection (404 conflation)', async () => {
      const missing = space.collection('no-such-collection')
      assert.equal(await missing.backend(), null)
    })

    it("reads a collection's storage quota, scoped to its backend", async () => {
      const collection = await space.createCollection({ id: 'quota-probe' })
      await collection.add({ hello: 'world' })
      const usage = await collection.quota()
      assert.ok(usage)
      assert.equal(usage.id, 'default')
      assert.equal(usage.managedBy, 'server')
      assert.equal(usage.state, 'ok')
      assert.ok(usage.usageBytes > 0, 'expected non-zero collection usage')
      // The default filesystem backend has no configured capacity (unlimited).
      assert.deepStrictEqual(usage.limit, { isUnlimited: true })
      assert.deepStrictEqual(usage.restrictedActions, [])
      assert.match(usage.measuredAt, /^\d{4}-\d{2}-\d{2}T/)
      // The per-collection report is the whole report -- no nested breakdown.
      assert.equal(usage.usageByCollection, undefined)
    })

    it('returns null reading the quota of a missing collection (404 conflation)', async () => {
      const missing = space.collection('no-such-collection')
      assert.equal(await missing.quota(), null)
    })
  })

  describe('space backends & quotas', () => {
    let space: Space

    before(async () => {
      space = await newSpace('Backends & Quotas Space')
      const collection = await space.createCollection({ id: 'docs' })
      await collection.add({ hello: 'world' })
    })

    it('lists the storage backends available in the space', async () => {
      const backends = await space.backends()
      assert.ok(backends)
      assert.equal(backends.length, 1)
      // The display name is server-specific (e.g. 'Server Filesystem' or
      // 'Server PostgreSQL'); the suite runs against any conforming server.
      const { name, ...rest } = backends[0]!
      assert.ok(typeof name === 'string' && name.length > 0)
      assert.deepStrictEqual(rest, {
        id: 'default',
        managedBy: 'server',
        storageMode: ['document', 'blob'],
        persistence: 'durable',
        features: [
          'conditional-writes',
          'changes-query',
          'blinded-index-query',
          'key-epochs',
          'chunked-streams'
        ]
      })
    })

    it('returns null listing backends of a missing space (404 conflation)', async () => {
      assert.equal(await alice.was.space('no-such-space').backends(), null)
    })

    it('reads the space storage quota report, grouped by backend', async () => {
      const report = await space.quotas()
      assert.ok(report)
      assert.match(report.respondedAt, /^\d{4}-\d{2}-\d{2}T/)
      assert.equal(report.backends.length, 1)
      const entry = report.backends[0]
      assert.ok(entry)
      assert.equal(entry.id, 'default')
      // Server-specific display name; just require one.
      assert.ok(typeof entry.name === 'string' && entry.name.length > 0)
      assert.equal(entry.managedBy, 'server')
      assert.equal(entry.state, 'ok')
      assert.ok(entry.usageBytes > 0, 'expected non-zero usage')
      // The default filesystem backend has no configured capacity (unlimited).
      assert.deepStrictEqual(entry.limit, { isUnlimited: true })
      assert.deepStrictEqual(entry.restrictedActions, [])
      assert.match(entry.measuredAt, /^\d{4}-\d{2}-\d{2}T/)
      // The per-Collection breakdown is opt-in (spec `?include=collections`), so
      // a bare report omits it.
      assert.equal(entry.usageByCollection, undefined)
    })

    it('reads the per-collection breakdown with includeCollections', async () => {
      const report = await space.quotas({ includeCollections: true })
      assert.ok(report)
      const entry = report.backends[0]
      assert.ok(entry)
      // With the opt-in, the space-level report carries a per-collection breakdown.
      const breakdown = entry.usageByCollection
      assert.ok(breakdown, 'expected a usageByCollection breakdown')
      assert.ok(
        breakdown.some(item => item.id === 'docs'),
        'expected the docs collection in the breakdown'
      )
    })

    it('returns null reading quotas of a missing space (404 conflation)', async () => {
      assert.equal(await alice.was.space('no-such-space').quotas(), null)
    })
  })
})
