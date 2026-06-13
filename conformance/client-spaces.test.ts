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

import { buildZcapClients } from './helpers.js'

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
    const space = await alice.was.createSpace({ name })
    createdSpaces.push(space)
    return space
  }

  describe('spaces', () => {
    it('creates a space and reads it back', async () => {
      const space = await newSpace('Home')
      const description = await space.describe()
      assert.deepStrictEqual(description, {
        id: space.id,
        type: ['Space'],
        name: 'Home',
        controller: alice.did,
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
        listing.items.find(item => item.id === space.id),
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
      assert.deepStrictEqual(await collection.describe(), {
        id: 'credentials',
        type: ['Collection'],
        name: 'Verifiable Credentials',
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
})
