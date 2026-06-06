/**
 * WAS conformance tests — high-level WasClient: Delegation
 * Using Node.js test runner
 * @see https://nodejs.org/api/test.html
 *
 * Exercises the client's grant / `fromCapability` round-trip against a live
 * server: Alice delegates access to Bob, who rebuilds a handle from the signed
 * capability and reads (but cannot write beyond the grant).
 */
import { it, describe, before, after } from 'node:test'
import assert from 'node:assert'

import { Space, Resource } from '@interop/was-client'

import { buildZcapClients } from './helpers.js'

describe('WasClient — Delegation', () => {
  let alice: any, bob: any
  const createdSpaces: Space[] = []

  before(async () => {
    ;({ alice, bob } = await buildZcapClients())
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
    const space = await alice.was.createSpace({ name })
    createdSpaces.push(space)
    return space
  }

  it('bob cannot see an alice space without a grant', async () => {
    const space = await newSpace('Private')
    const seenByBob = await bob.was.space(space.id).describe()
    assert.equal(seenByBob, null)
  })

  it('grants read on a space; recipient reads via fromCapability', async () => {
    const space = await newSpace('Shared Space')
    const zcap = await space.grant({ to: bob.did, actions: ['GET'] })

    const handle = bob.was.fromCapability(zcap)
    assert.ok(handle instanceof Space)
    const description = await handle.describe()
    assert.equal(description?.name, 'Shared Space')
  })

  it('grants read on a resource; recipient reads but cannot write', async () => {
    const space = await newSpace('Doc Space')
    const collection = await space.createCollection({ id: 'docs' })
    const added = await collection.add({ secret: 'value' })

    // Lowercase action input is normalized to uppercase in the signed zcap,
    // so it still validates against the server (which expects 'GET').
    const zcap = await alice.was.grant({
      to: bob.did,
      actions: ['get'],
      target: added.url
    })
    assert.deepStrictEqual(zcap.allowedAction, ['GET'])

    const handle = bob.was.fromCapability(zcap)
    assert.ok(handle instanceof Resource)
    assert.equal(((await handle.get()) as any).secret, 'value')

    // The grant is read-only; a write must be denied.
    await assert.rejects(handle.put({ secret: 'tampered' }))
  })
})
