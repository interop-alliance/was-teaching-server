/**
 * WAS conformance tests — Resource API
 * Using Node.js test runner
 * @see https://nodejs.org/api/test.html
 */
import { it, describe, before, after } from 'node:test'
import assert from 'node:assert'

import {
  buildZcapClients,
  createSpace,
  generateId,
  serverUrl
} from './helpers.js'

describe('Resource API', () => {
  let alice: any, bob: any

  before(async () => {
    ;({ alice, bob } = await buildZcapClients())
    alice.space1 = { id: generateId() }
    await createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Space #1",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    // Pre-create the credentials collection so resource tests can POST/PUT into it
    await alice.rootClient.request({
      url: new URL(`/space/${alice.space1.id}/`, serverUrl).toString(),
      method: 'POST',
      json: { id: 'credentials', name: 'Verifiable Credentials' }
    })
  })

  after(async () => {
    try {
      await alice.rootClient.request({
        url: new URL(`/space/${alice.space1.id}`, serverUrl).toString(),
        method: 'DELETE'
      })
    } catch {
      /* best-effort cleanup */
    }
  })

  it('GET a resource with no auth headers falls through to policy and 404s (no public policy)', async () => {
    // Reads no longer 401 at the hook: an anonymous read is allowed to attempt,
    // and is denied as 404 (no-leak) when no access-control policy grants it.
    const response = await fetch(
      new URL('/space/any-space-id/any-collection/any-resource', serverUrl),
      { method: 'GET' }
    )
    assert.equal(response.status, 404)
    assert.match(
      response.headers.get('content-type')!,
      /application\/problem\+json/
    )
  })

  it('GET /space/:spaceId/:collectionId/:resourceId should 404 error on not found space id', async () => {
    const url = new URL(
      '/space/space-id-that-does-not-exist/unknown-collection/unknown-resource',
      serverUrl
    ).toString()
    let expectedError: any
    try {
      await alice.rootClient.request({ url, method: 'GET' })
    } catch (err) {
      expectedError = err
    }
    assert.equal(expectedError.response.status, 404)
    assert.match(
      expectedError.response.headers.get('content-type'),
      /application\/problem\+json/
    )
  })

  it('[root] POST and GET Resource with proper authorization', async () => {
    const body = { id: 'sample-resource', name: 'Sample Verifiable Credential' }
    const response = await alice.rootClient.request({
      url: new URL(
        `/space/${alice.space1.id}/credentials/`,
        serverUrl
      ).toString(),
      method: 'POST',
      action: 'POST',
      json: body
    })
    assert.equal(response.status, 201)
    assert.equal(response.data['content-type'], 'application/json')
    assert.match(response.headers.get('content-type'), /application\/json/)

    const resourceUrl = response.headers.get('location')
    assert.ok(
      resourceUrl.startsWith(
        `${serverUrl}/space/${alice.space1.id}/credentials/`
      )
    )

    const fetchResourceResponse = await alice.rootClient.request({
      url: resourceUrl,
      method: 'GET'
    })
    assert.equal(fetchResourceResponse.status, 200)
    assert.match(
      fetchResourceResponse.headers.get('content-type'),
      /application\/json/
    )
    assert.equal(
      fetchResourceResponse.data.name,
      'Sample Verifiable Credential'
    )
  })

  it('[root] POST and GET a non-JSON resource', async () => {
    const body = new Blob(['line 1\nline2\n'], { type: 'text/plain' })
    const response = await alice.rootClient.request({
      url: new URL(
        `/space/${alice.space1.id}/credentials/`,
        serverUrl
      ).toString(),
      method: 'POST',
      body
    })
    assert.equal(response.status, 201)

    const createdUrl = response.headers.get('location')
    const fetchResourceResponse = await alice.rootClient.request({
      url: createdUrl,
      method: 'GET'
    })
    assert.equal(fetchResourceResponse.status, 200)
    const responseBody = await fetchResourceResponse.text()
    assert.equal(responseBody, 'line 1\nline2\n')
  })

  it('[root] PUT and GET Resource', async () => {
    const resourceId = 'put-resource'
    const resourceUrl = new URL(
      `/space/${alice.space1.id}/credentials/${resourceId}`,
      serverUrl
    ).toString()
    const body = { id: resourceId, name: 'PUT Resource Test' }

    const putResponse = await alice.rootClient.request({
      url: resourceUrl,
      method: 'PUT',
      json: body
    })
    assert.equal(putResponse.status, 204)

    const getResponse = await alice.rootClient.request({
      url: resourceUrl,
      method: 'GET'
    })
    assert.equal(getResponse.status, 200)
    assert.equal(getResponse.data.name, 'PUT Resource Test')
  })

  it('[root] PUT Resource to non-existent collection should 404', async () => {
    const resourceUrl = new URL(
      `/space/${alice.space1.id}/collection-does-not-exist/some-resource`,
      serverUrl
    ).toString()
    let expectedError: any
    try {
      await alice.rootClient.request({
        url: resourceUrl,
        method: 'PUT',
        json: { name: 'test' }
      })
    } catch (err) {
      expectedError = err
    }
    assert.equal(expectedError.response.status, 404)
    assert.match(
      expectedError.response.headers.get('content-type'),
      /application\/problem\+json/
    )
  })

  it('[root] PUT Resource should update existing resource (upsert)', async () => {
    const resourceId = 'upsert-resource'
    const resourceUrl = new URL(
      `/space/${alice.space1.id}/credentials/${resourceId}`,
      serverUrl
    ).toString()

    await alice.rootClient.request({
      url: resourceUrl,
      method: 'PUT',
      json: { id: resourceId, name: 'Original Name' }
    })

    const secondPut = await alice.rootClient.request({
      url: resourceUrl,
      method: 'PUT',
      json: { id: resourceId, name: 'Updated Name' }
    })
    assert.equal(secondPut.status, 204)

    const getResponse = await alice.rootClient.request({
      url: resourceUrl,
      method: 'GET'
    })
    assert.equal(getResponse.status, 200)
    assert.equal(getResponse.data.name, 'Updated Name')
  })

  it("[root] Bob should not be able to GET Alice's resources", async () => {
    const body = {
      id: 'alice-private-resource',
      name: 'Alice Private Resource'
    }
    const postResponse = await alice.rootClient.request({
      url: new URL(
        `/space/${alice.space1.id}/credentials/`,
        serverUrl
      ).toString(),
      method: 'POST',
      json: body
    })
    assert.equal(postResponse.status, 201)
    const resourceUrl = postResponse.headers.get('location')

    let expectedError: any
    try {
      await bob.rootClient.request({ url: resourceUrl, method: 'GET' })
    } catch (err) {
      expectedError = err
    }
    // Bob gets a 404, not a 403, to avoid revealing the resource's existence
    assert.equal(expectedError.response.status, 404)
    assert.match(
      expectedError.response.headers.get('content-type'),
      /application\/problem\+json/
    )

    await alice.rootClient.request({ url: resourceUrl, method: 'DELETE' })
  })

  it('[root] GET Resource Metadata (/meta), or skip if unimplemented', async () => {
    // Resource Metadata is OPTIONAL: a server that does not implement it
    // responds 501 `unsupported-operation`, which this test treats as a skip.
    const resourceId = generateId()
    const resourceUrl = new URL(
      `/space/${alice.space1.id}/credentials/${resourceId}`,
      serverUrl
    ).toString()
    await alice.rootClient.request({
      url: resourceUrl,
      method: 'PUT',
      json: { id: resourceId, name: 'Metadata Resource' }
    })

    const metaUrl = `${resourceUrl}/meta`
    let response: any
    try {
      response = await alice.rootClient.request({ url: metaUrl, method: 'GET' })
    } catch (err: any) {
      if (err.response?.status === 501) {
        // Optional endpoint not implemented -- pass with skip.
        return
      }
      throw err
    }

    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /application\/json/)
    assert.equal(response.data.contentType, 'application/json')
    assert.ok(
      Number.isInteger(response.data.size) && response.data.size > 0,
      'size should be a positive integer'
    )

    // An anonymous (unsigned) meta read must not leak existence: 404 problem+json.
    const anonResponse = await fetch(new URL(metaUrl))
    assert.equal(anonResponse.status, 404)
    assert.match(
      anonResponse.headers.get('content-type')!,
      /application\/problem\+json/
    )
  })

  describe('HEAD Resource', () => {
    it('[root] HEAD a binary resource returns its content-type + content-length, no body', async () => {
      // 'line 1\nline2\n' is exactly 13 bytes.
      const body = new Blob(['line 1\nline2\n'], { type: 'text/plain' })
      const postResponse = await alice.rootClient.request({
        url: new URL(
          `/space/${alice.space1.id}/credentials/`,
          serverUrl
        ).toString(),
        method: 'POST',
        body
      })
      assert.equal(postResponse.status, 201)
      const resourceUrl = postResponse.headers.get('location')

      const headResponse = await alice.rootClient.request({
        url: resourceUrl,
        method: 'HEAD'
      })
      assert.equal(headResponse.status, 200)
      assert.match(headResponse.headers.get('content-type'), /text\/plain/)
      assert.equal(headResponse.headers.get('content-length'), '13')
      // HEAD carries no body.
      assert.equal(await headResponse.text(), '')
    })

    it('anonymous HEAD of a private resource is denied (404, no leak)', async () => {
      const resourceId = generateId()
      const resourceUrl = new URL(
        `/space/${alice.space1.id}/credentials/${resourceId}`,
        serverUrl
      ).toString()
      await alice.rootClient.request({
        url: resourceUrl,
        method: 'PUT',
        json: { id: resourceId, name: 'Private HEAD Resource' }
      })

      const response = await fetch(new URL(resourceUrl), { method: 'HEAD' })
      assert.equal(response.status, 404)
    })

    it('anonymous HEAD of a PublicCanRead resource returns headers matching a GET', async () => {
      const resourceId = generateId()
      const resourceUrl = new URL(
        `/space/${alice.space1.id}/credentials/${resourceId}`,
        serverUrl
      ).toString()
      await alice.rootClient.request({
        url: resourceUrl,
        method: 'PUT',
        json: { id: resourceId, name: 'Public HEAD Resource' }
      })
      // Grant public read at the resource level.
      await alice.rootClient.request({
        url: `${resourceUrl}/policy`,
        method: 'PUT',
        json: { type: 'PublicCanRead' }
      })

      // The HEAD Content-Type/Content-Length must match what a GET returns
      // (spec "Content Types and Representations": both correspond to the
      // Metadata `contentType`/`size`).
      const getResponse = await fetch(new URL(resourceUrl))
      assert.equal(getResponse.status, 200)
      const getBytes = await getResponse.arrayBuffer()

      const headResponse = await fetch(new URL(resourceUrl), { method: 'HEAD' })
      assert.equal(headResponse.status, 200)
      assert.equal(
        headResponse.headers.get('content-type'),
        getResponse.headers.get('content-type')
      )
      assert.equal(
        headResponse.headers.get('content-length'),
        String(getBytes.byteLength)
      )
      assert.equal(await headResponse.text(), '')

      // Cleanup: revoke the resource policy.
      await alice.rootClient.request({
        url: `${resourceUrl}/policy`,
        method: 'DELETE'
      })
    })
  })

  it('[root] POST and DELETE Resource with proper authorization', async () => {
    const body = { id: 'sample-resource-to-delete', name: 'Sample Delete' }
    const response = await alice.rootClient.request({
      url: new URL(
        `/space/${alice.space1.id}/credentials/`,
        serverUrl
      ).toString(),
      method: 'POST',
      json: body
    })
    assert.equal(response.status, 201)
    assert.equal(response.data['content-type'], 'application/json')
    assert.match(response.headers.get('content-type'), /application\/json/)

    const resourceUrl = response.headers.get('location')
    assert.ok(
      resourceUrl.startsWith(
        `${serverUrl}/space/${alice.space1.id}/credentials/`
      )
    )

    const fetchResourceResponse = await alice.rootClient.request({
      url: resourceUrl,
      method: 'GET'
    })
    assert.equal(fetchResourceResponse.status, 200)

    const deleteResponse = await alice.rootClient.request({
      url: resourceUrl,
      method: 'DELETE'
    })
    assert.equal(deleteResponse.status, 204)

    let checkResponse: any
    try {
      await alice.rootClient.request({ url: resourceUrl, method: 'GET' })
    } catch (err: any) {
      checkResponse = err.response
    }
    assert.equal(checkResponse.status, 404)
  })
})
