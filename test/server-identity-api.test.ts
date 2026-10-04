/**
 * Server identity tests (Vitest): the `server` Space provisioned at boot
 * under the admin DID, the export-signing key derived from the seed and
 * advertised on `/service` as `instance.exportSigningKey`, and the
 * `instance.serverDid` member that
 * appears only once the admin's history log at `server/id/did.jsonl` lists
 * that key under `assertionMethod`, optionally beside `capabilityInvocation`
 * and under no other relationship. Also the boot-time checks on a
 * stored `server` Space, and the refusal of the `ServerInstanceSpace` subtype
 * on a client create.
 */
import { it, describe, beforeAll, afterAll, expect } from 'vitest'
import assert from 'node:assert'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import {
  createDID,
  logToJsonlString,
  updateDID
} from '@interop/did-method-webvh'
import type { DIDLog } from '@interop/did-method-webvh'

import { createApp } from '../src/server.js'
import { FileSystemBackend } from '../src/backends/filesystem.js'
import type { TempFileSystemBackend } from '../src/testing.js'
import {
  createServerSigningKey,
  signingKeyRelationshipProblem
} from '../src/lib/serverIdentity.js'
import {
  openTempBackend,
  requestError,
  startTestServer,
  wasClient,
  zcapClients,
  webvhLogSigner
} from './helpers.js'

/**
 * The admin identity: the `did:key` that controls the `server` Space and
 * holds the update key of the server's history log.
 */
async function adminIdentity({
  keyPair,
  serverUrl
}: {
  keyPair: Ed25519VerificationKey
  serverUrl: string
}) {
  const signer = keyPair.didKeySigner()
  const logSigner = webvhLogSigner({ keyPair })
  return {
    did: `did:key:${keyPair.publicKeyMultibase}`,
    keyPair,
    logSigner,
    was: wasClient({ signer, serverUrl })
  }
}

