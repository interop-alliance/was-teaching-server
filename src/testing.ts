/**
 * Test support entry point (`was-teaching-server/testing`): the in-process
 * boot the server's own suites use, for a consumer that runs its tests against
 * the real server. Carries `startTestServer`, a temp-dir filesystem backend,
 * the request fault seam, and the hand-built `did:webvh` identity provisioner.
 * It imports no test runner, and adds nothing to the production plugin's
 * options.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import {
  createDID,
  logToJsonlString,
  signerFromExternalKey
} from '@interop/did-method-webvh'
import type { DIDLog, ServiceEndpoint, Signer } from '@interop/did-method-webvh'

import { FileSystemBackend } from './backends/filesystem.js'
import type { FileSystemBackendOptions } from './backends/filesystem.js'
import {
  RequestFaults,
  RequestFaultDisarmedError
} from './lib/requestFaults.js'
import { composeApp, createInstance } from './server.js'
import type { createApp } from './server.js'

export { RequestFaults, RequestFaultDisarmedError }
export type { RequestMatch, RequestRecord } from './lib/requestFaults.js'

/**
 * Boots a test server on an OS-assigned ephemeral port and returns the
 * `serverUrl` it is actually reachable at, so parallel Vitest workers can never
 * collide on a port.
 *
 * ZCap `invocationTarget` URLs embed host and port, so `serverUrl` must match
 * the listening port exactly. The port is not known until the server listens,
 * so the app boots against a placeholder base URL and the `serverUrl`
 * decoration is corrected by the first `onListen` hook, before any request is
 * served. Handlers read `request.server.serverUrl` per request, and the
 * plugin's own listen-time read runs after that hook, so nothing captures the
 * placeholder.
 *
 * When the boot fails (a refused option, a port already in use), the Fastify
 * instance is closed before the error is rethrown, so a backend the plugin
 * already owns is closed with it.
 *
 * Callers must build their ZCap clients from the returned `serverUrl`, not from
 * a precomputed one.
 *
 * The returned `faults` records every request and can refuse, drop the
 * response of, or hold a chosen one. Its hooks are added before the protocol
 * plugin, so they run ahead of every route group's own hooks.
 *
 * A suite that tears a server down and boots a replacement over the same
 * `dataDir` must pin the replacement to the returned `port`, so that ids minted
 * by the first server (which embed `serverUrl`) still resolve.
 *
 * The physical clock the server's write stamps read can be frozen or stepped:
 * pass `physicalClock` here when the server opens its own default backend,
 * or to `openTempBackend()` for an injected one.
 *
 * @param [options] {object}   `createApp()` options, minus `serverUrl`
 * @param [options.port] {number}   pin the listening port; defaults to an
 *   OS-assigned ephemeral port
 * @param [options.logger] {boolean|object}   Fastify logger; defaults to
 *   `false` so per-request log lines stay out of the test output
 * @returns {Promise<{ fastify: FastifyInstance, serverUrl: string, port: number, faults: RequestFaults }>}
 */
export async function startTestServer({
  port = 0,
  ...options
}: Omit<NonNullable<Parameters<typeof createApp>[0]>, 'serverUrl'> & {
  port?: number
} = {}): Promise<{
  fastify: FastifyInstance
  serverUrl: string
  port: number
  faults: RequestFaults
}> {
  const { logger = false, ...appOptions } = options
  const fastify = createInstance({ logger })
  const faults = new RequestFaults({ fastify })
  // Added before the plugin is registered, so it runs ahead of the plugin's
  // own `onListen` hook. Synchronous, so it has run by the time `listen()`
  // hands back control: Fastify starts the hooks as it resolves, without
  // awaiting.
  fastify.addHook('onListen', function setServerUrl(done) {
    // `localhost`, not `127.0.0.1`: webkms-client only relaxes its loopback
    // checks for a `localhost` host.
    const { port: listeningPort } = fastify.server.address() as AddressInfo
    fastify.serverUrl = `http://localhost:${listeningPort}`
    done()
  })
  composeApp({ fastify, ...appOptions, serverUrl: 'http://localhost' })
  try {
    await fastify.listen({ port })
  } catch (err) {
    await fastify.close()
    throw err
  }
  const { serverUrl } = fastify
  return { fastify, serverUrl, port: Number(new URL(serverUrl).port), faults }
}

/**
 * A `FileSystemBackend` over a private temp dir, which `close()` removes.
 * Obtained from `openTempBackend()` alone. The class is exported as a type
 * only, so its inherited `open({ dataDir })` cannot be pointed at a dir the
 * caller wants to keep.
 */
