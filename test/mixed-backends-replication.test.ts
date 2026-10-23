/**
 * Replication of a Collection that selects a non-default server backend.
 * Two servers booted in one process, each with a filesystem data dir as the
 * default and a Postgres schema beside it, replicate a Collection whose
 * `backend.id` is `postgres`: the pull loop applies its Resources to the
 * replica's Postgres backend, with the Collection Metadata object, the
 * policies and the registration on the control plane. A third server with
 * no Postgres stalls that Collection as `unsupported-backend`.
 *
 * The servers never listen; a peer server's DID must name a host with no
 * port. Requests reach each server through `fastify.inject`, and each pull
 * loop reaches its peer through the plugin's `peerFetch` option, as in
 * replication-api.test.ts.
 *
 * OPT-IN: requires a disposable Postgres reachable via `WAS_TEST_DATABASE_URL`
 * (the README's "Storage Backends" section has a one-liner); skipped with a
 * visible notice when unset. Each server runs in a throwaway `was_test_<hex>`
 * schema, dropped on cleanup.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

import type { PostgresBackend } from '../src/backends/postgres.js'
import { createApp } from '../src/server.js'
import type { PeerFetch } from '../src/sync/peerFetch.js'
import type { TempFileSystemBackend } from '../src/testing.js'
import type { IDID } from '../src/types.js'
import {
  injectPeerFetch,
  openTempBackend,
  openTempPostgres,
  provisionServerIdentity,
  registerReplica,
  replicaStatus,
  signedInject,
  zcapClients
} from './helpers.js'

const connectionString = process.env.WAS_TEST_DATABASE_URL

/**
 * One server: its app, its backends, and its own DID.
 */
interface Server {
  serverUrl: string
  fastify: FastifyInstance
  fs: TempFileSystemBackend
  pg?: PostgresBackend
  dropSchema?: () => Promise<void>
  did: string
  didLog: string
}

const servers = new Map<string, Server>()

/**
 * Runs before each read a pull loop makes of a peer; a test sets it to act
 * between two reads of one cycle.
 */
let beforePeerRead: ((url: string) => Promise<void>) | undefined

const injected = injectPeerFetch(servers)
const peerFetch: PeerFetch = async request => {
  await beforePeerRead?.(request.url)
  return injected(request)
}

/**
 * Boots one server with an identity whose key may invoke, so it can pull.
 * With `postgres`, a Postgres schema is opened beside the filesystem default
 * under the same origin id.
 */
async function boot({
  serverUrl,
  postgres
}: {
  serverUrl: string
  postgres: boolean
}): Promise<Server> {
  const fs = await openTempBackend({ prefix: 'was-mixed-replication-' })
  const opened = postgres
    ? await openTempPostgres({ originId: fs.originId })
    : undefined
  const seed = randomBytes(32)
  const { did, didLog } = await provisionServerIdentity({
    backend: fs,
    serverUrl,
    seed,
    purpose: ['assertionMethod', 'capabilityInvocation']
  })
  const fastify = createApp({
    serverUrl,
    backends: opened === undefined ? [fs] : [fs, opened.backend],
    // The server identity above was written to the filesystem backend.
    controlPlaneBackend: 'fs',
    logger: false,
    serverKeySeed: seed,
    peerFetch,
    peerLogFetcher: async ({ url }) => {
      const peer = servers.get(new URL(url).origin)
      if (peer === undefined) {
        throw new Error(`No test server at ${url}.`)
      }
      return Buffer.from(peer.didLog)
    }
  })
  await fastify.ready()
  fastify.replication.pause()
  const server: Server = {
    serverUrl,
    fastify,
    fs,
    pg: opened?.backend,
    dropSchema: opened?.dropSchema,
    did,
    didLog
  }
  servers.set(serverUrl, server)
  return server
}