describe('Server identity', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    backend: TempFileSystemBackend,
    admin: Awaited<ReturnType<typeof adminIdentity>>,
    alice: any,
    seed: Uint8Array,
    exportSigningKey: string,
    serverKeyMultibase: string,
    log: DIDLog,
    did: string

  async function serviceEntry(): Promise<any> {
    const response = await fetch(`${serverUrl}/service`)
    assert.equal(response.status, 200)
    const document = (await response.json()) as any
    return { etag: response.headers.get('etag'), entry: document.instance }
  }

  async function publishLog(jsonl: string): Promise<Response> {
    return admin.was.request({
      path: '/space/server/id/did.jsonl',
      method: 'PUT',
      headers: { 'content-type': 'text/jsonl' },
      body: new Blob([jsonl], { type: 'text/jsonl' })
    })
  }

  beforeAll(async () => {
    backend = await openTempBackend({ prefix: 'was-server-identity-' })
    seed = randomBytes(32)
    // The admin key must exist before the server boots, since its DID is a
    // boot option, while the client needs the assigned `serverUrl`.
    const adminKeyPair = await Ed25519VerificationKey.generate()
    ;({ fastify, serverUrl } = await startTestServer({
      backend,
      serverKeySeed: seed,
      adminDid: `did:key:${adminKeyPair.publicKeyMultibase}`
    }))
    admin = await adminIdentity({ keyPair: adminKeyPair, serverUrl })
    ;({ alice } = await zcapClients({ serverUrl }))
    const signingKey = await createServerSigningKey({ seed })
    exportSigningKey = signingKey.exportSigningKey
    serverKeyMultibase = signingKey.keyPair.publicKeyMultibase
  })
  afterAll(async () => {
    await fastify.close()
  })

  describe('the `server` Space', () => {
    it('is provisioned at boot under the admin DID with the server subtype', async () => {
      const metadata = await admin.was.space('server').describe()
      assert.ok(metadata)
      assert.equal(metadata.controller, admin.did)
      assert.deepStrictEqual([...metadata.type].sort(), [
        'AuxiliarySpace',
        'ServerInstanceSpace',
        'Space'
      ])
    })

    it('is listed for the admin by List Spaces, with its type', async () => {
      const listing = await admin.was.listSpaces()
      assert.deepStrictEqual(listing.items, [
        {
          id: 'server',
          url: '/space/server/',
          type: ['AuxiliarySpace', 'ServerInstanceSpace', 'Space']
        }
      ])
      assert.equal(listing.totalItems, 1)
    })

    it('is reserved: Create Space naming the id is `reserved-id`', async () => {
      const err = await requestError(
        alice.was.request({
          url: `${serverUrl}/spaces/`,
          method: 'POST',
          json: { id: 'server', controller: alice.did }
        })
      )
      assert.equal(err.status, 409)
      assert.equal(err.data.type, 'https://w3id.org/pws#reserved-id')
      assert.match(err.data.errors[0].detail, /reserved for the server/)
    })

    it('cannot be rewritten by another client (the existing Space masks as 404)', async () => {
      const err = await requestError(
        alice.was.request({
          url: `${serverUrl}/space/server/meta`,
          method: 'PUT',
          json: { controller: alice.did }
        })
      )
      assert.equal(err.status, 404)
    })

    it('refuses the ServerInstanceSpace subtype on a client create', async () => {
      for (const create of [
        () =>
          alice.was.request({
            url: `${serverUrl}/spaces/`,
            method: 'POST',
            json: {
              id: randomUUID(),
              controller: alice.did,
              type: ['AuxiliarySpace', 'ServerInstanceSpace', 'Space']
            }
          }),
        () =>
          alice.was.request({
            url: `${serverUrl}/space/${randomUUID()}/meta`,
            method: 'PUT',
            json: {
              controller: alice.did,
              type: ['AuxiliarySpace', 'ServerInstanceSpace', 'Space']
            }
          })
      ]) {
        const err = await requestError(create())
        assert.equal(err.status, 400)
        assert.equal(err.data.type, 'https://w3id.org/pws#invalid-request-body')
        assert.equal(err.data.errors[0].pointer, '#/type')
        assert.match(err.data.errors[0].detail, /ServerInstanceSpace/)
      }
    })

    it('the admin can still update it, restating its stored type', async () => {
      const response = await admin.was.request({
        url: `${serverUrl}/space/server/meta`,
        method: 'PUT',
        json: {
          controller: admin.did,
          type: ['AuxiliarySpace', 'ServerInstanceSpace', 'Space'],
          name: 'Server identity'
        }
      })
      assert.equal(response.status, 204)
      const metadata = await admin.was.space('server').describe()
      assert.ok(metadata)
      assert.equal(metadata.name, 'Server identity')
    })
  })

  describe('the export-signing key', () => {
    it('is derived deterministically from the seed', async () => {
      const again = await createServerSigningKey({ seed })
      assert.equal(again.exportSigningKey, exportSigningKey)
      assert.match(exportSigningKey, /^did:key:z6Mk/)
    })

    it('is advertised on /service before any log exists, with no `did`', async () => {
      const { entry } = await serviceEntry()
      assert.equal(entry.exportSigningKey, exportSigningKey)
      assert.equal(entry.serverDid, undefined)
    })
  })

  describe('the server DID', () => {
    let etagBefore: string | null

    beforeAll(async () => {
      ;({ etag: etagBefore } = await serviceEntry())
      await admin.was
        .space('server')
        .collection('id')
        .configure({ force: true })
    })

    it('appears on /service as instance.serverDid once the admin publishes a log listing the key under assertionMethod', async () => {
      const created = await createDID({
        address: `${serverUrl}/space/server/id`,
        signer: admin.logSigner,
        updateKeys: [admin.keyPair.publicKeyMultibase!],
        vmIdFragment: 'multibase',
        portable: true,
        verificationMethods: [
          {
            type: 'Multikey',
            publicKeyMultibase: serverKeyMultibase,
            purpose: ['assertionMethod']
          }
        ] as any
      })
      log = created.log
      did = created.did
      assert.match(did, /^did:webvh:[^:]+:localhost%3A\d+:space:server:id$/)

      const published = await publishLog(logToJsonlString(log))
      assert.equal(published.status, 204)

      const { entry, etag } = await serviceEntry()
      assert.equal(entry.serverDid, did)
      assert.equal(entry.exportSigningKey, exportSigningKey)
      assert.notEqual(etag, etagBefore)
    })

    it('stays advertised when a log entry adds capabilityInvocation', async () => {
      const updated = await updateDID({
        log,
        signer: admin.logSigner,
        vmIdFragment: 'multibase',
        verificationMethods: [
          {
            type: 'Multikey',
            publicKeyMultibase: serverKeyMultibase,
            purpose: ['assertionMethod', 'capabilityInvocation']
          }
        ] as any
      })
      const published = await publishLog(logToJsonlString(updated.log))
      assert.equal(published.status, 204)
      log = updated.log

      const { entry } = await serviceEntry()
      assert.equal(entry.serverDid, did)
    })

    it('is withdrawn when a log entry lists the key under a refused relationship too', async () => {
      const updated = await updateDID({
        log,
        signer: admin.logSigner,
        vmIdFragment: 'multibase',
        verificationMethods: [
          {
            type: 'Multikey',
            publicKeyMultibase: serverKeyMultibase,
            purpose: [
              'assertionMethod',
              'capabilityInvocation',
              'capabilityDelegation'
            ]
          }
        ] as any
      })
      const published = await publishLog(logToJsonlString(updated.log))
      assert.equal(published.status, 204)
      log = updated.log

      const { entry } = await serviceEntry()
      assert.equal(entry.serverDid, undefined)
      assert.equal(entry.exportSigningKey, exportSigningKey)
    })

    it('returns once a later entry drops the refused relationship', async () => {
      const updated = await updateDID({
        log,
        signer: admin.logSigner,
        vmIdFragment: 'multibase',
        verificationMethods: [
          {
            type: 'Multikey',
            publicKeyMultibase: serverKeyMultibase,
            purpose: ['assertionMethod']
          }
        ] as any
      })
      const published = await publishLog(logToJsonlString(updated.log))
      assert.equal(published.status, 204)
      log = updated.log

      const { entry } = await serviceEntry()
      assert.equal(entry.serverDid, did)
    })

    it('is withdrawn when the key is rotated out of the document', async () => {
      const other = await Ed25519VerificationKey.generate()
      const updated = await updateDID({
        log,
        signer: admin.logSigner,
        vmIdFragment: 'multibase',
        verificationMethods: [
          {
            type: 'Multikey',
            publicKeyMultibase: other.publicKeyMultibase!,
            purpose: ['assertionMethod']
          }
        ] as any
      })
      const published = await publishLog(logToJsonlString(updated.log))
      assert.equal(published.status, 204)
      log = updated.log

      const { entry } = await serviceEntry()
      assert.equal(entry.serverDid, undefined)
    })
  })
})

