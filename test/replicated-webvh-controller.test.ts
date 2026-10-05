/**
 * A `did:webvh` controller minted on one server resolves on a replica of its
 * log's Space, from the replica's own copy of the log (Vitest).
 *
 * The DID is `did:webvh:<scid>:origin.example:space:acct:id`, its log the
 * `did.jsonl` Resource of Collection `id` in Space `acct` on
 * `https://origin.example`. Space `acct-copy` on `https://mirror.example`
 * registers `https://origin.example/space/acct/` as its source, so the mirror
 * keeps a copy of the log at `acct-copy/id/did.jsonl` and resolves the DID
 * from it, with no fetch.
 *
 * Both servers are booted in one process and never listen, as in
 * `replication-api.test.ts`: a peer DID must name a host with no port.
 * Requests reach each through `fastify.inject`, the pull loops reach the other
 * through the plugin's `peerFetch` option, and every pull is run by hand.
 * The `peerLogFetcher` counts every network resolution, which a DID with a
 * stored copy must never cause.
 */
import { it, describe, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  createDID,
  logToJsonlString,
  updateDID
} from '@interop/did-method-webvh'
import type { DIDLog, Signer } from '@interop/did-method-webvh'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { ProblemTypes } from '@interop/storage-core'

import { invalidateReplicaIndex } from '../src/lib/webvhLogLocation.js'
import { createApp } from '../src/server.js'
import type { TempFileSystemBackend } from '../src/testing.js'
import type { IDID } from '../src/types.js'
import {
  bareDidKeyOf,
  bindKey,
  delegate,
  injectPeerFetch,
  openTempBackend,
  provisionServerIdentity,
  signedInject,
  webvhLogSigner,
  zcapClients
} from './helpers.js'

/**
 * One of the two servers.
 */
interface Server {
  serverUrl: string
  fastify: FastifyInstance
  backend: TempFileSystemBackend
  did: string
}

const servers = new Map<string, Server>()

/**
 * Each server's own history log, as its peer fetches it.
 */
const serverLogs = new Map<string, string>()

/**
 * Every URL a server asked its `peerLogFetcher` for, other than a peer
 * server's own log, which a pull's verification fetches. A DID with a stored
 * copy must never add one.
 */
const networkResolutions: string[] = []

/**
 * The pull loops' transport: the request goes to the app the URL names.
 */
const peerFetch = injectPeerFetch(servers)

/**
 * Boots one server with an identity that may invoke, so it can pull.
 * @param serverUrl {string}
 * @returns {Promise<Server>}
 */
async function boot(serverUrl: string): Promise<Server> {
  const backend = await openTempBackend({ prefix: 'was-replicated-webvh-' })
  const seed = randomBytes(32)
  const { did, didLog } = await provisionServerIdentity({
    backend,
    serverUrl,
    seed,
    purpose: ['assertionMethod', 'capabilityInvocation']
  })
  const fastify = createApp({
    serverUrl,
    backend,
    logger: false,
    serverKeySeed: seed,
    peerFetch,
    // A server fetches its peer's own log when it verifies the peer's pull.
    peerLogFetcher: async ({ url }) => {
      const log = serverLogs.get(url)
      if (log === undefined) {
        networkResolutions.push(url)
        throw new Error(`No log is served at ${url}.`)
      }
      return Buffer.from(log)
    }
  })
  await fastify.ready()
  fastify.replication.pause()
  const server = { serverUrl, fastify, backend, did }
  servers.set(serverUrl, server)
  serverLogs.set(`${serverUrl}/space/server/id/did.jsonl`, didLog)
  return server
}

/**
 * A verification method entry listing `keyPair` under every signing
 * relationship, in the shape `createDID` and `updateDID` take.
 * @param keyPair {Ed25519VerificationKey}
 * @returns {object}
 */
function clientMethod(keyPair: Ed25519VerificationKey) {
  return {
    type: 'Multikey',
    publicKeyMultibase: keyPair.publicKeyMultibase!,
    purpose: [
      'authentication',
      'assertionMethod',
      'capabilityInvocation',
      'capabilityDelegation'
    ]
  }
}