class TempFileSystemBackend extends FileSystemBackend {
  /**
   * Removes the temp data dir. The plugin owns an injected backend by default,
   * so `fastify.close()` already calls this. Under `ownsBackend: false`, or
   * for a backend that never reached a server, the caller calls it. A repeat
   * call is a no-op.
   *
   * @returns {Promise<void>}
   */
  async close(): Promise<void> {
    await rm(this.dataDir, { recursive: true, force: true })
  }
}
export type { TempFileSystemBackend }

/**
 * Opens a `FileSystemBackend` on a fresh temp dir, through the async `open()`
 * factory. Each call gets its own dir, so suites never share storage and
 * parallel test workers cannot collide on the filesystem. The backend's
 * `close()` removes the dir.
 *
 * The plugin owns an injected backend by default, so closing the server
 * removes the dir. A test that restarts a server over the same data dir makes
 * its own dir and opens it with `FileSystemBackend.open({ dataDir })` instead.
 *
 * @param [options] {object}   `FileSystemBackend.open()` options, minus
 *   `dataDir`; `physicalClock` freezes or steps the clock the backend's
 *   write stamps read
 * @param [options.prefix] {string}   the temp dir's name prefix
 * @returns {Promise<TempFileSystemBackend>}
 */
export async function openTempBackend({
  prefix = 'was-test-',
  ...options
}: Omit<FileSystemBackendOptions, 'dataDir'> & {
  prefix?: string
} = {}): Promise<TempFileSystemBackend> {
  const dataDir = await mkdtemp(path.join(tmpdir(), prefix))
  try {
    return await TempFileSystemBackend.open({ ...options, dataDir })
  } catch (err) {
    await rm(dataDir, { recursive: true, force: true })
    throw err
  }
}

/**
 * A minted, published self-hosted `did:webvh` and the keys it lists.
 */
export interface WebvhIdentity {
  spaceId: string
  /**
   * the Space's canonical trailing-slash URL
   */
  spaceUrl: string
  did: string
  log: DIDLog
  /**
   * the update-key signer every log entry of this identity is signed by
   */
  logSigner: Signer
  /**
   * the enrolled-client key: all four relations
   */
  clientKeyPair: Ed25519VerificationKey
  /**
   * the delegation-only (ladder) key, when the document lists one
   */
  ladderKeyPair?: Ed25519VerificationKey
  /**
   * the invocation-and-delegation (transient annex) key, when listed
   */
  transientKeyPair?: Ed25519VerificationKey
}

/**
 * `provisionWebvhIdentity()` could not publish the history log: the server
 * answered the `PUT` of `did.jsonl` with something other than 204. Never sent
 * over the wire.
 * @param options {object}
 * @param options.url {string}   the log URL the `PUT` targeted
 * @param options.status {number}   the status the server answered
 */
export class WebvhIdentityPublishError extends Error {
  constructor({ url, status }: { url: string; status: number }) {
    super(`PUT ${url} answered ${status}, expected 204.`)
    this.name = 'WebvhIdentityPublishError'
  }
}

/**
 * The history-log signer for a `did:key` key pair: the update-key signer a
 * `did:webvh` log's entries are signed by.
 *
 * @param options {object}
 * @param options.keyPair {Ed25519VerificationKey}
 * @returns {Signer}
 */
export function webvhLogSigner({
  keyPair
}: {
  keyPair: Ed25519VerificationKey
}): Signer {
  const signer = keyPair.didKeySigner()
  return signerFromExternalKey({
    publicKeyMultibase: keyPair.publicKeyMultibase!,
    sign: async ({ data }: { data: Uint8Array }) => await signer.sign({ data })
  })
}

/**
 * Provisions a Space controlled by a `did:key` client, mints a `did:webvh`
 * anchored in one of its Collections, and publishes the history log there.
 * Promotion of the Space to the new DID is left to the caller (Space creation
 * is `did:key`-only). When a step after the Space's creation fails, the Space
 * is deleted before the error is rethrown.
 *
 * @param options {object}
 * @param options.owner {object}   `{ did, was }`: a `did:key` and a
 *   `@interop/was-client` `WasClient` signed by it, which creates the Space.
 *   This package does not depend on was-client, so the caller brings its own
 *   and the parameter is typed by the members this function calls
 * @param options.serverUrl {string}   the server the log is anchored on
 * @param [options.withLadderKey] {boolean}   also list a method under
 *   `assertionMethod` and `capabilityDelegation` alone -- the ladder VM
 *   shape, recognized by relation asymmetry
 * @param [options.withTransientKey] {boolean}   also list a method under
 *   `capabilityInvocation` and `capabilityDelegation` alone -- the shape a
 *   per-visit annex verification method publishes under
 * @param [options.collectionId] {string}   the Collection anchoring the log
 * @param [options.services] {ServiceEndpoint[]}   service entries for the
 *   created document
 * @returns {Promise<WebvhIdentity>}   with `ladderKeyPair` and
 *   `transientKeyPair` typed as present when the matching flag is the literal
 *   `true`
 */
