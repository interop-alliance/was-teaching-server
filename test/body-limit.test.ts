/**
 * Buffered request body limits (Vitest). Three things are pinned:
 *
 * - `captureRawBody` (preParsing, before any signature is verified) stops
 *   accumulating at the effective limit and refuses the request there, so a
 *   chunked body many times the limit is never resident: the server stops
 *   reading, closes the connection with the 413, and the client sees it long
 *   before it has written the body. That holds for every buffered media type,
 *   including one no buffering parser handles (`text/jsonl`, the governed log).
 * - That limit is derived from the backend's `maxUploadBytes` rather than
 *   Fastify's 1 MiB default, so a JSON write the same bytes would pass as
 *   `application/octet-stream` succeeds.
 * - A framework over-limit error is answered as `payload-too-large`, not as
 *   `internal-error` with an empty `errors` entry.
 *
 * The over-limit cases are driven with hand-built auth headers (a placeholder
 * signature): the bound runs before signature verification, which is the point
 * of the test -- an unauthenticated caller meets it.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { FileSystemBackend } from '../src/backends/filesystem.js'
import { DEFAULT_MAX_UPLOAD_BYTES } from '../src/config.default.js'
import { bufferedBodyLimit } from '../src/lib/bodyLimit.js'
import { handleError } from '../src/errors.js'
import {
  digestHeaderFor,
  placeholderAuthHeader,
  rootInvocation,
  startTestServer,
  zcapClients
} from './helpers.js'

/** A 64 KiB cap, so the over-limit cases stay fast. */
const MAX_UPLOAD_BYTES = 64 * 1024

/**
 * Writes a chunked (no `Content-Length`) request body, one chunk at a time,
 * and stops as soon as the server answers or closes the connection. Reports
 * how many bytes actually reached the wire, which is the structural measure of
 * the bound: a server that buffered the whole body would have read them all.
 * @param options {object}
 * @param options.serverUrl {string}   the test server's base URL
 * @param options.requestPath {string}   the request path
 * @param options.headers {Record<string, string>}   request headers
 * @param options.chunk {Buffer}   the chunk written repeatedly
 * @param options.chunkCount {number}   how many chunks to attempt
 * @returns {Promise<{ statusCode: number, headers: http.IncomingHttpHeaders, body: string, sentBytes: number }>}
 */
async function sendChunked({
  serverUrl,
  requestPath,
  headers,
  chunk,
  chunkCount
}: {
  serverUrl: string
  requestPath: string
  headers: Record<string, string>
  chunk: Buffer
  chunkCount: number
}): Promise<{
  statusCode: number
  headers: http.IncomingHttpHeaders
  body: string
  sentBytes: number
}> {
  const url = new URL(requestPath, serverUrl)
  let sentBytes = 0
  let stopped = false
  const request = http.request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'PUT',
    headers
  })
  request.on('error', () => {
    // The server closes the connection with the refusal; further writes fail.
    stopped = true
  })

  const answered = new Promise<{
    statusCode: number
    headers: http.IncomingHttpHeaders
    body: string
  }>((resolve, reject) => {
    request.on('response', response => {
      stopped = true
      let body = ''
      response.setEncoding('utf8')
      response.on('data', part => {
        body += part
      })
      response.on('end', () =>
        resolve({
          statusCode: response.statusCode!,
          headers: response.headers,
          body
        })
      )
    })
    request.on('error', err => {
      // Only a failure with no response at all is a test failure.
      setTimeout(() => reject(err), 500)
    })
  })

  for (let index = 0; index < chunkCount && !stopped; index++) {
    if (!request.write(chunk)) {
      try {
        await once(request, 'drain')
      } catch {
        stopped = true
        break
      }
    }
    sentBytes += chunk.byteLength
  }
  if (!stopped) {
    request.end()
  }
  const { statusCode, headers: responseHeaders, body } = await answered
  return { statusCode, headers: responseHeaders, body, sentBytes }
}