describe('A did:webvh controller resolved from a replicated log', () => {
  let origin: Server, mirror: Server
  let alice: { did: string; signer: any }
  let genesisKey: Ed25519VerificationKey
  let account: {
    did: string
    log: DIDLog
    logSigner: Signer
    key: Ed25519VerificationKey
  }

  /**
   * Sends one signed request. `capability` defaults to the root capability
   * of the Space the path is under.
   */
  async function call({
    signer = alice.signer,
    ...request
  }: Omit<Parameters<typeof signedInject>[0], 'signer'> & { signer?: any }) {
    return signedInject({ signer, ...request })
  }

  /**
   * Creates a Space under a `did:key`, Alice's by default, straight through
   * the backend.
   */
  async function createSpace(
    server: Server,
    spaceId: string,
    controller = alice.did
  ): Promise<void> {
    await server.backend.writeSpace({
      spaceId,
      spaceMetadata: {
        id: spaceId,
        type: ['Space'],
        controller: controller as IDID
      }
    })
  }

  /**
   * Creates a Collection under Alice's root capability.
   */
  async function createCollection(
    server: Server,
    spaceId: string,
    collectionId: string
  ): Promise<void> {
    const created = await call({
      server,
      path: `/space/${spaceId}/`,
      method: 'POST',
      json: { id: collectionId, name: collectionId }
    })
    assert.equal(created.statusCode, 201, created.payload)
  }

  /**
   * Writes a history log under Alice's root capability.
   */
  async function putLog({
    server,
    spaceId,
    collectionId = 'id',
    log,
    signer = alice.signer,
    capability
  }: {
    server: Server
    spaceId: string
    collectionId?: string
    log: DIDLog
    signer?: any
    capability?: any
  }) {
    return call({
      server,
      path: `/space/${spaceId}/${collectionId}/did.jsonl`,
      method: 'PUT',
      body: new TextEncoder().encode(logToJsonlString(log)),
      contentType: 'text/jsonl',
      signer,
      capability
    })
  }

  /**
   * Mints a `did:webvh` whose log lives at `<spaceId>/id` on the origin, and
   * publishes the log there. The document lists one client key under every
   * signing relationship, plus `extraMethods`.
   */
  async function mintOnOrigin(spaceId: string, extraMethods: object[] = []) {
    const updateKey = await Ed25519VerificationKey.generate()
    const logSigner = webvhLogSigner({ keyPair: updateKey })
    const key = await Ed25519VerificationKey.generate()
    const { did, log } = await createDID({
      address: `${origin.serverUrl}/space/${spaceId}/id`,
      signer: logSigner,
      updateKeys: [updateKey.publicKeyMultibase!],
      vmIdFragment: 'multibase',
      verificationMethods: [clientMethod(key), ...extraMethods] as any
    })
    const published = await putLog({ server: origin, spaceId, log })
    assert.equal(published.statusCode, 201, published.payload)
    return { did, log, logSigner, key: bindKey(key, did) }
  }

  /**
   * A registration body naming the origin's Space `fromSpaceId` as a source
   * of the mirror's Space `toSpaceId`. `delegator` signs the pull capability
   * from the peer Space's root, so it is that Space's controller key.
   */
  async function registration({
    toSpaceId,
    fromSpaceId,
    replicaId = 'origin',
    collections,
    delegator = alice.signer
  }: {
    toSpaceId: string
    fromSpaceId: string
    replicaId?: string
    collections?: string[]
    delegator?: any
  }) {
    const fromSpace = `${origin.serverUrl}/space/${fromSpaceId}/`
    const capability = await delegate({
      signer: delegator,
      capability: `urn:zcap:root:${encodeURIComponent(fromSpace)}`,
      invocationTarget: fromSpace,
      controller: mirror.did,
      allowedActions: ['GET']
    })
    return {
      id: replicaId,
      fromSpace,
      toSpace: `${mirror.serverUrl}/space/${toSpaceId}/`,
      capability,
      role: 'source' as const,
      ...(collections !== undefined && {
        collections: collections.map(id => ({ id }))
      })
    }
  }

  /**
   * Sends Register Replica for the origin's Space `fromSpaceId` as a source
   * of the mirror's Space `toSpaceId`, under the local Space's controller key
   * (`signer`, Alice's by default).
   */
  async function postRegistration({
    signer,
    ...options
  }: Parameters<typeof registration>[0] & { signer?: any }) {
    return call({
      server: mirror,
      path: `/space/${options.toSpaceId}/replicas`,
      method: 'POST',
      json: await registration(options),
      signer
    })
  }

  /**
   * Registers the origin's Space `fromSpaceId` as a source of the mirror's
   * Space `toSpaceId`.
   */
  async function register(options: Parameters<typeof postRegistration>[0]) {
    const created = await postRegistration(options)
    assert.equal(created.statusCode, 201, created.payload)
  }

  /**
   * Stores a registration straight through the backend, past the checks
   * Register Replica makes, as a second server process over the same store
   * could. Starts its pull loop.
   */
  async function registerUnchecked(
    options: Parameters<typeof registration>[0]
  ) {
    const record = await registration(options)
    await mirror.backend.createReplica({
      spaceId: options.toSpaceId,
      record: record as any
    })
    invalidateReplicaIndex({ storage: mirror.backend })
    mirror.fastify.replication.register({
      spaceId: options.toSpaceId,
      replicaId: record.id
    })
  }

  /**
   * Update Space on `server`, naming `controller`, under the Space's current
   * controller key (`signer`, Alice's by default).
   */
  async function promote(
    spaceId: string,
    controller: string,
    { server = mirror, signer }: { server?: Server; signer?: any } = {}
  ) {
    return call({
      server,
      path: `/space/${spaceId}/meta`,
      method: 'PUT',
      json: { name: spaceId, controller },
      signer
    })
  }

  /**
   * A root invocation on the mirror's Space `spaceId`, signed by `key`.
   */
  async function readAs(spaceId: string, key: Ed25519VerificationKey) {
    return call({
      server: mirror,
      path: `/space/${spaceId}/meta`,
      signer: key.signer()
    })
  }

  beforeAll(async () => {
    ;({ alice } = await zcapClients({ serverUrl: 'https://unused.example' }))
    origin = await boot('https://origin.example')
    mirror = await boot('https://mirror.example')

    await createSpace(origin, 'acct')
    await createCollection(origin, 'acct', 'id')
    account = await mintOnOrigin('acct')
    genesisKey = account.key
    assert.match(account.did, /^did:webvh:[^:]+:origin\.example:space:acct:id$/)

    // The mirror's copy carries another id than its source.
    await createSpace(mirror, 'acct-copy')
    await register({ toSpaceId: 'acct-copy', fromSpaceId: 'acct' })
    await mirror.fastify.replication.pullNow({
      spaceId: 'acct-copy',
      replicaId: 'origin'
    })
    await createSpace(mirror, 'data')
  })

  afterAll(async () => {
    await origin?.fastify.close()
    await mirror?.fastify.close()
  })

  it('keeps a byte-identical copy of the log', async () => {
    const original = await call({
      server: origin,
      path: '/space/acct/id/did.jsonl'
    })
    const copy = await call({
      server: mirror,
      path: '/space/acct-copy/id/did.jsonl'
    })
    assert.equal(copy.statusCode, 200, copy.payload)
    assert.ok(copy.rawPayload.equals(original.rawPayload))
  })

  it('promotes a mirror Space to the origin-hosted DID, and authorizes its key', async () => {
    const before = networkResolutions.length
    const promoted = await promote('data', account.did)
    assert.equal(promoted.statusCode, 204, promoted.payload)

    const read = await readAs('data', account.key)
    assert.equal(read.statusCode, 200, read.payload)
    assert.equal(read.json().controller, account.did)
    // Resolved from storage: nothing was fetched.
    assert.equal(networkResolutions.length, before)
  })

  it('records the replicated DID as createdBy', async () => {
    await call({
      server: mirror,
      path: '/space/data/',
      method: 'POST',
      json: { id: 'notes', name: 'notes' },
      signer: account.key.signer()
    })
    const written = await call({
      server: mirror,
      path: '/space/data/notes/first',
      method: 'PUT',
      json: { hello: 'mirror' },
      signer: account.key.signer()
    })
    assert.equal(written.statusCode, 201, written.payload)
    assert.equal(written.json().createdBy, account.did)
  })

  it('creates a Space by id under a chain the replicated DID invokes', async () => {
    const spaceUrl = `${mirror.serverUrl}/space/made-by-account/`
    const grant = await delegate({
      signer: alice.signer,
      capability: `urn:zcap:root:${encodeURIComponent(spaceUrl)}`,
      invocationTarget: spaceUrl,
      controller: account.did,
      allowedActions: ['PUT']
    })
    const created = await call({
      server: mirror,
      path: '/space/made-by-account/meta',
      method: 'PUT',
      json: { name: 'made', controller: alice.did },
      signer: account.key.signer(),
      capability: grant
    })
    assert.equal(created.statusCode, 201, created.payload)
    assert.equal(created.json().createdBy, account.did)
  })

  it('stops authorizing a key retired on the origin after the next pull', async () => {
    const retired = account.key
    // Warm the mirror's cached document.
    assert.equal((await readAs('data', retired)).statusCode, 200)

    const replacement = await Ed25519VerificationKey.generate()
    const updated = await updateDID({
      log: account.log,
      signer: account.logSigner,
      vmIdFragment: 'multibase',
      verificationMethods: [clientMethod(replacement)] as any
    })
    const appended = await putLog({
      server: origin,
      spaceId: 'acct',
      log: updated.log
    })
    assert.equal(appended.statusCode, 200, appended.payload)
    account.log = updated.log
    account.key = bindKey(replacement, account.did)

    // Until the mirror pulls, its copy still lists the retired key.
    assert.equal((await readAs('data', retired)).statusCode, 200)

    await mirror.fastify.replication.pullNow({
      spaceId: 'acct-copy',
      replicaId: 'origin'
    })
    const refused = await readAs('data', retired)
    assert.equal(refused.statusCode, 404)
    assert.equal(refused.json().type, ProblemTypes.NOT_FOUND)
    assert.equal((await readAs('data', account.key)).statusCode, 200)
  })

  it('takes an append to the copy on the mirror, the disaster-recovery path', async () => {
    const before = account.key
    assert.equal((await readAs('data', before)).statusCode, 200)
    const added = await Ed25519VerificationKey.generate()
    const updated = await updateDID({
      log: account.log,
      signer: account.logSigner,
      vmIdFragment: 'multibase',
      verificationMethods: [clientMethod(added)] as any
    })
    // The copy's Space is still Alice's, so her root capability writes it.
    const appended = await putLog({
      server: mirror,
      spaceId: 'acct-copy',
      log: updated.log
    })
    assert.equal(appended.statusCode, 200, appended.payload)
    account.log = updated.log
    account.key = bindKey(added, account.did)

    // The write dropped the cached document at once.
    assert.equal((await readAs('data', before)).statusCode, 404)
    assert.equal((await readAs('data', account.key)).statusCode, 200)

    // A rollback to the origin's shorter log is refused: it is not a
    // fast-forward of the copy.
    const rollback = await putLog({
      server: mirror,
      spaceId: 'acct-copy',
      log: account.log.slice(0, -1)
    })
    assert.equal(rollback.statusCode, 412, rollback.payload)
    // And the next pull skips the origin's log, a prefix of the copy.
    await mirror.fastify.replication.pullNow({
      spaceId: 'acct-copy',
      replicaId: 'origin'
    })
    assert.equal((await readAs('data', account.key)).statusCode, 200)
  })

  describe('a Space the origin promoted before it gained a replica', () => {
    let promoted: Awaited<ReturnType<typeof mintOnOrigin>>
    /**
     * The bare `did:key` of the account's client key, which the new local
     * Space is created under.
     */
    let local: { did: string; signer: any }
    /**
     * A key the account document lists under `capabilityDelegation` alone.
     */
    let delegationOnly: Ed25519VerificationKey

    /**
     * Sends Register Replica for the promoted Space as a source of the
     * mirror's Space `toSpaceId`, with the pull capability the account's key
     * delegates, invoked by `signer`.
     */
    async function postPromotedRegistration({
      toSpaceId,
      signer,
      collections
    }: {
      toSpaceId: string
      signer: any
      collections?: string[]
    }) {
      return postRegistration({
        toSpaceId,
        fromSpaceId: 'promoted',
        delegator: promoted.key.signer(),
        signer,
        collections
      })
    }

    beforeAll(async () => {
      await createSpace(origin, 'promoted')
      await createCollection(origin, 'promoted', 'id')
      delegationOnly = await Ed25519VerificationKey.generate()
      promoted = await mintOnOrigin('promoted', [
        {
          type: 'Multikey',
          publicKeyMultibase: delegationOnly.publicKeyMultibase!,
          purpose: ['capabilityDelegation']
        }
      ])
      local = bareDidKeyOf(promoted.key)
      const onOrigin = await promote('promoted', promoted.did, {
        server: origin
      })
      assert.equal(onOrigin.statusCode, 204, onOrigin.payload)
    })

    it('refuses a stranger holding the pull capability', async () => {
      // Alice's did:key is not in the account document.
      await createSpace(mirror, 'stranger-copy')
      const refused = await postPromotedRegistration({
        toSpaceId: 'stranger-copy',
        signer: alice.signer
      })
      assert.equal(refused.statusCode, 409, refused.payload)
      assert.equal(refused.json().type, ProblemTypes.REPLICA_REFUSED)
      assert.match(refused.json().errors[0].detail, /capabilityInvocation/)
    })

    it('refuses a key the document lists under capabilityDelegation alone', async () => {
      const bare = bareDidKeyOf(delegationOnly)
      await createSpace(mirror, 'delegation-only-copy', bare.did)
      const refused = await postPromotedRegistration({
        toSpaceId: 'delegation-only-copy',
        signer: bare.signer
      })
      assert.equal(refused.statusCode, 409, refused.payload)
      assert.match(refused.json().errors[0].detail, /capabilityInvocation/)
    })

    it('refuses a registration that does not pull the log Collection', async () => {
      await createSpace(mirror, 'partial-promoted-copy', local.did)
      const refused = await postPromotedRegistration({
        toSpaceId: 'partial-promoted-copy',
        signer: local.signer,
        collections: ['notes']
      })
      assert.equal(refused.statusCode, 409, refused.payload)
      assert.equal(refused.json().errors[0].pointer, '#/collections')
    })

    it('registers under a key of the document, pulls, and promotes the copy', async () => {
      const before = networkResolutions.length
      await createSpace(mirror, 'promoted-copy', local.did)
      await register({
        toSpaceId: 'promoted-copy',
        fromSpaceId: 'promoted',
        delegator: promoted.key.signer(),
        signer: local.signer
      })
      await mirror.fastify.replication.pullNow({
        spaceId: 'promoted-copy',
        replicaId: 'origin'
      })
      const copy = await call({
        server: mirror,
        path: '/space/promoted-copy/id/did.jsonl',
        signer: local.signer
      })
      assert.equal(copy.statusCode, 200, copy.payload)

      const onMirror = await promote('promoted-copy', promoted.did, {
        signer: local.signer
      })
      assert.equal(onMirror.statusCode, 204, onMirror.payload)
      const read = await readAs('promoted-copy', promoted.key)
      assert.equal(read.statusCode, 200, read.payload)
      assert.equal(read.json().controller, promoted.did)
      // The log was read through the pull capability, never fetched by DID.
      assert.equal(networkResolutions.length, before)
    })
  })

  describe('a promotion that would make a second holder of the log', () => {
    /**
     * A DID hosted in Collection `id` of the origin's Space `shared`.
     */
    let shared: Awaited<ReturnType<typeof mintOnOrigin>>

    beforeAll(async () => {
      await createSpace(origin, 'shared')
      await createCollection(origin, 'shared', 'id')
      await createCollection(origin, 'shared', 'notes')
      shared = await mintOnOrigin('shared')

      // Space `shared-a` pulls the log Collection, `shared-b` only `notes`.
      await createSpace(mirror, 'shared-a')
      await register({
        toSpaceId: 'shared-a',
        fromSpaceId: 'shared',
        collections: ['id']
      })
      await mirror.fastify.replication.pullNow({
        spaceId: 'shared-a',
        replicaId: 'origin'
      })
      await createSpace(mirror, 'shared-b')
      await register({
        toSpaceId: 'shared-b',
        fromSpaceId: 'shared',
        collections: ['notes']
      })
    })

    it('promotes a Space whose registration already pulls the log Collection', async () => {
      const promoted = await promote('shared-a', shared.did)
      assert.equal(promoted.statusCode, 204, promoted.payload)
      assert.equal((await readAs('shared-a', shared.key)).statusCode, 200)
    })

    it('refuses to promote a Space whose registration would then pull the log Collection too', async () => {
      const refused = await promote('shared-b', shared.did)
      assert.equal(refused.statusCode, 409, refused.payload)
      assert.equal(refused.json().type, ProblemTypes.REPLICA_REFUSED)
      const [problem] = refused.json().errors
      assert.equal(problem.pointer, '#/controller')
      assert.match(problem.detail, /Collection "id"/)
      assert.match(problem.detail, /Space "shared-a"/)

      // The Space stays under its did:key.
      const read = await call({ server: mirror, path: '/space/shared-b/meta' })
      assert.equal(read.statusCode, 200, read.payload)
      assert.equal(read.json().controller, alice.did)
      // And the DID still resolves from the one copy.
      assert.equal((await readAs('shared-a', shared.key)).statusCode, 200)
    })

    it('promotes a second Space that holds no registration of the peer Space', async () => {
      await createSpace(mirror, 'shared-c')
      const promoted = await promote('shared-c', shared.did)
      assert.equal(promoted.statusCode, 204, promoted.payload)
      assert.equal((await readAs('shared-c', shared.key)).statusCode, 200)
    })

    it('refuses a registration by a promoted Space, which always pulls its log Collection', async () => {
      // The registration lists `notes` alone, but under the promoted
      // controller it selects `id` too, which `shared-a` already pulls.
      const refused = await postRegistration({
        toSpaceId: 'shared-c',
        fromSpaceId: 'shared',
        collections: ['notes'],
        signer: shared.key.signer()
      })
      assert.equal(refused.statusCode, 409, refused.payload)
      assert.equal(refused.json().type, ProblemTypes.REPLICA_REFUSED)
      assert.match(refused.json().errors[0].detail, /Space "shared-a"/)
      assert.equal((await readAs('shared-a', shared.key)).statusCode, 200)
      assert.equal((await readAs('shared-c', shared.key)).statusCode, 200)
    })

    it('promotes a Space whose registrations pull another peer Space', async () => {
      await createSpace(origin, 'side')
      await createCollection(origin, 'side', 'notes')
      await createSpace(mirror, 'shared-d')
      await register({
        toSpaceId: 'shared-d',
        fromSpaceId: 'side',
        collections: ['notes']
      })
      const promoted = await promote('shared-d', shared.did)
      assert.equal(promoted.statusCode, 204, promoted.payload)
      assert.equal((await readAs('shared-d', shared.key)).statusCode, 200)
    })
  })

  describe('a controller change that would leave a Space with no copy', () => {
    /**
     * A DID hosted in Collection `id` of the origin's Space `held`.
     */
    let held: Awaited<ReturnType<typeof mintOnOrigin>>

    beforeAll(async () => {
      await createSpace(origin, 'held')
      await createCollection(origin, 'held', 'id')
      await createCollection(origin, 'held', 'notes')
      held = await mintOnOrigin('held')

      // Space `held-x` registers the peer Space twice: `log` pulls the log
      // Collection by name, `origin` only `notes`.
      await createSpace(mirror, 'held-x')
      await register({
        toSpaceId: 'held-x',
        fromSpaceId: 'held',
        replicaId: 'log',
        collections: ['id']
      })
      await register({
        toSpaceId: 'held-x',
        fromSpaceId: 'held',
        collections: ['notes']
      })
      await mirror.fastify.replication.pullNow({
        spaceId: 'held-x',
        replicaId: 'log'
      })
      const promoted = await promote('held-x', held.did)
      assert.equal(promoted.statusCode, 204, promoted.payload)

      // Under the promoted controller the `origin` registration selects the
      // log Collection too, so the registration that named it can go. The
      // copy is then held through the controller alone.
      const removed = await call({
        server: mirror,
        path: '/space/held-x/replicas/log',
        method: 'DELETE',
        signer: held.key.signer()
      })
      assert.equal(removed.statusCode, 204, removed.payload)
      assert.equal((await readAs('held-x', held.key)).statusCode, 200)

      // A second Space is promoted to the DID through that copy.
      await createSpace(mirror, 'held-y')
      const second = await promote('held-y', held.did)
      assert.equal(second.statusCode, 204, second.payload)
      assert.equal((await readAs('held-y', held.key)).statusCode, 200)
    })

    it('refuses to move the Space back to a did:key', async () => {
      const refused = await promote('held-x', alice.did, {
        signer: held.key.signer()
      })
      assert.equal(refused.statusCode, 409, refused.payload)
      assert.equal(refused.json().type, ProblemTypes.REPLICA_REFUSED)
      const [problem] = refused.json().errors
      assert.equal(problem.pointer, '#/controller')
      assert.match(problem.detail, /Space "held-y"/)
      assert.equal((await readAs('held-x', held.key)).statusCode, 200)
      assert.equal((await readAs('held-y', held.key)).statusCode, 200)
    })

    it('refuses to move the Space to a DID hosted elsewhere', async () => {
      const refused = await promote('held-x', account.did, {
        signer: held.key.signer()
      })
      assert.equal(refused.statusCode, 409, refused.payload)
      assert.equal(refused.json().type, ProblemTypes.REPLICA_REFUSED)
      assert.match(refused.json().errors[0].detail, /Space "held-y"/)
      assert.equal((await readAs('held-y', held.key)).statusCode, 200)
    })

    it('moves the Space once the other Space changed its controller', async () => {
      const first = await promote('held-y', alice.did, {
        signer: held.key.signer()
      })
      assert.equal(first.statusCode, 204, first.payload)
      const second = await promote('held-x', alice.did, {
        signer: held.key.signer()
      })
      assert.equal(second.statusCode, 204, second.payload)
      assert.equal((await readAs('held-x', held.key)).statusCode, 404)
      const read = await call({ server: mirror, path: '/space/held-x/meta' })
      assert.equal(read.statusCode, 200, read.payload)
      assert.equal(read.json().controller, alice.did)
    })
  })

  describe('with no registration that maps the DID', () => {
    it('refuses a DID on the origin whose Space no registration names', async () => {
      await createSpace(origin, 'other')
      await createCollection(origin, 'other', 'id')
      const other = await mintOnOrigin('other')
      // A Space of the same id on the mirror, holding a copy of the log, is
      // not a registration: matching the host alone would squat it.
      await createSpace(mirror, 'other')
      await createCollection(mirror, 'other', 'id')
      const copied = await putLog({
        server: mirror,
        spaceId: 'other',
        log: other.log
      })
      assert.equal(copied.statusCode, 201, copied.payload)

      await createSpace(mirror, 'data-2')
      const before = networkResolutions.length
      const refused = await promote('data-2', other.did)
      assert.equal(refused.statusCode, 400, refused.payload)
      assert.equal(refused.json().type, ProblemTypes.INVALID_REQUEST_BODY)
      assert.equal(networkResolutions.length, before)
    })

    it('refuses a registration that does not pull the log Collection', async () => {
      await createSpace(origin, 'partial')
      await createCollection(origin, 'partial', 'id')
      await createCollection(origin, 'partial', 'notes')
      const partial = await mintOnOrigin('partial')
      await createSpace(mirror, 'partial-copy')
      await register({
        toSpaceId: 'partial-copy',
        fromSpaceId: 'partial',
        collections: ['notes']
      })
      await mirror.fastify.replication.pullNow({
        spaceId: 'partial-copy',
        replicaId: 'origin'
      })
      await createSpace(mirror, 'data-3')
      const refused = await promote('data-3', partial.did)
      assert.equal(refused.statusCode, 400, refused.payload)
    })

    it('refuses to remove the one registration that maps a controller', async () => {
      const refused = await call({
        server: mirror,
        path: '/space/acct-copy/replicas/origin',
        method: 'DELETE'
      })
      assert.equal(refused.statusCode, 409, refused.payload)
      assert.equal(refused.json().type, ProblemTypes.REPLICA_REFUSED)
      assert.match(refused.json().errors[0].detail, /Space "data"/)
      assert.equal((await readAs('data', account.key)).statusCode, 200)
    })

    it('removes a registration while another on its Space maps the controller', async () => {
      await register({
        toSpaceId: 'acct-copy',
        fromSpaceId: 'acct',
        replicaId: 'origin-2'
      })
      const removed = await call({
        server: mirror,
        path: '/space/acct-copy/replicas/origin-2',
        method: 'DELETE'
      })
      assert.equal(removed.statusCode, 204, removed.payload)
      assert.equal((await readAs('data', account.key)).statusCode, 200)
    })

    it('refuses a second local Space registering the same peer Collections', async () => {
      await createSpace(mirror, 'acct-second')
      const refused = await postRegistration({
        toSpaceId: 'acct-second',
        fromSpaceId: 'acct'
      })
      assert.equal(refused.statusCode, 409, refused.payload)
      assert.equal(refused.json().type, ProblemTypes.REPLICA_REFUSED)
      assert.match(refused.json().errors[0].detail, /Space "acct-copy"/)
      assert.equal((await readAs('data', account.key)).statusCode, 200)
    })

    it('refuses a DID two local Spaces register, until one registration goes', async () => {
      // Register Replica refuses the second registration, so it is stored
      // past that check.
      await registerUnchecked({ toSpaceId: 'acct-second', fromSpaceId: 'acct' })
      await mirror.fastify.replication.pullNow({
        spaceId: 'acct-second',
        replicaId: 'origin'
      })
      const ambiguous = await readAs('data', account.key)
      assert.equal(ambiguous.statusCode, 404)

      const removed = await call({
        server: mirror,
        path: '/space/acct-second/replicas/origin',
        method: 'DELETE'
      })
      assert.equal(removed.statusCode, 204)
      assert.equal((await readAs('data', account.key)).statusCode, 200)
    })

    it('refuses an older copy another registration keeps, once the current one goes', async () => {
      // A second local Space registers the same source, but holds only the
      // genesis entry, written by hand and never pulled. It lists the key the
      // origin retired.
      await createSpace(mirror, 'acct-stale')
      await createCollection(mirror, 'acct-stale', 'id')
      const written = await putLog({
        server: mirror,
        spaceId: 'acct-stale',
        log: account.log.slice(0, 1)
      })
      assert.equal(written.statusCode, 201, written.payload)
      await registerUnchecked({ toSpaceId: 'acct-stale', fromSpaceId: 'acct' })
      assert.equal((await readAs('data', account.key)).statusCode, 404)

      // With the current copy's registration gone, the older copy is the only
      // one a registration maps the DID onto. It does not extend the head
      // this server verified, so neither key authorizes.
      const removed = await call({
        server: mirror,
        path: '/space/acct-copy/replicas/origin',
        method: 'DELETE'
      })
      assert.equal(removed.statusCode, 204)
      assert.equal((await readAs('data', genesisKey)).statusCode, 404)
      assert.equal((await readAs('data', account.key)).statusCode, 404)
    })

    it('stops resolving once no registration maps the DID', async () => {
      // Delete Replica refuses to remove the last registration that maps the
      // controller of Space `data`, so it is removed past that check.
      const refused = await call({
        server: mirror,
        path: '/space/acct-stale/replicas/origin',
        method: 'DELETE'
      })
      assert.equal(refused.statusCode, 409, refused.payload)
      await mirror.backend.deleteReplica({
        spaceId: 'acct-stale',
        replicaId: 'origin'
      })
      invalidateReplicaIndex({ storage: mirror.backend })
      mirror.fastify.replication.unregister({
        spaceId: 'acct-stale',
        replicaId: 'origin'
      })
      const before = networkResolutions.length
      // The copies are still stored, but no registration maps the DID onto
      // either of them.
      const denied = await readAs('data', account.key)
      assert.equal(denied.statusCode, 404)
      assert.equal(networkResolutions.length, before)
    })
  })

  it('never resolved a DID over the network', () => {
    assert.deepStrictEqual(networkResolutions, [])
  })
})