describe('signingKeyRelationshipProblem', () => {
  const key = 'z6MkServerKey'
  const did = 'did:webvh:scid:localhost:space:server:id'

  /**
   * A document listing the key, as method `#k1`, under `relationships`.
   */
  function docUnder(relationships: string[]): any {
    const doc: Record<string, unknown> = {
      id: did,
      verificationMethod: [{ id: `${did}#k1`, publicKeyMultibase: key }]
    }
    for (const relationship of relationships) {
      doc[relationship] = [`${did}#k1`]
    }
    return doc
  }

  it('accepts the key under assertionMethod alone', () => {
    assert.equal(
      signingKeyRelationshipProblem({
        doc: docUnder(['assertionMethod']),
        publicKeyMultibase: key
      }),
      undefined
    )
  })

  it('accepts the key under assertionMethod and capabilityInvocation', () => {
    assert.equal(
      signingKeyRelationshipProblem({
        doc: docUnder(['assertionMethod', 'capabilityInvocation']),
        publicKeyMultibase: key
      }),
      undefined
    )
  })

  it('refuses capabilityInvocation without assertionMethod', () => {
    assert.match(
      signingKeyRelationshipProblem({
        doc: docUnder(['capabilityInvocation']),
        publicKeyMultibase: key
      })!,
      /does not list the export-signing key under "assertionMethod"/
    )
  })

  for (const refused of [
    'capabilityDelegation',
    'authentication',
    'keyAgreement'
  ]) {
    it(`refuses ${refused}, with or without capabilityInvocation`, () => {
      for (const relationships of [
        ['assertionMethod', refused],
        ['assertionMethod', 'capabilityInvocation', refused]
      ]) {
        const problem = signingKeyRelationshipProblem({
          doc: docUnder(relationships),
          publicKeyMultibase: key
        })
        assert.ok(problem, `${relationships.join(', ')} is refused`)
        // Only the refused relationship is named as the problem.
        assert.ok(problem.includes(`under "${refused}";`), problem)
      }
    })
  }

  it('reads every method carrying the key, not just the first', () => {
    const doc = {
      id: did,
      verificationMethod: [
        { id: `${did}#k1`, publicKeyMultibase: key },
        { id: `${did}#k2`, publicKeyMultibase: key }
      ],
      assertionMethod: [`${did}#k1`],
      authentication: [`${did}#k2`]
    } as any
    assert.match(
      signingKeyRelationshipProblem({ doc, publicKeyMultibase: key })!,
      /"authentication"/
    )
  })

  it('reads a method embedded in a relationship by its key', () => {
    const doc = {
      id: did,
      verificationMethod: [{ id: `${did}#k1`, publicKeyMultibase: key }],
      assertionMethod: [`${did}#k1`],
      capabilityDelegation: [
        { id: `${did}#embedded`, type: 'Multikey', publicKeyMultibase: key }
      ]
    } as any
    assert.match(
      signingKeyRelationshipProblem({ doc, publicKeyMultibase: key })!,
      /"capabilityDelegation"/
    )
  })

  it('names the key as unlisted when no method carries it', () => {
    const doc = {
      id: did,
      verificationMethod: [
        { id: `${did}#k1`, publicKeyMultibase: 'z6MkOther' }
      ],
      assertionMethod: [`${did}#k1`]
    } as any
    assert.match(
      signingKeyRelationshipProblem({ doc, publicKeyMultibase: key })!,
      /no verification method/
    )
  })
})

