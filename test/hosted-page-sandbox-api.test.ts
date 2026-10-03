/**
 * Hosted-page sandbox integration tests (Vitest, in-process): every response on
 * a WAS route carries the `Content-Security-Policy: sandbox ...` header, so a
 * stored HTML page runs with an opaque origin. A PDF, and the routes outside
 * the WAS route groups (the welcome page, the service description), carry
 * none.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import type { FastifyInstance } from 'fastify'

import type { Space, Collection } from '@interop/was-client'

import { HOSTED_PAGE_SANDBOX_CSP } from '../src/lib/hostedPageSandbox.js'
import {
  openTempBackend,
  responseOf,
  startTestServer,
  zcapClients
} from './helpers.js'

describe('Hosted-page sandbox', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    alice: any,
    aliceSpace: Space,
    pages: Collection

  const spaceId = 'b3f0c9a2-5e1d-4c7a-9f3e-2d8b6a1c4e70'
  const resourceUrl = (resourceId: string) =>
    `${serverUrl}/space/${spaceId}/pages/${resourceId}`
  const chunkUrl = () => `${resourceUrl('index.html')}/chunks/0`

  /**
   * Asserts a response carries the sandbox policy and no `nosniff`.
   * @param response {Response}
   * @returns {void}
   */
  function assertSandboxed(response: Response): void {
    assert.equal(
      response.headers.get('content-security-policy'),
      HOSTED_PAGE_SANDBOX_CSP
    )
    assert.equal(response.headers.get('x-content-type-options'), null)
  }

  beforeAll(async () => {
    ;({ fastify, serverUrl } = await startTestServer({
      backend: await openTempBackend({ prefix: 'was-sandbox-' })
    }))
    ;({ alice } = await zcapClients({ serverUrl }))

    aliceSpace = await alice.was.createSpace({
      id: spaceId,
      name: "Alice's Pages",
      controller: alice.did
    })
    pages = await aliceSpace.createCollection({ id: 'pages', name: 'Pages' })

    await alice.was.request({
      url: resourceUrl('index.html'),
      method: 'PUT',
      body: new Blob(['<!doctype html><script>1</script>'], {
        type: 'text/html'
      })
    })
    await alice.was.request({
      url: chunkUrl(),
      method: 'PUT',
      body: new Blob(['<p>chunk</p>'], { type: 'text/html' })
    })

    const publicPages = await aliceSpace.createCollection({
      id: 'public-pages',
      name: 'Public Pages'
    })
    await publicPages.setPublic()
    await alice.was.request({
      url: `${serverUrl}/space/${spaceId}/public-pages/index.html`,
      method: 'PUT',
      body: new Blob(['<!doctype html><script>1</script>'], {
        type: 'text/html'
      })
    })
  })

  afterAll(async () => {
    await fastify.close()
  })

  it('the policy is a sandbox that keeps the origin and popups opaque', () => {
    const [directive, ...tokens] = HOSTED_PAGE_SANDBOX_CSP.split(' ')
    assert.equal(directive, 'sandbox')
    assert.ok(tokens.includes('allow-scripts'))
    // Either token would let a hosted page reach the origin's storage.
    assert.ok(!tokens.includes('allow-same-origin'))
    assert.ok(!tokens.includes('allow-popups-to-escape-sandbox'))
  })

  it('[anonymous] GET of a world-readable text/html Resource is sandboxed', async () => {
    const response = await fetch(
      new URL(`${serverUrl}/space/${spaceId}/public-pages/index.html`)
    )
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type')!, /text\/html/)
    assertSandboxed(response)
  })

  it('[signed] GET of a text/html Resource is sandboxed', async () => {
    const response = await alice.was.request({
      url: resourceUrl('index.html'),
      method: 'GET'
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type')!, /text\/html/)
    assertSandboxed(response)
  })

  it('[signed] HEAD of a Resource is sandboxed', async () => {
    const response = await alice.was.request({
      url: resourceUrl('index.html'),
      method: 'HEAD'
    })
    assert.equal(response.status, 200)
    assertSandboxed(response)
  })

  it('[signed] a 304 conditional GET of a Resource is sandboxed', async () => {
    const first = await alice.was.request({
      url: resourceUrl('index.html'),
      method: 'GET'
    })
    const response = await responseOf(
      alice.was.request({
        url: resourceUrl('index.html'),
        method: 'GET',
        headers: { 'if-none-match': first.headers.get('etag')! }
      })
    )
    assert.equal(response.status, 304)
    assertSandboxed(response)
  })

  it('[signed] GET of a JSON Resource is sandboxed too', async () => {
    await pages.put('data', { id: 'data', name: 'Some data' })
    const response = await alice.was.request({
      url: resourceUrl('data'),
      method: 'GET'
    })
    assert.equal(response.status, 200)
    assertSandboxed(response)
  })

  it('[signed] GET and HEAD of an application/pdf Resource are not sandboxed', async () => {
    await alice.was.request({
      url: resourceUrl('report.pdf'),
      method: 'PUT',
      body: new Blob(['%PDF-1.4\n%%EOF\n'], {
        type: 'application/pdf'
      })
    })
    for (const method of ['GET', 'HEAD']) {
      const response = await alice.was.request({
        url: resourceUrl('report.pdf'),
        method
      })
      assert.equal(response.status, 200, method)
      assert.match(response.headers.get('content-type')!, /application\/pdf/)
      assert.equal(response.headers.get('content-security-policy'), null)
    }
  })

  it('[signed] GET and HEAD of a chunk are sandboxed', async () => {
    for (const method of ['GET', 'HEAD']) {
      const response = await alice.was.request({ url: chunkUrl(), method })
      assert.equal(response.status, 200, method)
      assertSandboxed(response)
    }
  })

  it('[signed] a 304 conditional GET of a chunk is sandboxed', async () => {
    const first = await alice.was.request({ url: chunkUrl(), method: 'GET' })
    const response = await responseOf(
      alice.was.request({
        url: chunkUrl(),
        method: 'GET',
        headers: { 'if-none-match': first.headers.get('etag')! }
      })
    )
    assert.equal(response.status, 304)
    assertSandboxed(response)
  })

  it('[anonymous] the masked 404 on a chunk read is sandboxed', async () => {
    const response = await fetch(new URL(chunkUrl()))
    assert.equal(response.status, 404)
    assertSandboxed(response)
  })

  it('[anonymous] the masked 404 on a Resource read is sandboxed', async () => {
    const response = await fetch(new URL(resourceUrl('index.html')))
    assert.equal(response.status, 404)
    assertSandboxed(response)
  })

  it('[signed] JSON API responses are sandboxed too', async () => {
    const urls = [
      `${serverUrl}/space/${spaceId}/pages/`, // Collection listing
      `${serverUrl}/space/${spaceId}/meta`, // Space Metadata object
      `${serverUrl}/space/${spaceId}/pages/meta`, // Collection Metadata object
      `${resourceUrl('index.html')}/meta`, // Resource metadata
      `${resourceUrl('index.html')}/chunks/` // chunk listing
    ]
    for (const url of urls) {
      const response = await alice.was.request({ url, method: 'GET' })
      assert.equal(response.status, 200, url)
      assertSandboxed(response)
    }
  })

  it('[signed] a slash redirect and a 405 refusal are sandboxed', async () => {
    const redirect = await fetch(new URL(`${serverUrl}/spaces`), {
      redirect: 'manual'
    })
    assert.equal(redirect.status, 308)
    assertSandboxed(redirect)

    const refusal = await responseOf(
      alice.was.request({
        url: `${serverUrl}/space/${spaceId}/meta`,
        method: 'DELETE'
      })
    )
    assert.equal(refusal.status, 405)
    assertSandboxed(refusal)
  })

  it('[anonymous] the welcome page and service description carry no sandbox policy', async () => {
    for (const url of [`${serverUrl}/`, `${serverUrl}/service`]) {
      const response = await fetch(new URL(url))
      assert.equal(response.status, 200, url)
      assert.equal(response.headers.get('content-security-policy'), null, url)
    }
  })
})
