/**
 * WAS conformance tests — high-level WasClient: Export / Import
 * Using Node.js test runner
 * @see https://nodejs.org/api/test.html
 *
 * Exercises the client's whole-space tar export and import against a live
 * server: export a populated space, then import the archive into a fresh one.
 */
import { it, describe, before, after } from 'node:test'
import assert from 'node:assert'

import type { Space } from '@interop/was-client'

import { buildZcapClients, provisionSpace, serverUrl } from './helpers.js'

describe('WasClient — Export / Import', () => {
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
   * Creates a space owned by Alice and registers it for teardown.
   *
   * @param name {string}
   * @returns {Promise<Space>}
   */
  async function newSpace(name: string): Promise<Space> {
    const space = await provisionSpace({ was: alice.was, name })
    createdSpaces.push(space)
    return space
  }

  it('exports a space to a tar archive and imports it into another', async () => {
    const source = await newSpace('Export Source')
    const collection = await source.createCollection({
      id: 'notes',
      name: 'Notes'
    })
    await collection.put('first', { body: 'one' })
    await collection.put('second', { body: 'two' })
    // Make the collection world-readable so we can verify the policy survives
    // the export/import round-trip.
    await alice.was.request({
      path: `/space/${source.id}/notes/policy`,
      method: 'PUT',
      json: { type: 'PublicCanRead' }
    })

    const archive = await source.export()
    assert.ok(archive instanceof Uint8Array)
    assert.ok(archive.byteLength > 0)

    const target = await newSpace('Import Target')
    const stats = await target.import(archive)
    assert.ok(stats.collectionsCreated >= 1)
    assert.ok(stats.resourcesCreated >= 2)
    assert.ok(stats.policiesCreated >= 1)

    const imported = (await target.collection('notes').get('first')) as any
    assert.equal(imported.body, 'one')

    // The PublicCanRead policy round-tripped: an anonymous GET of the imported
    // resource in the target space succeeds.
    const anonResponse = await fetch(
      new URL(`/space/${target.id}/notes/first`, serverUrl)
    )
    assert.equal(anonResponse.status, 200)
    const anonBody = (await anonResponse.json()) as { body: string }
    assert.equal(anonBody.body, 'one')
  })
})