describe('Buffered body limit', () => {
  let fastify: FastifyInstance, serverUrl: string, dataDir: string
  let alice: any
  const spaceId = `body-limit-${crypto.randomUUID()}`
  const collectionId = 'credentials'

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({
        dataDir,
        maxUploadBytes: MAX_UPLOAD_BYTES
      })
    }))
    ;({ alice } = await zcapClients({ serverUrl }))

    const space = await alice.was.createSpace({
      id: spaceId,
      name: 'Body Limit Space',
      controller: alice.did
    })
    await space.createCollection({ id: collectionId, name: 'Credentials' })
  })

  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('refuses a chunked over-limit JSON body with 413, unread', async () => {
    const chunk = Buffer.alloc(64 * 1024, 'x')
    // 64 MiB of body against a 64 KiB limit: a server that buffered it would
    // read every byte.
    const chunkCount = 1024
    const target = `${serverUrl}/space/${spaceId}/${collectionId}/chunked`
    const { statusCode, headers, body, sentBytes } = await sendChunked({
      serverUrl,
      requestPath: `/space/${spaceId}/${collectionId}/chunked`,
      headers: {
        authorization: placeholderAuthHeader(),
        'capability-invocation': rootInvocation({ target }),
        'content-type': 'application/json',
        digest: digestHeaderFor('{}'),
        'transfer-encoding': 'chunked'
      },
      chunk,
      chunkCount
    })
    assert.equal(statusCode, 413)
    assert.match(JSON.parse(body).type, /payload-too-large/)
    // The unread rest is still coming, so the connection is not kept alive.
    assert.equal(headers.connection, 'close')
    // The server stopped reading: what got out is what the socket buffers held
    // when it did, a small fraction of the 64 MiB the client offered.
    assert.ok(
      sentBytes < (chunkCount * chunk.byteLength) / 4,
      `expected the server to stop reading early, sent ${sentBytes} bytes`
    )
  })

  it('refuses a chunked over-limit text/jsonl log body with 413, unread', async () => {
    // `text/jsonl` reaches the catch-all parser, not a buffering one, so the
    // bound is the hook's alone: the refusal is still raised there, before
    // the signature is verified, not later from the handler.
    const chunk = Buffer.alloc(64 * 1024, 'x')
    const chunkCount = 1024
    const requestPath = `/space/${spaceId}/${collectionId}/meta/log`
    const { statusCode, headers, body, sentBytes } = await sendChunked({
      serverUrl,
      requestPath,
      headers: {
        authorization: placeholderAuthHeader(),
        'capability-invocation': rootInvocation({
          target: `${serverUrl}${requestPath}`
        }),
        'content-type': 'text/jsonl',
        digest: digestHeaderFor('{}'),
        'transfer-encoding': 'chunked'
      },
      chunk,
      chunkCount
    })
    assert.equal(statusCode, 413)
    assert.match(JSON.parse(body).type, /payload-too-large/)
    assert.equal(headers.connection, 'close')
    assert.ok(
      sentBytes < (chunkCount * chunk.byteLength) / 4,
      `expected the server to stop reading early, sent ${sentBytes} bytes`
    )
  })

  it('refuses an announced over-limit JSON body with 413', async () => {
    const payload = JSON.stringify({ id: 'big', blob: 'x'.repeat(200 * 1024) })
    const target = `${serverUrl}/space/${spaceId}/${collectionId}/announced`
    const response = await fastify.inject({
      method: 'PUT',
      url: `/space/${spaceId}/${collectionId}/announced`,
      headers: {
        authorization: placeholderAuthHeader(),
        'capability-invocation': rootInvocation({ target }),
        'content-type': 'application/json',
        digest: digestHeaderFor(payload)
      },
      payload
    })
    assert.equal(response.statusCode, 413)
    assert.equal(response.headers.connection, 'close')
    const problem = response.json()
    assert.match(problem.type, /payload-too-large/)
    // The limit named is the backend's cap, which derived the route limit.
    assert.match(problem.errors[0].detail, new RegExp(`${MAX_UPLOAD_BYTES}`))
  })
})

