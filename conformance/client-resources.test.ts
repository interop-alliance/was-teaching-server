/**
 * WAS conformance tests — high-level WasClient: Resources (JSON + binary)
 * Using Node.js test runner
 * @see https://nodejs.org/api/test.html
 *
 * Drives the published `@interop/was-client` against a live server, covering the
 * client's JSON-vs-binary handling and the null-on-404 read semantics end to
 * end.
 */
import { it, describe, before, after } from 'node:test'
import assert from 'node:assert'

import type { Collection, Space } from '@interop/was-client'

import { buildZcapClients } from './helpers.js'

describe('WasClient — Resources', () => {
  let alice: any
  let space: Space
  let jsonCollection: Collection
  let binaryCollection: Collection

  before(async () => {
    ;({ alice } = await buildZcapClients())
    space = await alice.was.createSpace({ name: 'Resources Space' })
    jsonCollection = await space.createCollection({ id: 'docs', name: 'Docs' })
    binaryCollection = await space.createCollection({
      id: 'files',
      name: 'Files'
    })
  })

  after(async () => {
    try {
      await space.delete()
    } catch {
      /* best-effort cleanup */
    }
  })

  describe('JSON resources', () => {
    it('adds a JSON resource (server-generated id) and gets it back', async () => {
      const result = await jsonCollection.add({ name: 'Sample', value: 42 })
      assert.ok(result.id)
      assert.ok(result.url.includes(`/${result.id}`))
      assert.match(result.contentType!, /json/)

      const fetched = (await jsonCollection.get(result.id)) as any
      assert.equal(fetched.name, 'Sample')
      assert.equal(fetched.value, 42)
    })

    it('puts a JSON resource by id (upsert) and lists items', async () => {
      await jsonCollection.put('greeting', { message: 'hello' })
      assert.equal(
        ((await jsonCollection.get('greeting')) as any).message,
        'hello'
      )

      await jsonCollection.put('greeting', { message: 'updated' })
      assert.equal(
        ((await jsonCollection.get('greeting')) as any).message,
        'updated'
      )

      const listing = await jsonCollection.list()
      assert.ok(listing)
      assert.ok(listing.items.some(item => item.id === 'greeting'))
    })

    it('returns null getting a missing resource (404 conflation)', async () => {
      assert.equal(await jsonCollection.get('no-such-resource'), null)
    })

    it('deletes a resource via its handle', async () => {
      await jsonCollection.put('temp', { tmp: true })
      assert.notEqual(await jsonCollection.get('temp'), null)
      await jsonCollection.resource('temp').delete()
      assert.equal(await jsonCollection.get('temp'), null)
    })
  })

  describe('binary resources', () => {
    it('puts and reads Uint8Array bytes via getBytes/getText', async () => {
      const bytes = new TextEncoder().encode('line 1\nline 2\n')
      await binaryCollection.put('note.txt', bytes, {
        contentType: 'text/plain'
      })

      const handle = binaryCollection.resource('note.txt')
      assert.equal(await handle.getText(), 'line 1\nline 2\n')
      assert.deepStrictEqual(await handle.getBytes(), bytes)
    })

    it('add() returns a Blob from get() for non-JSON content', async () => {
      const blob = new Blob(['hello blob'], { type: 'text/plain' })
      const result = await binaryCollection.add(blob)
      const fetched = await binaryCollection.get(result.id)
      assert.ok(fetched instanceof Blob)
      assert.equal(await fetched.text(), 'hello blob')
    })

    it('getText/getBytes return null for a missing resource', async () => {
      const handle = binaryCollection.resource('absent')
      assert.equal(await handle.getText(), null)
      assert.equal(await handle.getBytes(), null)
    })
  })
})