export async function provisionWebvhIdentity<
  WithLadderKey extends boolean = false,
  WithTransientKey extends boolean = false
>({
  owner,
  serverUrl,
  withLadderKey,
  withTransientKey,
  collectionId = 'id',
  services
}: {
  owner: {
    did: string
    was: {
      space(spaceId: string): {
        configure(options: {
          name: string
          controller: string
        }): Promise<unknown>
        collection(collectionId: string): {
          configure(options: { force: boolean }): Promise<unknown>
        }
        delete(): Promise<unknown>
      }
      request(options: {
        path: string
        method: string
        headers: Record<string, string>
        body: Blob
      }): Promise<{ status: number }>
    }
  }
  serverUrl: string
  withLadderKey?: WithLadderKey
  withTransientKey?: WithTransientKey
  collectionId?: string
  services?: ServiceEndpoint[]
}): Promise<
  WebvhIdentity &
    Required<
      Pick<
        WebvhIdentity,
        | (WithLadderKey extends true ? 'ladderKeyPair' : never)
        | (WithTransientKey extends true ? 'transientKeyPair' : never)
      >
    >
> {
  const spaceId = randomUUID()
  const space = owner.was.space(spaceId)
  await space.configure({ name: 'Identity Space', controller: owner.did })
  try {
    await space.collection(collectionId).configure({ force: true })

    const [updateKeyPair, clientKeyPair, ladderKeyPair, transientKeyPair] =
      await Promise.all([
        Ed25519VerificationKey.generate(),
        Ed25519VerificationKey.generate(),
        withLadderKey ? Ed25519VerificationKey.generate() : undefined,
        withTransientKey ? Ed25519VerificationKey.generate() : undefined
      ])
    const logSigner = webvhLogSigner({ keyPair: updateKeyPair })

    // Relationship wiring is driven entirely through `purpose`: passing
    // explicit relationship arrays alongside would override it wholesale.
    const verificationMethods = [
      {
        type: 'Multikey',
        publicKeyMultibase: clientKeyPair.publicKeyMultibase!,
        purpose: [
          'authentication',
          'assertionMethod',
          'capabilityInvocation',
          'capabilityDelegation'
        ]
      }
    ]
    if (ladderKeyPair) {
      verificationMethods.push({
        type: 'Multikey',
        publicKeyMultibase: ladderKeyPair.publicKeyMultibase!,
        purpose: ['assertionMethod', 'capabilityDelegation']
      })
    }
    if (transientKeyPair) {
      verificationMethods.push({
        type: 'Multikey',
        publicKeyMultibase: transientKeyPair.publicKeyMultibase!,
        purpose: ['capabilityInvocation', 'capabilityDelegation']
      })
    }

    const created = await createDID({
      address: `${serverUrl}/space/${spaceId}/${collectionId}`,
      signer: logSigner,
      updateKeys: [updateKeyPair.publicKeyMultibase!],
      vmIdFragment: 'multibase',
      verificationMethods: verificationMethods as any,
      ...(services ? { services } : {})
    })

    for (const keyPair of [clientKeyPair, ladderKeyPair, transientKeyPair]) {
      if (keyPair) {
        keyPair.id = `${created.did}#${keyPair.publicKeyMultibase}`
        keyPair.controller = created.did
      }
    }

    const logPath = `/space/${spaceId}/${collectionId}/did.jsonl`
    const published = await owner.was.request({
      path: logPath,
      method: 'PUT',
      headers: { 'content-type': 'text/jsonl' },
      body: new Blob([logToJsonlString(created.log)], { type: 'text/jsonl' })
    })
    if (published.status !== 204) {
      throw new WebvhIdentityPublishError({
        url: new URL(logPath, serverUrl).toString(),
        status: published.status
      })
    }

    const identity: WebvhIdentity = {
      spaceId,
      spaceUrl: new URL(`/space/${spaceId}/`, serverUrl).toString(),
      did: created.did,
      log: created.log,
      logSigner,
      clientKeyPair,
      ladderKeyPair,
      transientKeyPair
    }
    // A key pair is generated exactly when its flag is set, which the
    // compiler cannot follow through the conditional above.
    return identity as Awaited<
      ReturnType<typeof provisionWebvhIdentity<WithLadderKey, WithTransientKey>>
    >
  } catch (err) {
    // Best effort: the provisioning failure is the error worth reporting.
    await space.delete().catch(() => {})
    throw err
  }
}