describe('Buffered body limit (default cap)', () => {
  let fastify: FastifyInstance, serverUrl: string, dataDir: string
  let alice: any, aliceCredentials: any
  const spaceId = `body-limit-default-${crypto.randomUUID()}`

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    // No `maxUploadBytes`: the backend applies its default-on 64 MiB cap, and
    // the buffered-body limit follows it rather than Fastify's 1 MiB default.
    ;({ fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir })
    }))
    ;({ alice } = await zcapClients({ serverUrl }))

    const space = await alice.was.createSpace({
      id: spaceId,
      name: 'Default Cap Space',
      controller: alice.did
    })
    aliceCredentials = await space.createCollection({
      id: 'credentials',
      name: 'Credentials'
    })
  })

  afterAll(async () => {
    await fastify.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('accepts a 2 MiB JSON Resource write', async () => {
    const result = await aliceCredentials.put('big-json', {
      id: 'big-json',
      blob: 'x'.repeat(2 * 1024 * 1024)
    })
    assert.ok(result)
    const stored: any = await aliceCredentials.get('big-json')
    assert.equal(stored.blob.length, 2 * 1024 * 1024)
  })
})

describe('Buffered body limit (derivation)', () => {
  it('falls back to the default when the cap is unlimited', async () => {
    // A backend normalizes `Infinity` (an explicit `unlimited`) to `undefined`;
    // both shapes mean no cap, and a buffered body still needs a limit.
    assert.equal(bufferedBodyLimit(undefined), DEFAULT_MAX_UPLOAD_BYTES)
    assert.equal(bufferedBodyLimit(Infinity), DEFAULT_MAX_UPLOAD_BYTES)
    assert.equal(bufferedBodyLimit(4096), 4096)
    // Fastify requires a positive integer.
    assert.equal(bufferedBodyLimit(0), 1)
  })

  it('an unlimited backend cap still bounds a buffered body', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'was-test-'))
    const { fastify, serverUrl } = await startTestServer({
      backend: new FileSystemBackend({ dataDir, maxUploadBytes: Infinity })
    })
    try {
      assert.equal(fastify.storage.maxUploadBytes, undefined)
      // An announced body one byte over the default is refused before any of
      // it is read (the route exists whether or not the Space does), and the
      // refusal names the server's own limit, not a backend cap.
      const requestPath = '/space/no-such-space/credentials/announced'
      const { statusCode, body } = await sendChunked({
        serverUrl,
        requestPath,
        headers: {
          authorization: placeholderAuthHeader(),
          'capability-invocation': rootInvocation({
            target: `${serverUrl}${requestPath}`
          }),
          'content-type': 'application/json',
          digest: digestHeaderFor('{}'),
          'content-length': String(DEFAULT_MAX_UPLOAD_BYTES + 1)
        },
        chunk: Buffer.alloc(64 * 1024, 'x'),
        chunkCount: 4
      })
      assert.equal(statusCode, 413)
      const problem = JSON.parse(body)
      assert.match(problem.type, /payload-too-large/)
      assert.match(
        problem.errors[0].detail,
        new RegExp(`buffered request body limit of ${DEFAULT_MAX_UPLOAD_BYTES}`)
      )
    } finally {
      await fastify.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})

describe('Framework over-limit errors', () => {
  it("answers Fastify's body-too-large as payload-too-large", async () => {
    // Fastify raises this itself for any parser this server's hooks do not
    // bound (a route with its own `bodyLimit`); it carries a 413 but no
    // problem `type`, which the generic fallback would render as
    // `internal-error`.
    const error = Object.assign(new Error('Request body is too large'), {
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
      statusCode: 413
    })
    let sent: any
    const reply = {
      status() {
        return this
      },
      type() {
        return this
      },
      send(body: unknown) {
        sent = body
        return this
      },
      header() {
        return this
      }
    } as unknown as FastifyReply
    await handleError(error, {} as FastifyRequest, reply)
    assert.match(sent.type, /payload-too-large/)
    assert.match(sent.errors[0].detail, /buffered request body limit/)
  })
})
