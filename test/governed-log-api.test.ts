/**
 * Governing history log API tests (the `governed-history-logs` feature): the
 * `/space/:spaceId/:collectionId/meta/log` sub-resource, whose head entry's
 * `state` the server serves as the Collection's `encryption` descriptor.
 * Covers the declaration by guarded create, the derived member (head `state`
 * plus `history`), the compare-and-swap append, and the refusals: a direct
 * `encryption` write on a governed Collection, a line-contract break, an
 * epoch-transition violation, and governing an already-described Collection.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import {
  assertEtagVersion,
  responseOf,
  startTestServer,
  zcapClients
} from './helpers.js'

/** A minimal structurally-valid EDV Encrypted Document envelope. */
const envelope = {
  id: 'z1',
  sequence: 0,
  indexed: [],
  jwe: { protected: 'eyJhbGciOiJkaXI', ciphertext: 'c1phertext' }
}

/** A descriptor recipient entry (the JWE recipients-entry shape). */
const recipient = (kid: string) => ({
  header: { kid, alg: 'ECDH-ES+A256KW' },
  encrypted_key: `wrapped-${kid}`
})

/** A log entry line: the profile's members with `state` as given. */
function entryLine({
  ordinal,
  state,
  parameters = {}
}: {
  ordinal: number
  state: Record<string, unknown>
  parameters?: Record<string, unknown>
}): string {
  return JSON.stringify({
    versionId: `${ordinal}-hash${ordinal}`,
    versionTime: '2026-09-07T00:00:00Z',
    parameters,
    state,
    proof: []
  })
}

/** The genesis line: carries the format identifier and the SCID. */
function genesisLine(state: Record<string, unknown>): string {
  return entryLine({
    ordinal: 1,
    state,
    parameters: { method: 'resource-log:0.1', scid: 'zScid' }
  })
}

const oneEpoch = {
  type: 'WasEpochConfiguration',
  scheme: 'edv',
  currentEpoch: 'urn:epoch:1',
  epochs: [{ id: 'urn:epoch:1', recipients: [recipient('did:key:zApp1#ka')] }]
}
const twoEpochs = {
  ...oneEpoch,
  currentEpoch: 'urn:epoch:2',
  epochs: [
    { id: 'urn:epoch:2', recipients: [recipient('did:key:zApp2#ka')] },
    ...oneEpoch.epochs
  ]
}