describe.skipIf(!connectionString)(
  'Replication into a Collection on a non-default server backend',
  () => {
    let source: Server, replica: Server, fsOnly: Server
    let alice: { did: string; signer: any }

    async function call({
      signer = alice.signer,
      ...request
    }: Omit<Parameters<typeof signedInject>[0], 'signer'> & {
      signer?: any
    }) {
      return signedInject({ signer, ...request })
    }

    async function createSpace({
      server,
      spaceId
    }: {
      server: Server
      spaceId: string
    }): Promise<void> {
      await server.fs.writeSpace({
        spaceId,
        spaceMetadata: {
          id: spaceId,
          type: ['Space'],
          controller: alice.did as IDID
        }
      })
    }

    /**
     * Registers `from`'s Space as the source of `to`'s, as Alice, and
     * asserts the registration was created.
     */
    async function register(
      options: Omit<
        Parameters<typeof registerReplica>[0],
        'signer' | 'delegator'
      >
    ) {
      const created = await registerReplica({
        signer: alice.signer,
        delegator: alice,
        ...options
      })
      assert.equal(created.statusCode, 201, created.payload)
    }

    async function pull({
      server,
      spaceId,
      replicaId = 'peer'
    }: {
      server: Server
      spaceId: string
      replicaId?: string
    }): Promise<void> {
      await server.fastify.replication.pullNow({ spaceId, replicaId })
    }

    /**
     * Reads a registration's status, as Alice.
     */
    async function statusOf(
      options: Omit<Parameters<typeof replicaStatus>[0], 'signer'>
    ) {
      return replicaStatus({ signer: alice.signer, ...options })
    }

    /**
     * Which of a server's backends hold a live Resource, by its `/meta`
     * record.
     */
    async function heldOn({
      server,
      spaceId,
      resourceId
    }: {
      server: Server
      spaceId: string
      resourceId: string
    }): Promise<{ fs: boolean; pg: boolean }> {
      const key = { spaceId, collectionId: 'docs', resourceId }
      return {
        fs: (await server.fs.getResourceMetadata(key)) !== undefined,
        pg: (await server.pg!.getResourceMetadata(key)) !== undefined
      }
    }

    const binary = Buffer.from([0, 1, 2, 3, 250, 251, 252])

    beforeAll(async () => {
      ;({ alice } = await zcapClients({ serverUrl: 'https://unused.example' }))
      source = await boot({
        serverUrl: 'https://source.example',
        postgres: true
      })
      replica = await boot({
        serverUrl: 'https://replica.example',
        postgres: true
      })
      fsOnly = await boot({
        serverUrl: 'https://fs-only.example',
        postgres: false
      })

      await createSpace({ server: source, spaceId: 'home' })
      const collection = await call({
        server: source,
        path: '/space/home/',
        method: 'POST',
        json: { id: 'docs', name: 'Docs', backend: { id: 'postgres' } }
      })
      assert.equal(collection.statusCode, 201, collection.payload)
      await call({
        server: source,
        path: '/space/home/docs/hello',
        method: 'PUT',
        json: { hello: 'world' }
      })
      await call({
        server: source,
        path: '/space/home/docs/hello/meta',
        method: 'PUT',
        json: { custom: { name: 'Greeting' } }
      })
      await call({
        server: source,
        path: '/space/home/docs/blob',
        method: 'PUT',
        body: binary,
        contentType: 'application/octet-stream'
      })
      await call({
        server: source,
        path: '/space/home/docs/policy',
        method: 'PUT',
        json: { type: 'PublicCanRead' }
      })

      await createSpace({ server: replica, spaceId: 'mirror' })
      await register({
        to: replica,
        toSpaceId: 'mirror',
        from: source,
        fromSpaceId: 'home'
      })
      await pull({ server: replica, spaceId: 'mirror' })
    })

    afterAll(async () => {
      for (const server of [source, replica, fsOnly]) {
        await server?.fastify.close()
        await server?.dropSchema?.()
      }
    })

    it('stores the Collection on the control plane under the peer selection', async () => {
      const copy = await call({
        server: replica,
        path: '/space/mirror/docs/meta'
      })
      assert.equal(copy.statusCode, 200, copy.payload)
      assert.deepStrictEqual(copy.json().backend, { id: 'postgres' })
      const held = await replica.fs.getCollectionMetadata({
        spaceId: 'mirror',
        collectionId: 'docs'
      })
      assert.deepStrictEqual(held?.backend, { id: 'postgres' })
      // The Postgres backend holds its copy, under its own stamp.
      assert.ok(
        await replica.pg!.getCollectionMetadata({
          spaceId: 'mirror',
          collectionId: 'docs'
        })
      )
    })

    it('applies the Resources to the Postgres backend alone', async () => {
      for (const resourceId of ['hello', 'blob']) {
        assert.deepStrictEqual(
          await heldOn({ server: source, spaceId: 'home', resourceId }),
          { fs: false, pg: true },
          `${resourceId} on the source`
        )
        assert.deepStrictEqual(
          await heldOn({ server: replica, spaceId: 'mirror', resourceId }),
          { fs: false, pg: true },
          `${resourceId} on the replica`
        )
      }
    })

    it('serves the same bytes, ETag and /meta object from the replica', async () => {
      for (const resourceId of ['hello', 'blob']) {
        const original = await call({
          server: source,
          path: `/space/home/docs/${resourceId}`
        })
        const copy = await call({
          server: replica,
          path: `/space/mirror/docs/${resourceId}`
        })
        assert.equal(copy.statusCode, 200, copy.payload)
        assert.ok(copy.rawPayload.equals(original.rawPayload), resourceId)
        assert.equal(copy.headers.etag, original.headers.etag)

        const originalMeta = await call({
          server: source,
          path: `/space/home/docs/${resourceId}/meta`
        })
        const copyMeta = await call({
          server: replica,
          path: `/space/mirror/docs/${resourceId}/meta`
        })
        assert.deepStrictEqual(copyMeta.json(), originalMeta.json())
        assert.equal(copyMeta.json().originId, source.fs.originId)
      }
    })

    it('carries the Collection policy and reports the Collection synced', async () => {
      const anonymous = await replica.fastify.inject({
        url: '/space/mirror/docs/hello',
        headers: { host: 'replica.example' }
      })
      assert.equal(anonymous.statusCode, 200, anonymous.payload)
      assert.deepStrictEqual(anonymous.json(), { hello: 'world' })

      const status = await statusOf({ server: replica, spaceId: 'mirror' })
      assert.deepStrictEqual(
        status.collections.map(({ id, state }: any) => ({ id, state })),
        [{ id: 'docs', state: 'synced' }]
      )
    })

    it('lists the Resources in the feed the replica serves from Postgres', async () => {
      const feed = await call({
        server: replica,
        path: '/space/mirror/docs/query?profile=changes'
      })
      assert.equal(feed.statusCode, 200, feed.payload)
      const resources = feed
        .json()
        .documents.filter(({ kind }: any) => kind === 'resource')
        .map(({ id }: any) => id)
        .sort()
      assert.deepStrictEqual(resources, ['blob', 'hello'])
    })

    it('applies nothing on a second pull, then an update and a delete', async () => {
      const before = await statusOf({ server: replica, spaceId: 'mirror' })
      await pull({ server: replica, spaceId: 'mirror' })
      const after = await statusOf({ server: replica, spaceId: 'mirror' })
      assert.equal(
        after.collections[0].lastAppliedAt,
        before.collections[0].lastAppliedAt
      )

      await call({
        server: source,
        path: '/space/home/docs/hello',
        method: 'PUT',
        json: { hello: 'again' }
      })
      const deleted = await call({
        server: source,
        path: '/space/home/docs/blob',
        method: 'DELETE'
      })
      assert.equal(deleted.statusCode, 204, deleted.payload)
      await pull({ server: replica, spaceId: 'mirror' })

      const hello = await call({
        server: replica,
        path: '/space/mirror/docs/hello'
      })
      assert.deepStrictEqual(hello.json(), { hello: 'again' })
      const blob = await call({
        server: replica,
        path: '/space/mirror/docs/blob'
      })
      assert.equal(blob.statusCode, 404)
      assert.deepStrictEqual(
        await heldOn({
          server: replica,
          spaceId: 'mirror',
          resourceId: 'blob'
        }),
        { fs: false, pg: false }
      )
    })

    it('applies nothing once the registration is gone mid-cycle', async () => {
      await call({
        server: source,
        path: '/space/home/docs/late',
        method: 'PUT',
        json: { late: true }
      })
      // The registration is removed on the control plane while the cycle
      // reads the feed, after the cycle's own read of it, so the Resource
      // apply is what finds it gone.
      beforePeerRead = async url => {
        if (url.includes('profile=changes')) {
          beforePeerRead = undefined
          assert.ok(
            await replica.fs.deleteReplica({
              spaceId: 'mirror',
              replicaId: 'peer'
            })
          )
        }
      }
      try {
        await pull({ server: replica, spaceId: 'mirror' })
      } finally {
        beforePeerRead = undefined
      }
      assert.deepStrictEqual(
        await heldOn({
          server: replica,
          spaceId: 'mirror',
          resourceId: 'late'
        }),
        { fs: false, pg: false }
      )
      const status = await call({
        server: replica,
        path: '/space/mirror/replicas/peer/status'
      })
      assert.equal(status.statusCode, 404)
    })

    it('stalls on a server that does not configure the backend', async () => {
      await createSpace({ server: fsOnly, spaceId: 'mirror' })
      await register({
        to: fsOnly,
        toSpaceId: 'mirror',
        from: source,
        fromSpaceId: 'home'
      })
      await pull({ server: fsOnly, spaceId: 'mirror' })

      const status = await statusOf({ server: fsOnly, spaceId: 'mirror' })
      assert.equal(status.state, 'stalled')
      const [docs] = status.collections
      assert.equal(docs.id, 'docs')
      assert.equal(docs.state, 'stalled')
      assert.equal(docs.stall.reason, 'unsupported-backend')
      assert.match(docs.stall.detail, /"postgres"/)
      // Nothing of the Collection is stored.
      const meta = await call({
        server: fsOnly,
        path: '/space/mirror/docs/meta'
      })
      assert.equal(meta.statusCode, 404)
    })
  }
)
