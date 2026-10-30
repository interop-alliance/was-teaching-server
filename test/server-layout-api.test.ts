/**
 * Server layout tests (Vitest): the URL layout the spec's Server Discovery
 * section fixes under one base server URL, asserted against the
 * `baseServerUrl` that `startTestServer` returns. The service description's
 * `url` is `{base}service`, its `spaces` member is `{base}spaces/`, and a
 * Create Space `Location` is `{base}space/{id}/`.
 */
import { it, describe, beforeAll, afterAll, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

import type { TempFileSystemBackend } from '../src/testing.js'
import { openTempBackend, startTestServer, zcapClients } from './helpers.js'

describe('Server layout under the base server URL', () => {
  let fastify: FastifyInstance,
    baseServerUrl: string,
    backend: TempFileSystemBackend,
    alice: any

  beforeAll(async () => {
    backend = await openTempBackend({ prefix: 'was-layout-' })
    ;({ fastify, baseServerUrl } = await startTestServer({
      backend
    }))
    ;({ alice } = await zcapClients({ baseServerUrl }))
  })
  afterAll(async () => {
    await fastify.close()
  })

  it('returns the listen origin in canonical form', () => {
    expect(baseServerUrl).toBe(`${fastify.serverUrl}/`)
  })

  it('serves the service description at {base}service', async () => {
    const response = await fetch(`${baseServerUrl}service`)
    expect(response.status).toBe(200)
    const description = (await response.json()) as any
    expect(description.url).toBe(`${baseServerUrl}service`)
    expect(description.specs['https://w3id.org/pws'][0].spaces).toBe(
      `${baseServerUrl}spaces/`
    )
  })

  it('names a created Space at {base}space/{id}/', async () => {
    const spaceId = randomUUID()
    const response = await alice.was.request({
      url: `${baseServerUrl}spaces/`,
      method: 'POST',
      json: { id: spaceId, controller: alice.did }
    })
    expect(response.status).toBe(201)
    expect(response.headers.get('location')).toBe(
      `${baseServerUrl}space/${spaceId}/`
    )

    // The client built from the base opens the same Space by id.
    const space = alice.was.space(spaceId)
    expect(space.url).toBe(`${baseServerUrl}space/${spaceId}/`)
    expect(alice.was.spaceAt(response.headers.get('location')).url).toBe(
      space.url
    )
  })
})
