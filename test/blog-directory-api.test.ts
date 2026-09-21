/**
 * The opt-in blog directory (`/directory/blogs`, src/blogDirectory.ts): the
 * public listing, the signed add / remove, and the checks a write passes
 * through -- the blog must answer a public read, and the request must be
 * signed by the `signingKey` that blog publishes.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { Space } from '@interop/was-client'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { requestError, startTestServer, zcapClients } from './helpers.js'

describe('Blog Directory API', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    directoryFile: string,
    directoryUrl: string,
    alice: any,
    bob: any,
    aliceSpace: Space,
    aliceBlogUrl: string,
    bobBlogUrl: string

  /**
   * Lists the directory anonymously, following `next` links.
   * @param [query] {string}   a query string for the first page
   * @returns {Promise<{ blogUrl: string, addedAt: string }[]>}
   */
  async function listAll(query = ''): Promise<any[]> {
    const items: any[] = []
    let next: string | undefined = `/directory/blogs${query}`
    while (next !== undefined) {
      const response = await fetch(new URL(next, serverUrl))
      assert.equal(response.status, 200)
      const body = (await response.json()) as { items: any[]; next?: string }
      items.push(...body.items)
      next = body.next
    }
    return items
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    directoryFile = path.join(dataDir, 'blog-directory.json')
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir }),
      blogDirectory: { file: directoryFile }
    }))
    ;({ alice, bob } = await zcapClients({ serverUrl }))
    directoryUrl = `${serverUrl}/directory/blogs`

    // Each author publishes a blog document in a public `blogs` Collection,
    // naming their own key as its `signingKey` (what the blog app does).
    aliceSpace = await alice.was.createSpace({
      id: alice.space1.id,
      controller: alice.did
    })
    const aliceBlogs = await aliceSpace.createCollection({ id: 'blogs' })
    await aliceBlogs.setPublic()
    aliceBlogUrl = `${serverUrl}/space/${alice.space1.id}/blogs/blog`
    await aliceBlogs.put('blog', {
      id: 'blog',
      type: 'Blog',
      name: "Alice's Blog",
      url: aliceBlogUrl,
      signingKey: alice.did
    })

    const bobSpace = await bob.was.createSpace({
      id: bob.space2.id,
      controller: bob.did
    })
    const bobBlogs = await bobSpace.createCollection({ id: 'blogs' })
    await bobBlogs.setPublic()
    bobBlogUrl = `${serverUrl}/space/${bob.space2.id}/blogs/blog`
    await bobBlogs.put('blog', {
      id: 'blog',
      type: 'Blog',
      name: "Bob's Blog",
      url: bobBlogUrl,
      signingKey: bob.did
    })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('an empty directory lists no items', async () => {
    assert.deepEqual(await listAll(), [])
  })

  it('a blog lists itself, signed by its own signingKey', async () => {
    const response = await alice.was.request({
      url: directoryUrl,
      method: 'POST',
      json: { blogUrl: aliceBlogUrl }
    })
    assert.equal(response.status, 204)

    const items = await listAll()
    assert.deepEqual(
      items.map(item => item.blogUrl),
      [aliceBlogUrl]
    )
    assert.ok(!Number.isNaN(Date.parse(items[0].addedAt)))

    // Persisted to the configured file.
    const stored = JSON.parse(await readFile(directoryFile, 'utf8'))
    assert.ok(stored[aliceBlogUrl])
  })

  it('listing an already-listed blog is harmless and keeps its addedAt', async () => {
    const [before] = await listAll()
    await alice.was.request({
      url: directoryUrl,
      method: 'POST',
      json: { blogUrl: aliceBlogUrl }
    })
    assert.deepEqual(await listAll(), [before])
  })

  it('someone else cannot list a blog (masked 404)', async () => {
    const err = await requestError(
      bob.was.request({
        url: directoryUrl,
        method: 'POST',
        json: { blogUrl: aliceBlogUrl }
      })
    )
    assert.equal(err.status, 404)
  })

  it('someone else cannot unlist a blog (masked 404)', async () => {
    const err = await requestError(
      bob.was.request({
        url: directoryUrl,
        method: 'DELETE',
        json: { blogUrl: aliceBlogUrl }
      })
    )
    assert.equal(err.status, 404)
    assert.equal((await listAll()).length, 1)
  })

  it('an unsigned write is refused with 401', async () => {
    const response = await fetch(directoryUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blogUrl: bobBlogUrl })
    })
    assert.equal(response.status, 401)
  })

  it('a blog on another server is refused with 400', async () => {
    const err = await requestError(
      alice.was.request({
        url: directoryUrl,
        method: 'POST',
        json: { blogUrl: 'https://elsewhere.example/space/s/blogs/blog' }
      })
    )
    assert.equal(err.status, 400)
  })

  it('a document that does not answer a public read is refused with 400', async () => {
    const privateCollection = await aliceSpace.createCollection({
      id: 'private-blogs'
    })
    const privateUrl = `${serverUrl}/space/${alice.space1.id}/private-blogs/blog`
    await privateCollection.put('blog', {
      id: 'blog',
      type: 'Blog',
      url: privateUrl,
      signingKey: alice.did
    })
    const err = await requestError(
      alice.was.request({
        url: directoryUrl,
        method: 'POST',
        json: { blogUrl: privateUrl }
      })
    )
    assert.equal(err.status, 400)
  })

  it('a public document that is not a blog is refused with 400', async () => {
    const notes = await aliceSpace.createCollection({ id: 'notes' })
    await notes.setPublic()
    await notes.put('note', { id: 'note', type: 'Note' })
    const err = await requestError(
      alice.was.request({
        url: directoryUrl,
        method: 'POST',
        json: { blogUrl: `${serverUrl}/space/${alice.space1.id}/notes/note` }
      })
    )
    assert.equal(err.status, 400)
  })

  it('pages through the listing with limit and next', async () => {
    await bob.was.request({
      url: directoryUrl,
      method: 'POST',
      json: { blogUrl: bobBlogUrl }
    })
    const first = (await (
      await fetch(new URL('/directory/blogs?limit=1', serverUrl))
    ).json()) as { items: any[]; next?: string }
    assert.equal(first.items.length, 1)
    assert.match(first.next ?? '', /^\/directory\/blogs\?limit=1&cursor=/)

    const all = await listAll('?limit=1')
    assert.deepEqual(
      all.map(item => item.blogUrl).sort(),
      [aliceBlogUrl, bobBlogUrl].sort()
    )
  })

  it('a blog unlists itself', async () => {
    const response = await alice.was.request({
      url: directoryUrl,
      method: 'DELETE',
      json: { blogUrl: aliceBlogUrl }
    })
    assert.equal(response.status, 204)
    assert.deepEqual(
      (await listAll()).map(item => item.blogUrl),
      [bobBlogUrl]
    )
  })

  it('a server without the directory answers 404', async () => {
    const otherDataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    const other = await startTestServer({
      backend: new FileSystemBackend({ dataDir: otherDataDir })
    })
    try {
      const response = await fetch(`${other.serverUrl}/directory/blogs`)
      assert.equal(response.status, 404)
    } finally {
      await other.fastify.close()
      await rm(otherDataDir, { recursive: true, force: true })
    }
  })
})