describe('Server identity without a seed', () => {
  let fastify: FastifyInstance,
    serverUrl: string,
    backend: TempFileSystemBackend

  beforeAll(async () => {
    backend = await openTempBackend({ prefix: 'was-server-identity-' })
    ;({ fastify, serverUrl } = await startTestServer({
      backend
    }))
  })
  afterAll(async () => {
    await fastify.close()
  })

  it('serves neither identity member', async () => {
    const response = await fetch(`${serverUrl}/service`)
    const document = (await response.json()) as any
    assert.equal('exportSigningKey' in document.instance, false)
    assert.equal('serverDid' in document.instance, false)
  })

  it('does not provision the `server` Space, and still reserves the id', async () => {
    const { alice } = await zcapClients({ serverUrl })
    const read = await requestError(
      alice.was.request({
        url: `${serverUrl}/space/server/meta`,
        method: 'GET'
      })
    )
    assert.equal(read.status, 404)
    const create = await requestError(
      alice.was.request({
        url: `${serverUrl}/space/server/meta`,
        method: 'PUT',
        json: { controller: alice.did }
      })
    )
    assert.equal(create.status, 409)
    assert.equal(create.data.type, 'https://w3id.org/pws#reserved-id')
  })
})

describe('Server identity boot checks', () => {
  let dataDir: string

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'was-server-identity-'))
  })
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('refuses to boot over a `server` Space that lacks the subtype', async () => {
    // Written straight into storage: the request layer refuses the id, so
    // such a Space can only predate the reservation.
    const backend = await FileSystemBackend.open({ dataDir })
    await backend.writeSpace({
      spaceId: 'server',
      spaceMetadata: {
        id: 'server',
        type: ['Space'],
        controller: 'did:key:z6Mkud27oH7SyTr495b67UgZ6tFmA72egaxyte23ygpUfEvD'
      }
    })

    const admin = await Ed25519VerificationKey.generate()
    const app = createApp({
      logger: false,
      serverUrl: 'http://localhost',
      backend: await FileSystemBackend.open({ dataDir }),
      adminDid: `did:key:${admin.publicKeyMultibase}`
    })
    await expect(app.ready()).rejects.toThrow(/not typed "ServerInstanceSpace"/)
    await app.close()
  })

  it('converges when another instance creates the `server` Space first', async () => {
    const ownDir = await mkdtemp(path.join(tmpdir(), 'was-server-identity-'))
    try {
      const admin = await Ed25519VerificationKey.generate()
      const adminDid = `did:key:${admin.publicKeyMultibase}` as const
      const winner = createApp({
        logger: false,
        serverUrl: 'http://localhost',
        backend: await FileSystemBackend.open({ dataDir: ownDir }),
        adminDid
      })
      await winner.ready()
      await winner.close()

      // The loser's pre-create read saw no Space (the winner had not written
      // yet), so its guarded create loses; it must re-read and pass.
      const backend = await FileSystemBackend.open({ dataDir: ownDir })
      const read = backend.getSpaceMetadata.bind(backend)
      let firstRead = true
      backend.getSpaceMetadata = async options => {
        if (firstRead && options.spaceId === 'server') {
          firstRead = false
          return undefined
        }
        return read(options)
      }
      const loser = createApp({
        logger: false,
        serverUrl: 'http://localhost',
        backend,
        adminDid
      })
      await loser.ready()
      assert.equal(firstRead, false)
      await loser.close()
    } finally {
      await rm(ownDir, { recursive: true, force: true })
    }
  })

  it('names WAS_ADMIN_DID when the Space count quota refuses the create', async () => {
    const backend = await openTempBackend({
      prefix: 'was-server-identity-',
      maxSpacesPerController: 0
    })
    try {
      const admin = await Ed25519VerificationKey.generate()
      const app = createApp({
        logger: false,
        serverUrl: 'http://localhost',
        backend,
        adminDid: `did:key:${admin.publicKeyMultibase}`
      })
      await expect(app.ready()).rejects.toThrow(
        /WAS_ADMIN_DID .* Spaces per controller limit is 0/
      )
      await app.close()
    } finally {
      await backend.close()
    }
  })

  it('refuses to boot when the admin DID no longer matches the stored controller', async () => {
    const ownDir = await mkdtemp(path.join(tmpdir(), 'was-server-identity-'))
    try {
      const first = await Ed25519VerificationKey.generate()
      const app = createApp({
        logger: false,
        serverUrl: 'http://localhost',
        backend: await FileSystemBackend.open({ dataDir: ownDir }),
        adminDid: `did:key:${first.publicKeyMultibase}`
      })
      await app.ready()
      await app.close()

      const second = await Ed25519VerificationKey.generate()
      const again = createApp({
        logger: false,
        serverUrl: 'http://localhost',
        backend: await FileSystemBackend.open({ dataDir: ownDir }),
        adminDid: `did:key:${second.publicKeyMultibase}`
      })
      await expect(again.ready()).rejects.toThrow(/WAS_ADMIN_DID/)
      await again.close()
    } finally {
      await rm(ownDir, { recursive: true, force: true })
    }
  })
})
