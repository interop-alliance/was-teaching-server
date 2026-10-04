/**
 * The write stamp and the `ETag` validator layout, through the HTTP API under
 * a frozen physical clock: every versioned record carries a stamp minted by
 * the backend's hybrid logical clock (`updatedAt`, `updatedAtCounter`,
 * `originId`), and its strong validator is
 * `"<generation>.<ms>.<counter>.<originId>"`, with a fifth, local segment on a
 * Space or Collection Metadata object. The local segment moves on a derived
 * change (a backend registration, a governed-log append) while the stamp
 * stays put.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import type { FastifyInstance } from 'fastify'

import {
  etagGeneration,
  frozenClock,
  openTempBackend,
  parseEtagSegments,
  responseOf,
  startTestServer,
  zcapClients
} from './helpers.js'
import type { TempFileSystemBackend } from '../src/testing.js'
import { compareStamps, isoOfMs } from '../src/lib/hlc.js'

describe('Write stamp and ETag layout', () => {
  const clock = frozenClock()
  let fastify: FastifyInstance,
    backend: TempFileSystemBackend,
    serverUrl: string,
    alice: any
  const spaceId = `etag-layout-${crypto.randomUUID()}`

  beforeAll(async () => {
    backend = await openTempBackend({ physicalClock: clock.read })
    ;({ fastify, serverUrl } = await startTestServer({ backend }))
    ;({ alice } = await zcapClients({ serverUrl }))
    await alice.was.createSpace({
      id: spaceId,
      name: 'ETag Layout Space',
      controller: alice.did
    })
  })
  afterAll(async () => {
    await fastify.close()
  })

  const url = (path: string) => new URL(path, serverUrl).toString()
  const spaceMetaUrl = () => url(`/space/${spaceId}/meta`)
  const collectionUrl = (collectionId: string) =>
    url(`/space/${spaceId}/${collectionId}/`)
  const resourceUrl = (collectionId: string, resourceId: string) =>
    url(`/space/${spaceId}/${collectionId}/${resourceId}`)

  /**
   * Creates a fresh Collection and returns its id.
   * @returns {Promise<string>}
   */
  async function freshCollection(): Promise<string> {
    const collectionId = `col-${crypto.randomUUID()}`
    await alice.was.request({
      url: url(`/space/${spaceId}/`),
      method: 'POST',
      json: { id: collectionId, name: collectionId }
    })
    return collectionId
  }

  /**
   * PUTs a JSON Resource and returns the response `ETag`.
   * @param options {object}
   * @param options.collectionId {string}
   * @param options.resourceId {string}
   * @param options.json {unknown}
   * @param [options.headers] {Record<string, string>}
   * @returns {Promise<string>}
   */
  async function putResource({
    collectionId,
    resourceId,
    json,
    headers = {}
  }: {
    collectionId: string
    resourceId: string
    json: unknown
    headers?: Record<string, string>
  }): Promise<string> {
    const response = await alice.was.request({
      url: resourceUrl(collectionId, resourceId),
      method: 'PUT',
      json,
      headers
    })
    assert.equal(response.status, 204)
    return response.headers.get('etag')!
  }

  /**
   * GETs a URL and returns the response, whether or not it succeeded.
   * @param target {string}
   * @param [headers] {Record<string, string>}
   * @returns {Promise<any>}
   */
  async function get(
    target: string,
    headers: Record<string, string> = {}
  ): Promise<any> {
    return responseOf(
      alice.was.request({ url: target, method: 'GET', headers })
    )
  }

  it('two writes of one Resource in one millisecond get counters 0 and 1', async () => {
    const collectionId = await freshCollection()
    clock.now += 1000
    const first = parseEtagSegments(
      await putResource({ collectionId, resourceId: 'doc', json: { n: 1 } })
    )
    const second = parseEtagSegments(
      await putResource({ collectionId, resourceId: 'doc', json: { n: 2 } })
    )
    assert.deepEqual(first.stamp, {
      updatedAt: isoOfMs(clock.now),
      updatedAtCounter: 0,
      originId: backend.originId
    })
    assert.deepEqual(second.stamp, {
      updatedAt: isoOfMs(clock.now),
      updatedAtCounter: 1,
      originId: backend.originId
    })
    assert.equal(second.generation, first.generation)

    // The served Resource Metadata object carries the same stamp.
    const meta = await get(`${resourceUrl(collectionId, 'doc')}/meta`)
    assert.equal(meta.data.updatedAt, new Date(clock.now).toISOString())
    assert.equal(meta.data.updatedAtCounter, 1)
    assert.equal(meta.data.originId, backend.originId)
    for (const retired of ['version', 'metaVersion', 'generation']) {
      assert.equal(retired in meta.data, false, `no ${retired} member`)
    }
  })

  it('a physical clock stepped backwards does not lower updatedAt', async () => {
    const collectionId = await freshCollection()
    clock.now += 1000
    const before = parseEtagSegments(
      await putResource({ collectionId, resourceId: 'doc', json: { n: 1 } })
    )
    clock.now -= 30_000
    const after = parseEtagSegments(
      await putResource({ collectionId, resourceId: 'doc', json: { n: 2 } })
    )
    assert.equal(after.stamp.updatedAt, before.stamp.updatedAt)
    assert.equal(
      after.stamp.updatedAtCounter,
      before.stamp.updatedAtCounter + 1
    )
    const meta = await get(`${resourceUrl(collectionId, 'doc')}/meta`)
    assert.equal(meta.data.updatedAt, before.stamp.updatedAt)
    clock.now += 30_000
  })

  it('a physical clock stepped backwards does not lower updatedAt on a Resource written for the first time after the step', async () => {
    const collectionId = await freshCollection()
    clock.now += 1000
    const before = parseEtagSegments(
      await putResource({ collectionId, resourceId: 'first', json: { n: 1 } })
    )
    clock.now -= 30_000
    // A different Resource, so no held stamp lifts the new one.
    const after = parseEtagSegments(
      await putResource({ collectionId, resourceId: 'second', json: { n: 2 } })
    )
    assert.ok(
      Date.parse(after.stamp.updatedAt) >= Date.parse(before.stamp.updatedAt)
    )
    assert.ok(
      compareStamps(after.stamp, before.stamp) > 0,
      'sorts above the write before the step'
    )
    const first = await get(`${resourceUrl(collectionId, 'first')}/meta`)
    const second = await get(`${resourceUrl(collectionId, 'second')}/meta`)
    assert.ok(
      Date.parse(second.data.updatedAt) >= Date.parse(first.data.updatedAt)
    )
    assert.equal(second.data.updatedAt, after.stamp.updatedAt)
    assert.equal(second.data.updatedAtCounter, after.stamp.updatedAtCounter)
    clock.now += 30_000
  })

  it('a Resource answers If-Match and If-None-Match on the whole four-field validator', async () => {
    const collectionId = await freshCollection()
    clock.now += 1000
    const etag = await putResource({
      collectionId,
      resourceId: 'doc',
      json: { n: 1 }
    })
    const read = await get(resourceUrl(collectionId, 'doc'))
    assert.equal(read.headers.get('etag'), etag)

    const notModified = await get(resourceUrl(collectionId, 'doc'), {
      'if-none-match': etag
    })
    assert.equal(notModified.status, 304)
    assert.equal(notModified.headers.get('etag'), etag)

    const updated = await putResource({
      collectionId,
      resourceId: 'doc',
      json: { n: 2 },
      headers: { 'if-match': etag }
    })
    assert.notEqual(updated, etag)

    // The prior validator, and one that differs only in its origin, no
    // longer match.
    for (const stale of [etag, updated.replace(/\.[^.]+"$/, '.zOther"')]) {
      const refused = await responseOf(
        alice.was.request({
          url: resourceUrl(collectionId, 'doc'),
          method: 'PUT',
          json: { n: 3 },
          headers: { 'if-match': stale }
        })
      )
      assert.equal(refused.status, 412)
    }
  })

  it('a chunk carries the four-field validator', async () => {
    const collectionId = await freshCollection()
    clock.now += 1000
    await putResource({ collectionId, resourceId: 'big', json: { n: 1 } })
    const response = await alice.was.request({
      url: `${resourceUrl(collectionId, 'big')}/chunks/0`,
      method: 'PUT',
      body: new Uint8Array([1, 2, 3]),
      headers: { 'content-type': 'application/octet-stream' }
    })
    assert.equal(response.status, 204)
    const segments = parseEtagSegments(response.headers.get('etag'))
    assert.equal(Date.parse(segments.stamp.updatedAt), clock.now)
    // The parent's write took counter 0 in this millisecond.
    assert.equal(segments.stamp.updatedAtCounter, 1)
    assert.equal(segments.stamp.originId, backend.originId)
    const read = await get(`${resourceUrl(collectionId, 'big')}/chunks/0`)
    assert.equal(read.headers.get('etag'), response.headers.get('etag'))
  })

  it('a /meta write moves the /meta record only: the content ETag and updatedAt stay byte-equal', async () => {
    const collectionId = await freshCollection()
    clock.now += 1000
    const contentEtag = await putResource({
      collectionId,
      resourceId: 'doc',
      json: { n: 1 }
    })
    const metaUrl = `${resourceUrl(collectionId, 'doc')}/meta`
    const before = await get(metaUrl)
    assert.equal(before.data.meta, undefined, 'no /meta record yet')

    clock.now += 5000
    const written = await alice.was.request({
      url: metaUrl,
      method: 'PUT',
      json: { custom: { name: 'Doc' }, writerId: 'ignored-writer' }
    })
    assert.equal(written.status, 204)
    const metaEtag = parseEtagSegments(written.headers.get('etag'))
    assert.equal(Date.parse(metaEtag.stamp.updatedAt), clock.now)

    const after = await get(metaUrl)
    assert.equal(after.headers.get('etag'), written.headers.get('etag'))
    assert.equal(after.data.updatedAt, before.data.updatedAt)
    assert.equal(after.data.updatedAtCounter, before.data.updatedAtCounter)
    assert.equal(after.data.originId, before.data.originId)
    assert.equal(
      after.data.writerId,
      undefined,
      'a /meta body writerId is ignored'
    )
    assert.deepEqual(after.data.meta, {
      updatedAt: new Date(clock.now).toISOString(),
      updatedAtCounter: 0,
      originId: backend.originId,
      generation: metaEtag.generation
    })
    const content = await get(resourceUrl(collectionId, 'doc'))
    assert.equal(content.headers.get('etag'), contentEtag)

    // The /meta validator answers its own conditional read.
    const notModified = await get(metaUrl, {
      'if-none-match': written.headers.get('etag')!
    })
    assert.equal(notModified.status, 304)

    // A second /meta write in the same millisecond moves the /meta validator
    // by its counter, and the content record still does not move.
    const rewritten = await alice.was.request({
      url: metaUrl,
      method: 'PUT',
      json: { custom: { name: 'Doc again' } }
    })
    assert.equal(rewritten.status, 204)
    const secondEtag = parseEtagSegments(rewritten.headers.get('etag'))
    assert.equal(secondEtag.generation, metaEtag.generation)
    assert.equal(secondEtag.stamp.updatedAt, metaEtag.stamp.updatedAt)
    assert.equal(
      secondEtag.stamp.updatedAtCounter,
      metaEtag.stamp.updatedAtCounter + 1
    )
    const afterSecond = await get(metaUrl)
    assert.equal(afterSecond.headers.get('etag'), rewritten.headers.get('etag'))
    assert.equal(afterSecond.data.updatedAt, before.data.updatedAt)
    assert.equal(
      afterSecond.data.updatedAtCounter,
      before.data.updatedAtCounter
    )
    assert.equal(afterSecond.data.originId, before.data.originId)
    const contentAgain = await get(resourceUrl(collectionId, 'doc'))
    assert.equal(contentAgain.headers.get('etag'), contentEtag)
  })

  it('the Space and Collection Metadata objects carry the five-field validator, local segment 0 after a write', async () => {
    const space = await get(spaceMetaUrl())
    const spaceEtag = parseEtagSegments(space.headers.get('etag'), {
      container: true
    })
    assert.equal(spaceEtag.local, 0)
    assert.equal(spaceEtag.stamp.originId, backend.originId)
    assert.equal(space.data.updatedAt, spaceEtag.stamp.updatedAt)
    assert.equal(space.data.updatedAtCounter, spaceEtag.stamp.updatedAtCounter)
    assert.equal(space.data.originId, backend.originId)

    const collectionId = await freshCollection()
    const collection = await get(`${collectionUrl(collectionId)}meta`)
    const collectionEtag = parseEtagSegments(collection.headers.get('etag'), {
      container: true
    })
    assert.equal(collectionEtag.local, 0)
    assert.equal(
      collection.data.updatedAtCounter,
      collectionEtag.stamp.updatedAtCounter
    )
    assert.equal(collection.data.originId, backend.originId)
    for (const member of ['_local', '_generation', 'metaLocal']) {
      assert.equal(member in collection.data, false, `no ${member} member`)
    }

    const notModified = await get(`${collectionUrl(collectionId)}meta`, {
      'if-none-match': collection.headers.get('etag')!
    })
    assert.equal(notModified.status, 304)
  })

  it('each create echo is the object a Read serves right after, stamp members included', async () => {
    clock.now += 1000

    // Create Space (POST /spaces/), then the create-by-PUT of a Space meta.
    const postedSpaceId = `etag-layout-posted-${crypto.randomUUID()}`
    const postedSpace = await alice.was.request({
      url: url('/spaces/'),
      method: 'POST',
      json: { id: postedSpaceId, name: 'Posted', controller: alice.did }
    })
    assert.equal(postedSpace.status, 201)
    const putSpaceId = `etag-layout-put-${crypto.randomUUID()}`
    const putSpace = await alice.was.request({
      url: url(`/space/${putSpaceId}/meta`),
      method: 'PUT',
      json: { name: 'Put', controller: alice.did }
    })
    assert.equal(putSpace.status, 201)

    // Create Collection (POST of the Space), then the create-by-PUT of a
    // Collection meta.
    const postedCollectionId = `col-${crypto.randomUUID()}`
    const postedCollection = await alice.was.request({
      url: url(`/space/${spaceId}/`),
      method: 'POST',
      json: { id: postedCollectionId, name: 'Posted' }
    })
    assert.equal(postedCollection.status, 201)
    const putCollectionId = `col-${crypto.randomUUID()}`
    const putCollection = await alice.was.request({
      url: `${collectionUrl(putCollectionId)}meta`,
      method: 'PUT',
      json: { name: 'Put' }
    })
    assert.equal(putCollection.status, 201)

    for (const [created, metaUrl] of [
      [postedSpace, url(`/space/${postedSpaceId}/meta`)],
      [putSpace, url(`/space/${putSpaceId}/meta`)],
      [postedCollection, `${collectionUrl(postedCollectionId)}meta`],
      [putCollection, `${collectionUrl(putCollectionId)}meta`]
    ] as const) {
      const read = await get(metaUrl)
      assert.deepEqual(created.data, read.data, metaUrl)
      assert.equal(created.headers.get('etag'), read.headers.get('etag'))
      const segments = parseEtagSegments(created.headers.get('etag'), {
        container: true
      })
      assert.equal(created.data.updatedAt, segments.stamp.updatedAt)
      assert.equal(
        created.data.updatedAtCounter,
        segments.stamp.updatedAtCounter
      )
      assert.equal(created.data.originId, backend.originId)
    }
  })

  it('a hard delete and re-create mints a new generation', async () => {
    const collectionId = await freshCollection()
    const first = (await get(`${collectionUrl(collectionId)}meta`)).headers.get(
      'etag'
    )
    await alice.was.request({
      url: collectionUrl(collectionId),
      method: 'DELETE'
    })
    await alice.was.request({
      url: url(`/space/${spaceId}/`),
      method: 'POST',
      json: { id: collectionId, name: collectionId }
    })
    const second = (
      await get(`${collectionUrl(collectionId)}meta`)
    ).headers.get('etag')
    assert.notEqual(etagGeneration(second), etagGeneration(first))
  })

  it('a backend registration moves the Space Metadata local segment and leaves the stamp', async () => {
    const ownSpaceId = `etag-layout-backends-${crypto.randomUUID()}`
    await alice.was.createSpace({
      id: ownSpaceId,
      name: 'Backends',
      controller: alice.did
    })
    const metaUrl = url(`/space/${ownSpaceId}/meta`)
    const before = await get(metaUrl)
    const beforeEtag = parseEtagSegments(before.headers.get('etag'), {
      container: true
    })

    clock.now += 1000
    await alice.was.request({
      url: url(`/space/${ownSpaceId}/backends`),
      method: 'POST',
      json: {
        id: 'gdrive-1',
        name: 'Drive',
        managedBy: 'external',
        provider: 'google-drive',
        connection: { kind: 'oauth2', account: 'alice@example.com' }
      }
    })
    const registered = await get(metaUrl, {
      'if-none-match': before.headers.get('etag')!
    })
    assert.equal(registered.status, 200)
    const registeredEtag = parseEtagSegments(registered.headers.get('etag'), {
      container: true
    })
    assert.deepEqual(
      { ...registeredEtag, local: undefined },
      { ...beforeEtag, local: undefined },
      'generation and stamp unchanged'
    )
    assert.equal(registeredEtag.local, beforeEtag.local! + 1)
    assert.equal(registered.data.updatedAt, before.data.updatedAt)
    assert.equal(registered.data.updatedAtCounter, before.data.updatedAtCounter)

    await alice.was.request({
      url: url(`/space/${ownSpaceId}/backends/gdrive-1`),
      method: 'DELETE'
    })
    const deregistered = parseEtagSegments(
      (await get(metaUrl)).headers.get('etag'),
      { container: true }
    )
    assert.equal(deregistered.local, beforeEtag.local! + 2)

    // A stamped write of the object resets the local segment.
    const written = await alice.was.request({
      url: metaUrl,
      method: 'PUT',
      json: { name: 'Renamed', controller: alice.did }
    })
    const writtenEtag = parseEtagSegments(written.headers.get('etag'), {
      container: true
    })
    assert.equal(writtenEtag.local, 0)
    assert.equal(Date.parse(writtenEtag.stamp.updatedAt), clock.now)
  })

  it('a governed-log append moves the Collection Metadata local segment and leaves the stamp', async () => {
    const collectionId = await freshCollection()
    const metaUrl = `${collectionUrl(collectionId)}meta`
    const before = await get(metaUrl)
    const beforeEtag = parseEtagSegments(before.headers.get('etag'), {
      container: true
    })
    const state = {
      type: 'WasEpochConfiguration',
      scheme: 'edv',
      currentEpoch: 'urn:epoch:1',
      epochs: [
        {
          id: 'urn:epoch:1',
          recipients: [
            {
              header: { kid: 'did:key:zApp1#ka', alg: 'ECDH-ES+A256KW' },
              encrypted_key: 'wrapped'
            }
          ]
        }
      ]
    }
    const genesis = JSON.stringify({
      versionId: '1-hash1',
      versionTime: '2026-09-07T00:00:00Z',
      parameters: { method: 'resource-log:0.1', scid: 'zScid' },
      state,
      proof: []
    })
    clock.now += 1000
    const logged = await alice.was.request({
      url: `${metaUrl}/log`,
      method: 'PUT',
      body: new TextEncoder().encode(`${genesis}\n`),
      headers: { 'content-type': 'text/jsonl', 'if-none-match': '*' }
    })
    assert.equal(logged.status, 204)
    const logEtag = parseEtagSegments(logged.headers.get('etag'))
    assert.equal(
      Date.parse(logEtag.stamp.updatedAt),
      clock.now,
      'the log takes its own stamp'
    )

    const after = await get(metaUrl)
    const afterEtag = parseEtagSegments(after.headers.get('etag'), {
      container: true
    })
    assert.deepEqual(
      { ...afterEtag, local: undefined },
      { ...beforeEtag, local: undefined },
      'generation and stamp unchanged'
    )
    assert.equal(afterEtag.local, beforeEtag.local! + 1)
    assert.equal(after.data.updatedAt, before.data.updatedAt)
    assert.ok(after.data.encryption, 'the derived member moved')
  })

  it('each change document carries updatedAtCounter and originId beside updatedAt', async () => {
    const collectionId = await freshCollection()
    clock.now += 1000
    const etag = await putResource({
      collectionId,
      resourceId: 'doc',
      json: { n: 1 }
    })
    await alice.was.request({
      url: `${resourceUrl(collectionId, 'doc')}/meta`,
      method: 'PUT',
      json: { custom: { name: 'Doc' } }
    })
    const { data } = await alice.was.request({
      url: url(`/space/${spaceId}/${collectionId}/query`),
      method: 'POST',
      json: { profile: 'changes', limit: 10 }
    })
    // The Collection's create comes first, then the one Resource.
    assert.deepEqual(
      data.documents.map((entry: any) => entry.kind),
      ['collection-metadata', 'resource']
    )
    const doc = data.documents[1]
    const segments = parseEtagSegments(etag)
    assert.equal(doc.updatedAt, segments.stamp.updatedAt)
    assert.equal(doc.updatedAtCounter, segments.stamp.updatedAtCounter)
    assert.equal(doc.originId, backend.originId)
    assert.equal(doc.etag, etag)
    assert.equal(doc.meta.originId, backend.originId)
    assert.equal(typeof doc.meta.updatedAtCounter, 'number')
    assert.equal(typeof doc.meta.generation, 'string')
    assert.equal(typeof doc.metaEtag, 'string')
    assert.equal('version' in doc, false)
    assert.equal('metaVersion' in doc, false)
  })
})
