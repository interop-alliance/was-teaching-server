/**
 * The signer a server invokes a peer's capabilities with when it replicates a
 * Space. It is the server identity's one seed key, named as the `did:webvh`
 * method `{serverDid}#{publicKeyMultibase}`, the same method export
 * provenance signs with. A controller delegates the pull capability to
 * `serverDid`, so a peer verifies the invocation against the server's
 * published history log.
 *
 * The admin enables this by listing the key under `capabilityInvocation` in
 * that log, beside `assertionMethod`. Without a `serverDid`, or without that
 * relationship, there is no signer, and the result says which is missing.
 * There is no `did:key` form: a server with no identity cannot replicate.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { ISigner } from '@interop/data-integrity-core'
import type { DIDDoc } from '@interop/did-method-webvh'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { isServerFault } from '../errors.js'
import type { StorageBackend } from '../types.js'
import { resolveServerDid } from './serverIdentity.js'
import type { ServerSigningKey } from './serverIdentity.js'
import { resolveWebvhController } from './webvhController.js'

/**
 * Loads the signer for sync invocations, or says why the server has none.
 *
 * The server must advertise a `serverDid` (`resolveServerDid`, the check
 * `/service` makes), and the resolved current document of its log must list
 * the seed key as the method `{serverDid}#{publicKeyMultibase}` under
 * `capabilityInvocation`. The returned signer's `id` is that method, so a
 * peer verifies its signature against the server's own log.
 *
 * A refusal says why the server has no sync signer. `no-server-did`: no
 * `WAS_SERVER_KEY_SEED` is set, or `/service` advertises no `serverDid`.
 * `no-capability-invocation`: the server's history log does not list the key
 * under `capabilityInvocation`. `reason` says the same for a person to read.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}
 * @param options.serverUrl {string}
 * @param [options.signingKey] {ServerSigningKey}   the key derived from
 *   `WAS_SERVER_KEY_SEED`, absent when the seed is unset
 * @param options.logger {FastifyBaseLogger}   for `resolveServerDid`'s own
 *   once-per-log-version warnings
 * @returns {Promise<{ serverDid: string, signer: ISigner } | { refusal: string, reason: string }>}
 * @throws {ProblemError}   a storage fault met while reading the log (5xx),
 *   which is not a refusal
 */
export async function loadSyncSigner({
  storage,
  serverUrl,
  signingKey,
  logger
}: {
  storage: StorageBackend
  serverUrl: string
  signingKey: ServerSigningKey | undefined
  logger: FastifyBaseLogger
}): Promise<
  | { serverDid: string; signer: ISigner }
  | { refusal: 'no-server-did' | 'no-capability-invocation'; reason: string }
> {
  if (signingKey === undefined) {
    return {
      refusal: 'no-server-did',
      reason:
        'The server has no identity: WAS_SERVER_KEY_SEED is not set, so it ' +
        'advertises no serverDid.'
    }
  }
  const serverDid = await resolveServerDid({
    storage,
    serverUrl,
    signingKey,
    logger
  })
  if (serverDid === undefined) {
    return {
      refusal: 'no-server-did',
      reason:
        'The server advertises no serverDid: no verifying server history ' +
        'log lists its key under "assertionMethod".'
    }
  }
  let doc: DIDDoc
  try {
    doc = await resolveWebvhController({ storage, serverUrl, did: serverDid })
  } catch (err) {
    // A storage fault says nothing about the log, and keeps its 5xx.
    if (isServerFault(err)) {
      throw err
    }
    // The log changed between the two reads and no longer verifies.
    return {
      refusal: 'no-server-did',
      reason: `The server history log does not verify: ${(err as Error).message}`
    }
  }
  const { publicKeyMultibase, privateKeyMultibase } = signingKey.keyPair
  const methodId = `${serverDid}#${publicKeyMultibase}`
  if (!listsInvocationMethod({ doc, methodId, publicKeyMultibase })) {
    return {
      refusal: 'no-capability-invocation',
      reason:
        'The server history log does not list the server key under ' +
        `"capabilityInvocation" as "${methodId}".`
    }
  }
  const keyPair = new Ed25519VerificationKey({
    id: methodId,
    controller: serverDid,
    publicKeyMultibase,
    privateKeyMultibase
  })
  return { serverDid, signer: keyPair.signer() }
}

/**
 * Whether the document carries the method `methodId` with the server key and
 * names it under `capabilityInvocation`, the check a peer's verifier makes on
 * an invocation signed by that method. A relationship entry is an id string,
 * absolute or `#fragment`-relative, or an embedded method object.
 * @param options {object}
 * @param options.doc {DIDDoc}   the resolved current document
 * @param options.methodId {string}   `{serverDid}#{publicKeyMultibase}`
 * @param options.publicKeyMultibase {string}   the server key
 * @returns {boolean}
 */
function listsInvocationMethod({
  doc,
  methodId,
  publicKeyMultibase
}: {
  doc: DIDDoc
  methodId: string
  publicKeyMultibase: string
}): boolean {
  const absolute = (id: string): string =>
    id.startsWith('#') ? `${doc.id ?? ''}${id}` : id
  const carriesKey = (doc.verificationMethod ?? []).some(
    method =>
      typeof method.id === 'string' &&
      absolute(method.id) === methodId &&
      method.publicKeyMultibase === publicKeyMultibase
  )
  const relationship: unknown = doc.capabilityInvocation
  const named =
    Array.isArray(relationship) &&
    relationship.some(entry => {
      const id =
        typeof entry === 'string' ? entry : (entry as { id?: unknown })?.id
      return typeof id === 'string' && absolute(id) === methodId
    })
  return carriesKey && named
}