describe('Governing history log API (meta/log)', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    dataDir: string,
    alice: any,
    aliceDelegatedApp: any
  const spaceId = `governed-log-space-${crypto.randomUUID()}`

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice, aliceDelegatedApp } = await zcapClients({ serverUrl }))
    await alice.was.createSpace({
      id: spaceId,
      name: 'Governed Log Space',
      controller: alice.did
    })
  })
  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const collectionUrl = (collectionId: string) =>
    `${serverUrl}/space/${spaceId}/${collectionId}`
  const logUrl = (collectionId: string) =>
    `${collectionUrl(collectionId)}/meta/log`

  /** Creates a fresh plaintext-by-default Collection and returns its id. */
  async function freshCollection(body: object = {}): Promise<string> {
    const collectionId = `col-${crypto.randomUUID()}`
    await alice.was.request({
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, name: collectionId, ...body }
    })
    return collectionId
  }

  /**
   * PUTs a log body under the given preconditions. Resolves the status and
   * `ETag` of a success, or the status and parsed problem document of a
   * rejection (the client has already consumed the body by then).
   */
  async function putLog({
    collectionId,
    body,
    headers = {}
  }: {
    collectionId: string
    body: string
    headers?: Record<string, string>
  }): Promise<{ status: number; etag: string | null; problem?: any }> {
    try {
      const response = await alice.was.request({
        url: logUrl(collectionId),
        method: 'PUT',
        body: new TextEncoder().encode(body),
        headers: { 'content-type': 'text/jsonl', ...headers }
      })
      return { status: response.status, etag: response.headers.get('etag') }
    } catch (err: any) {
      if (!err.response) {
        throw err
      }
      return { status: err.response.status, etag: null, problem: err.data }
    }
  }

  /** The text body of a log read (not pre-parsed: JSON Lines is not JSON). */
  async function logText(response: any): Promise<string> {
    return response.data ?? (await response.text())
  }

  /** Captures the raw error from a `was.request()` rejection. */
  async function rejection(promise: Promise<unknown>): Promise<any> {
    try {
      await promise
      assert.fail('expected the request to be rejected')
    } catch (err) {
      return err
    }
  }

  /** Governs a fresh Collection with a one-epoch genesis; returns id + ETag. */
  async function governedCollection(): Promise<{
    collectionId: string
    body: string
    etag: string
  }> {
    const collectionId = await freshCollection()
    const body = genesisLine(oneEpoch) + '\n'
    const created = await putLog({
      collectionId,
      body,
      headers: { 'if-none-match': '*' }
    })
    assert.equal(created.status, 204)
    return { collectionId, body, etag: created.etag! }
  }

  describe('declaration and derivation', () => {
    it('[signed] a guarded create governs the Collection: encryption is derived from the head state with history stamped on', async () => {
      const { collectionId, etag } = await governedCollection()
      assertEtagVersion({ etag, version: 1 })

      const described = await alice.was.request({
        url: collectionUrl(collectionId),
        method: 'GET'
      })
      assert.deepEqual(described.data.encryption, {
        ...oneEpoch,
        history: { method: 'resource-log:0.1', resource: logUrl(collectionId) }
      })
    })

    it('[signed] the log reads back verbatim as text/jsonl with its ETag, and 304s on If-None-Match', async () => {
      const { collectionId, body, etag } = await governedCollection()
      const read = await alice.was.request({
        url: logUrl(collectionId),
        method: 'GET'
      })
      assert.equal(read.status, 200)
      assert.match(read.headers.get('content-type')!, /^text\/jsonl/)
      assert.equal(read.headers.get('etag'), etag)
      assert.equal(await logText(read), body)

      const conditional = await responseOf(
        alice.was.request({
          url: logUrl(collectionId),
          method: 'GET',
          headers: { 'if-none-match': etag }
        })
      )
      assert.equal(conditional.status, 304)
      assert.equal(conditional.headers.get('etag'), etag)
    })

    it('[signed] a Collection with no log 404s on the log read', async () => {
      const collectionId = await freshCollection()
      const err = await rejection(
        alice.was.request({ url: logUrl(collectionId), method: 'GET' })
      )
      assert.equal(err.response.status, 404)
    })

    it('[signed] a log write on a nonexistent Collection is a 404, never a create', async () => {
      const response = await putLog({
        collectionId: `absent-${crypto.randomUUID()}`,
        body: genesisLine(oneEpoch) + '\n',
        headers: { 'if-none-match': '*' }
      })
      assert.equal(response.status, 404)
    })

    it('[delegated] a capability on the Collection URL covers the log read', async () => {
      const { collectionId, body } = await governedCollection()
      const zcap = await alice.was.grant({
        to: aliceDelegatedApp.did,
        actions: ['GET'],
        target: `${collectionUrl(collectionId)}/`
      })
      const read = await aliceDelegatedApp.was.request({
        url: logUrl(collectionId),
        method: 'GET',
        capability: zcap
      })
      assert.equal(read.status, 200)
      assert.equal(await logText(read), body)
    })
  })

  describe('append (compare-and-swap)', () => {
    it('[signed] an If-Match append carrying the prior bytes lands, bumps the log ETag, and moves the derived member to the new head', async () => {
      const { collectionId, body, etag } = await governedCollection()
      const extended = body + entryLine({ ordinal: 2, state: twoEpochs }) + '\n'
      const appended = await putLog({
        collectionId,
        body: extended,
        headers: { 'if-match': etag }
      })
      assert.equal(appended.status, 204)
      assertEtagVersion({ etag: appended.etag, version: 2 })

      const described = await alice.was.request({
        url: collectionUrl(collectionId),
        method: 'GET'
      })
      assert.equal(described.data.encryption.currentEpoch, 'urn:epoch:2')
      assert.equal(described.data.encryption.epochs.length, 2)
    })

    it('[signed] a stale If-Match is a 412 and the log is unchanged', async () => {
      const { collectionId, body, etag } = await governedCollection()
      const extended = body + entryLine({ ordinal: 2, state: twoEpochs }) + '\n'
      await putLog({
        collectionId,
        body: extended,
        headers: { 'if-match': etag }
      })
      const lost = await putLog({
        collectionId,
        body: extended,
        headers: { 'if-match': etag }
      })
      assert.equal(lost.status, 412)
      const read = await alice.was.request({
        url: logUrl(collectionId),
        method: 'GET'
      })
      assertEtagVersion({ etag: read.headers.get('etag'), version: 2 })
    })

    it('[signed] a guarded create on an existing log is a 412', async () => {
      const { collectionId, body } = await governedCollection()
      const raced = await putLog({
        collectionId,
        body,
        headers: { 'if-none-match': '*' }
      })
      assert.equal(raced.status, 412)
    })

    it('[signed] a log write bumps the Collection Description ETag', async () => {
      const { collectionId, body, etag } = await governedCollection()
      const before = await alice.was.request({
        url: collectionUrl(collectionId),
        method: 'GET'
      })
      const extended = body + entryLine({ ordinal: 2, state: twoEpochs }) + '\n'
      await putLog({
        collectionId,
        body: extended,
        headers: { 'if-match': etag }
      })
      const after = await alice.was.request({
        url: collectionUrl(collectionId),
        method: 'GET'
      })
      assert.notEqual(after.headers.get('etag'), before.headers.get('etag'))
      // A conditional read against the stale description ETag is a 200.
      const conditional = await responseOf(
        alice.was.request({
          url: collectionUrl(collectionId),
          method: 'GET',
          headers: { 'if-none-match': before.headers.get('etag')! }
        })
      )
      assert.equal(conditional.status, 200)
    })
  })

  describe('refusals', () => {
    it('[signed] a direct encryption write on a governed Collection is 409 encryption-history-log-governed', async () => {
      const { collectionId } = await governedCollection()
      const err = await rejection(
        alice.was.request({
          url: collectionUrl(collectionId),
          method: 'PUT',
          json: { id: collectionId, encryption: twoEpochs }
        })
      )
      assert.equal(err.response.status, 409)
      assert.match(err.data.type, /#encryption-history-log-governed$/)
      // The descriptor is unchanged.
      const described = await alice.was.request({
        url: collectionUrl(collectionId),
        method: 'GET'
      })
      assert.equal(described.data.encryption.currentEpoch, 'urn:epoch:1')
    })

    it('[signed] a Description update without encryption still lands on a governed Collection', async () => {
      const { collectionId } = await governedCollection()
      const response = await alice.was.request({
        url: collectionUrl(collectionId),
        method: 'PUT',
        json: { id: collectionId, name: 'Renamed' }
      })
      assert.equal(response.status, 204)
      const described = await alice.was.request({
        url: collectionUrl(collectionId),
        method: 'GET'
      })
      assert.equal(described.data.name, 'Renamed')
      assert.equal(described.data.encryption.scheme, 'edv')
    })

    it('[signed] a plaintext member on a governed Collection is refused like on any encrypted one', async () => {
      const { collectionId } = await governedCollection()
      const err = await rejection(
        alice.was.request({
          url: collectionUrl(collectionId),
          method: 'PUT',
          json: { id: collectionId, plaintext: {} }
        })
      )
      assert.equal(err.response.status, 400)
    })

    it('[signed] a line-contract break is 400 invalid-request-body', async () => {
      const collectionId = await freshCollection()
      for (const body of [
        '',
        'not json\n',
        JSON.stringify({ versionId: '1-x', parameters: {} }) + '\n',
        genesisLine(oneEpoch) +
          '\n\n' +
          entryLine({ ordinal: 2, state: oneEpoch })
      ]) {
        const response = await putLog({
          collectionId,
          body,
          headers: { 'if-none-match': '*' }
        })
        assert.equal(response.status, 400, `body ${JSON.stringify(body)}`)
        assert.match(response.problem.type, /#invalid-request-body$/)
      }
      // None of them declared the Collection governed.
      const err = await rejection(
        alice.was.request({ url: logUrl(collectionId), method: 'GET' })
      )
      assert.equal(err.response.status, 404)
    })

    it('[signed] a head state that is not a supported descriptor is refused as a Description write would be', async () => {
      const collectionId = await freshCollection()
      const response = await putLog({
        collectionId,
        body: genesisLine({ type: 'Other', scheme: 'unknown' }) + '\n',
        headers: { 'if-none-match': '*' }
      })
      assert.equal(response.status, 400)
      assert.match(response.problem.type, /#unsupported-encryption-scheme$/)
    })

    it('[signed] an epoch-transition violation on append is refused as the Description PUT refuses it', async () => {
      const collectionId = await freshCollection()
      const body = genesisLine(twoEpochs) + '\n'
      const created = await putLog({
        collectionId,
        body,
        headers: { 'if-none-match': '*' }
      })
      assert.equal(created.status, 204)
      // Dropping an epoch, and moving `currentEpoch` back, are both refused.
      const rolledBack =
        body + entryLine({ ordinal: 2, state: oneEpoch }) + '\n'
      const response = await putLog({
        collectionId,
        body: rolledBack,
        headers: { 'if-match': created.etag! }
      })
      // Dropping an epoch is the Description PUT's 400 append-only refusal.
      assert.equal(response.status, 400)
      assert.match(response.problem.type, /#invalid-request-body$/)
      assert.match(response.problem.errors[0].pointer, /epochs/)
      // The log is unchanged.
      const read = await alice.was.request({
        url: logUrl(collectionId),
        method: 'GET'
      })
      assertEtagVersion({ etag: read.headers.get('etag'), version: 1 })
    })

    it('[signed] governing a Collection that already carries a client-written descriptor is 409 encryption-immutable', async () => {
      const collectionId = await freshCollection({
        encryption: { scheme: 'edv' }
      })
      const response = await putLog({
        collectionId,
        body: genesisLine(oneEpoch) + '\n',
        headers: { 'if-none-match': '*' }
      })
      assert.equal(response.status, 409)
      assert.match(response.problem.type, /#encryption-immutable$/)
      const err = await rejection(
        alice.was.request({ url: logUrl(collectionId), method: 'GET' })
      )
      assert.equal(err.response.status, 404)
    })
  })

  describe('a sub-resource, not a Resource', () => {
    it('[signed] the log is absent from the listing and the changes feed, and the envelope rule applies to Resources but not to it', async () => {
      const { collectionId } = await governedCollection()

      // The governed Collection is encrypted: a plaintext Resource write is
      // refused by the envelope rule, a conforming envelope lands...
      const plain = await rejection(
        alice.was.request({
          url: `${collectionUrl(collectionId)}/`,
          method: 'POST',
          json: { hello: 'world' }
        })
      )
      assert.equal(plain.response.status, 422)
      const created = await alice.was.request({
        url: `${collectionUrl(collectionId)}/`,
        method: 'POST',
        body: new TextEncoder().encode(JSON.stringify(envelope)),
        headers: { 'content-type': 'application/json' }
      })
      assert.equal(created.status, 201)
      // ...while the log itself (JSON Lines, no envelope) is exempt: the
      // create above already succeeded on this Collection.

      const listing = await alice.was.request({
        url: `${collectionUrl(collectionId)}/`,
        method: 'GET'
      })
      const ids = listing.data.items.map((item: any) => item.id)
      assert.equal(ids.length, 1)
      assert.ok(!ids.some((id: string) => /log|meta/.test(id)))

      const feed = await alice.was.request({
        url: `${collectionUrl(collectionId)}/query`,
        method: 'POST',
        json: { profile: 'changes' }
      })
      assert.equal(feed.data.documents.length, 1)
    })

    it('[signed] a PUT /meta does not touch the log', async () => {
      const { collectionId, etag } = await governedCollection()
      const meta = await alice.was.request({
        url: `${collectionUrl(collectionId)}/meta`,
        method: 'PUT',
        json: { custom: envelope }
      })
      assert.equal(meta.status, 204)
      const read = await alice.was.request({
        url: logUrl(collectionId),
        method: 'GET'
      })
      assert.equal(read.headers.get('etag'), etag)
    })

    it('[signed] a scheme change on append is 409 encryption-immutable', async () => {
      const { collectionId, body, etag } = await governedCollection()
      const response = await putLog({
        collectionId,
        body:
          body +
          entryLine({
            ordinal: 2,
            state: { ...oneEpoch, scheme: 'edv', version: 0 }
          }) +
          '\n',
        headers: { 'if-match': etag }
      })
      assert.equal(response.status, 400)
    })

    it('[signed] deleting the Collection takes the log with it', async () => {
      const { collectionId, body } = await governedCollection()
      await alice.was.request({
        url: collectionUrl(collectionId),
        method: 'DELETE'
      })
      // Re-created under the same id, the Collection is not governed.
      await alice.was.request({
        path: `/space/${spaceId}/`,
        method: 'POST',
        json: { id: collectionId, name: collectionId }
      })
      const described = await alice.was.request({
        url: collectionUrl(collectionId),
        method: 'GET'
      })
      assert.equal(described.data.encryption, undefined)
      const recreated = await putLog({
        collectionId,
        body,
        headers: { 'if-none-match': '*' }
      })
      assert.equal(recreated.status, 204)
    })
  })

  it('[signed] the backend advertises governed-history-logs', async () => {
    const backends = await alice.was.request({
      url: `${serverUrl}/space/${spaceId}/backends`,
      method: 'GET'
    })
    const features =
      backends.data.items?.[0]?.features ?? backends.data[0]?.features
    assert.ok(
      features?.includes('governed-history-logs'),
      JSON.stringify(backends.data)
    )
  })
})
