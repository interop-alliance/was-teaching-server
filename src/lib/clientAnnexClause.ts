/**
 * The client-annex chain-inspection hook -- the second `inspectCapabilityChain`
 * inspector beside the revocation one (`lib/revocations.ts`), wired into every
 * verification on both route families that engages the local `did:webvh`
 * resolver.
 *
 * It bounds what a *ladder* verification method may delegate. The ladder VM is
 * the stable, credential-derived method a wallet publishes on a
 * ladder-anchored account document; it is recognized purely by relation asymmetry -- a
 * `capabilityDelegation` member absent from `capabilityInvocation` -- so no
 * marker vocabulary is consulted. A delegation whose proof VM resolves to a
 * ladder VM is admitted iff one of three predicates holds:
 *
 * 1. Annex-DID controller, by pointer equality: the delegation's sole
 *    `controller` equals the annex DID named by the
 *    `https://w3id.org/byoe#DelegatedClients` service entry of the account
 *    document the chain already resolved as delegator (a memoized read, so no
 *    extra I/O), behind the syntactic gate that the string parses as a
 *    self-hosted did:webvh.
 * 2. Bridge-shaped target, two branches: the delegation's `invocationTarget`
 *    equals the delegator account's own history log resource URL -- derived
 *    from the account DID itself, which carries its log's Space and Collection
 *    -- with `allowedAction` within {PUT}; or equals the trailing-slash URL of
 *    a Space whose Description declares it delegated-clients bookkeeping
 *    (typed `AuxiliarySpace` + `DelegatedClientsSpace`), with `allowedAction`
 *    within {GET, PUT} (one memoized Space Description read).
 * 3. Target-exact single-verb Space read or delete: the delegation's
 *    `invocationTarget` is a bare (no-trailing-slash) Space URL, it equals the
 *    parent capability's `invocationTarget` unchanged, and its `allowedAction`
 *    is exactly `['GET']` or exactly `['DELETE']`. The parent is either a
 *    delegated capability or the Space's synthesized root, whose own target is
 *    that same Space URL. A two-verb set never qualifies.
 *
 * The locked property: no ladder authority whose exercise leaves no record --
 * every admitted ladder delegation either resolves through a loud annex entry,
 * can only write a log, or is a target-exact single-verb GET or DELETE on one
 * Space of the delegator's own account. That third shape is a read, or a
 * destruction whose account-Space case removes the log any record would live
 * in. A DELETE admitted under predicate 3 writes no log. Two bounds keep the
 * predicate narrow. On the `manageCapability` arm the parent already carries
 * DELETE on exactly that Space URL, so the predicate widens who signs the last
 * link rather than what the account may do. And the child's target is its
 * parent's unchanged, so the ladder VM cannot aim it anywhere new.
 *
 * The disjuncts carry different grades of record. Disjunct 2 is exact: all the
 * delegation can do is write a log, and the write is the record. Disjunct 1 is
 * narrower than it reads. The annex entry is loud that a per-visit key exists
 * and may delegate; it is silent about what that key subsequently delegates,
 * to whom, and for how long. A
 * per-visit annex verification method publishes under `capabilityDelegation`
 * beside `capabilityInvocation` (wallet-core decision 0013), so an admitted
 * delegation to the annex DID reaches onward grants no annex entry records.
 * What bounds those grants is target attenuation, the action limitations, and
 * the parent's expiry, not the annex log. The clause binds the capability
 * decision only: a refused delegation does not authorize, and the refusal
 * falls through to the access-control policy like any other failed
 * verification (a world-readable read still serves). The clause is fail-open
 * across servers -- one running unmodified verification accepts what this
 * refuses -- so a wallet publishes a ladder VM only on a host advertising the
 * client-annex profile.
 */
import type { InspectCapabilityChain } from '@interop/zcap'
import type { DIDDoc } from '@interop/did-method-webvh'
import {
  isSelfHostedWebvhController,
  parseSelfHostedWebvh,
  WEBVH_LOG_RESOURCE_ID
} from './validateDid.js'
import { resolveWebvhController } from './webvhController.js'
import type { WebvhResolverContext } from './webvhController.js'
import { getCachedSpaceDescription } from './spaceDescriptionCache.js'
import { isDelegatedClientsSpace } from './spaceType.js'
import { isUrlSafeSegment } from './validateId.js'
import { resourcePath, spacePath } from './paths.js'

/**
 * The service-entry type IRI naming the account's current annex DID.
 * Readers dispatch on this IRI -- fragment ids on service entries are
 * non-semantic.
 */
const DELEGATED_CLIENTS_SERVICE_TYPE = 'https://w3id.org/byoe#DelegatedClients'

/**
 * Runs inspectors in order, returning the first failure (any subsequent
 * inspectors are skipped) or `{ valid: true }` when every one passes. The
 * zcap library takes a single `inspectCapabilityChain` hook, so composition
 * happens here rather than in the verification library.
 * @param inspectors {InspectCapabilityChain[]}
 * @returns {InspectCapabilityChain}
 */
export function composeChainInspectors(
  inspectors: InspectCapabilityChain[]
): InspectCapabilityChain {
  return async details => {
    for (const inspect of inspectors) {
      const result = await inspect(details)
      if (!result.valid) {
        return result
      }
    }
    return { valid: true }
  }
}

/**
 * Extracts the controller DIDs of one capability (`controller` may be a
 * single value or an array on a synthesized root).
 * @param capability {object}   a capability from a dereferenced chain
 * @returns {string[]}
 */
export function capabilityControllers(capability: {
  controller?: string | string[]
}): string[] {
  const { controller } = capability
  if (controller === undefined) {
    return []
  }
  return Array.isArray(controller) ? controller : [controller]
}

/**
 * The delegation-proof verification method of one chain link: the method the
 * verifier actually verified against when it recorded a result, else the
 * method the capability's own `capabilityDelegation` proof names.
 * @param options {object}
 * @param options.capability {object}   the dereferenced capability
 * @param [options.meta] {object}   its `capabilityChainMeta` entry
 * @returns {string | undefined}
 */
function delegationVerificationMethod({
  capability,
  meta
}: {
  capability: { proof?: unknown }
  meta?: { verifyResult?: unknown }
}): string | undefined {
  const verifyResult = meta?.verifyResult as {
    results?: Array<{ verificationMethod?: { id?: string } }>
  } | null
  const verified = verifyResult?.results?.[0]?.verificationMethod?.id
  if (verified) {
    return verified
  }
  const proofs = Array.isArray(capability.proof)
    ? capability.proof
    : [capability.proof]
  for (const proof of proofs as Array<
    { proofPurpose?: string; verificationMethod?: string } | undefined
  >) {
    if (
      proof?.proofPurpose === 'capabilityDelegation' &&
      typeof proof.verificationMethod === 'string'
    ) {
      return proof.verificationMethod
    }
  }
  return undefined
}

/**
 * The absolute method ids one verification relationship names. The document
 * comes verbatim from a verified log, and DID Core lets a relationship entry
 * be an id-reference string (absolute or `#fragment`-relative) or an embedded
 * verification-method object, so entries are normalized to absolute ids
 * before any comparison -- an unnormalized match would misclassify a method
 * listed in a non-string form.
 * @param options {object}
 * @param options.entries {unknown}   the relationship value from the document
 * @param options.docId {string}   the document id, the base for relative refs
 * @returns {string[]}
 */
function relationshipMethodIds({
  entries,
  docId
}: {
  entries: unknown
  docId: string
}): string[] {
  const ids: string[] = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id =
      typeof entry === 'string' ? entry : (entry as { id?: unknown })?.id
    if (typeof id !== 'string') {
      continue
    }
    ids.push(id.startsWith('#') ? `${docId}${id}` : id)
  }
  return ids
}

/**
 * Whether a verification method is the document's ladder VM: listed under
 * `capabilityDelegation` and absent from `capabilityInvocation` (relation
 * asymmetry -- the recognition convention). A method in both is an ordinary
 * client method; a method in neither could not have verified a delegation
 * proof at all.
 * @param options {object}
 * @param options.doc {DIDDoc}   the resolved account document
 * @param options.verificationMethod {string}   the proof's method id
 * @returns {boolean}
 */
function isLadderVerificationMethod({
  doc,
  verificationMethod
}: {
  doc: DIDDoc
  verificationMethod: string
}): boolean {
  const docId = doc.id ?? ''
  return (
    relationshipMethodIds({
      entries: doc.capabilityDelegation,
      docId
    }).includes(verificationMethod) &&
    !relationshipMethodIds({
      entries: doc.capabilityInvocation,
      docId
    }).includes(verificationMethod)
  )
}

/**
 * The annex DID the account document currently points at: the
 * `serviceEndpoint` of the service entry whose `type` names (or includes) the
 * `DelegatedClients` IRI. Only a bare DID-string endpoint counts -- the
 * convention stores the annex DID itself, host-independent.
 * @param doc {DIDDoc}   the resolved account document
 * @returns {string | undefined}
 */
function clientAnnexDidOf(doc: DIDDoc): string | undefined {
  for (const entry of doc.service ?? []) {
    const types = Array.isArray(entry.type) ? entry.type : [entry.type]
    if (
      types.includes(DELEGATED_CLIENTS_SERVICE_TYPE) &&
      typeof entry.serviceEndpoint === 'string'
    ) {
      return entry.serviceEndpoint
    }
  }
  return undefined
}

/**
 * Whether a delegation's `allowedAction` stays within an allowlist: present,
 * non-empty, and every member allowed. An absent `allowedAction` permits any
 * action in the zcap model, so it never satisfies a finite allowlist.
 * @param options {object}
 * @param options.capability {object}   the dereferenced capability
 * @param options.allowed {string[]}   the permitted actions
 * @returns {boolean}
 */
function actionsWithin({
  capability,
  allowed
}: {
  capability: { allowedAction?: string | string[] }
  allowed: string[]
}): boolean {
  const { allowedAction } = capability
  if (allowedAction === undefined) {
    return false
  }
  const actions = Array.isArray(allowedAction) ? allowedAction : [allowedAction]
  return actions.length > 0 && actions.every(action => allowed.includes(action))
}

/**
 * Whether a delegation's `allowedAction` is exactly one named action: present,
 * and a single-member set holding it. Stricter than {@link actionsWithin},
 * which admits any subset of its allowlist -- a single-verb predicate must
 * refuse a two-verb grant that happens to contain the verb.
 * @param options {object}
 * @param options.capability {object}   the dereferenced capability
 * @param options.action {string}   the one permitted action
 * @returns {boolean}
 */
function actionsExactly({
  capability,
  action
}: {
  capability: { allowedAction?: string | string[] }
  action: string
}): boolean {
  const { allowedAction } = capability
  if (allowedAction === undefined) {
    return false
  }
  const actions = Array.isArray(allowedAction) ? allowedAction : [allowedAction]
  return actions.length === 1 && actions[0] === action
}

/**
 * Splits a candidate target into path segments when it is a clean URL on this
 * server -- same origin, no query, no fragment -- or returns `undefined`.
 * @param options {object}
 * @param options.target {string}   the delegation's `invocationTarget`
 * @param options.serverUrl {string}   this server's base URL
 * @returns {string[] | undefined}   `pathname.split('/')`
 */
function localPathSegments({
  target,
  serverUrl
}: {
  target: string
  serverUrl: string
}): string[] | undefined {
  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return undefined
  }
  if (
    parsed.origin !== new URL(serverUrl).origin ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return undefined
  }
  return parsed.pathname.split('/')
}

/**
 * Whether a target is the delegator account's own history log resource URL.
 * The account DID itself carries its log's Space and Collection, so the
 * canonical URL is derived from the parsed DID and matched by exact string
 * equality -- an alternate encoding of the same path never passes, and no
 * other account's log (nor any other log-shaped path) qualifies.
 * @param options {object}
 * @param options.target {string}   the delegation's `invocationTarget`
 * @param options.logLocation {object}   the delegator DID's parsed log
 *   location
 * @param options.logLocation.spaceId {string}
 * @param options.logLocation.collectionId {string}
 * @param options.serverUrl {string}   this server's base URL
 * @returns {boolean}
 */
function isOwnAccountLogTarget({
  target,
  logLocation,
  serverUrl
}: {
  target: string
  logLocation: { spaceId: string; collectionId: string }
  serverUrl: string
}): boolean {
  const canonical = new URL(
    resourcePath({
      spaceId: logLocation.spaceId,
      collectionId: logLocation.collectionId,
      resourceId: WEBVH_LOG_RESOURCE_ID
    }),
    serverUrl
  ).toString()
  return target === canonical
}

/**
 * The Space id when a target is a trailing-slash Space URL
 * (`<base>/space/<S>/`), matched by exact string equality against the
 * canonical form; `undefined` otherwise. Deliberately the trailing-slash form
 * only: it is the Space-subtree target a delegated chain attenuates under,
 * and it excludes `PUT <base>/space/<S>` (Update Space Description, which can
 * rewrite the Space's controller) -- a no-slash grant would cover that under
 * target attenuation. The client-annex profile therefore grants the bookkeeping
 * Space with the subtree target; a `@interop/was-client` caller passes it via
 * the grant's `target` option rather than the `space.grant()` default.
 * @param options {object}
 * @param options.target {string}   the delegation's `invocationTarget`
 * @param options.serverUrl {string}   this server's base URL
 * @returns {string | undefined}
 */
function spaceUrlTargetId({
  target,
  serverUrl
}: {
  target: string
  serverUrl: string
}): string | undefined {
  const segments = localPathSegments({ target, serverUrl })
  if (
    !segments ||
    segments.length !== 4 ||
    segments[0] !== '' ||
    segments[1] !== 'space' ||
    segments[3] !== ''
  ) {
    return undefined
  }
  const spaceId = segments[2]!
  if (!isUrlSafeSegment(spaceId)) {
    return undefined
  }
  const canonical = new URL(
    spacePath({ spaceId, trailingSlash: true }),
    serverUrl
  ).toString()
  return target === canonical ? spaceId : undefined
}

/**
 * Whether a target is a bare Space URL (`<base>/space/<S>`, no trailing
 * slash), matched by exact string equality against the canonical form. The
 * sibling of {@link spaceUrlTargetId}, which matches the trailing-slash
 * subtree form instead; the two forms address different things, so neither
 * helper is loosened to cover both.
 * @param options {object}
 * @param options.target {string}   the delegation's `invocationTarget`
 * @param options.serverUrl {string}   this server's base URL
 * @returns {boolean}
 */
function isBareSpaceUrlTarget({
  target,
  serverUrl
}: {
  target: string
  serverUrl: string
}): boolean {
  const segments = localPathSegments({ target, serverUrl })
  if (
    !segments ||
    segments.length !== 3 ||
    segments[0] !== '' ||
    segments[1] !== 'space'
  ) {
    return false
  }
  const spaceId = segments[2]!
  if (!isUrlSafeSegment(spaceId)) {
    return false
  }
  const canonical = new URL(
    spacePath({ spaceId, trailingSlash: false }),
    serverUrl
  ).toString()
  return target === canonical
}

/**
 * Judges one ladder-signed delegation against the three admission predicates.
 * @param options {object}
 * @param options.capability {object}   the dereferenced delegation
 * @param options.doc {DIDDoc}   the resolved account document (the delegator)
 * @param options.logLocation {object}   the delegator DID's parsed log
 *   location
 * @param options.logLocation.spaceId {string}
 * @param options.logLocation.collectionId {string}
 * @param options.parent {object}   the chain link this delegation hangs from,
 *   a delegated capability or the synthesized root
 * @param [options.parent.invocationTarget] {string}
 * @param options.storage {StorageBackend}   for the Space Description read
 * @param options.serverUrl {string}   this server's base URL
 * @returns {Promise<boolean>}   true when admitted
 */
async function ladderDelegationAdmitted({
  capability,
  doc,
  logLocation,
  parent,
  storage,
  serverUrl
}: {
  capability: {
    controller?: string | string[]
    invocationTarget?: string
    allowedAction?: string | string[]
  }
  doc: DIDDoc
  logLocation: { spaceId: string; collectionId: string }
  parent: { invocationTarget?: string }
} & WebvhResolverContext): Promise<boolean> {
  // Predicate 1: the delegation's sole controller is, by pointer equality,
  // the annex DID the account document currently names -- so a GC pointer
  // swap instantly kills the prior generation's delegations. `controller` is
  // normalized from the array form first (spec-legal, even if in-ecosystem
  // clients emit a string), and exactly one entry is required: a second
  // controller could invoke too, outside the pointer. The syntactic
  // self-hosted gate keeps the admitted controller resolvable here.
  const controllers = capabilityControllers(capability)
  const clientAnnexDid = clientAnnexDidOf(doc)
  if (
    controllers.length === 1 &&
    clientAnnexDid !== undefined &&
    controllers[0] === clientAnnexDid &&
    isSelfHostedWebvhController(clientAnnexDid, { serverUrl })
  ) {
    return true
  }

  // Predicate 2, branch one: the delegation can only write the delegator
  // account's own history log.
  const target = capability.invocationTarget
  if (typeof target !== 'string') {
    return false
  }
  if (
    isOwnAccountLogTarget({ target, logLocation, serverUrl }) &&
    actionsWithin({ capability, allowed: ['PUT'] })
  ) {
    return true
  }

  // Predicate 2, branch two: a whole-Space grant, but only on a Space whose
  // Description declares it delegated-clients bookkeeping -- a path-shape
  // match alone would hand the ladder VM any Space wholesale.
  const spaceId = spaceUrlTargetId({ target, serverUrl })
  if (
    spaceId !== undefined &&
    actionsWithin({ capability, allowed: ['GET', 'PUT'] })
  ) {
    const spaceDescription = await getCachedSpaceDescription({
      storage,
      spaceId
    })
    if (isDelegatedClientsSpace(spaceDescription)) {
      return true
    }
  }

  // Predicate 3: a target-exact single-verb read or delete of one Space. The
  // target is a bare Space URL and is the parent's own target unchanged --
  // whether the parent is a delegated capability or the Space's synthesized
  // root -- so the ladder VM cannot aim the grant anywhere new, only sign the
  // last link. Exactly one of GET or DELETE: a two-verb grant is refused.
  // Reached only after the trailing-slash branch above declined, which a bare
  // target does before any storage read.
  return (
    parent.invocationTarget === target &&
    isBareSpaceUrlTarget({ target, serverUrl }) &&
    (actionsExactly({ capability, action: 'GET' }) ||
      actionsExactly({ capability, action: 'DELETE' }))
  )
}

/**
 * Builds the annex-chain inspection hook for one verification: valid when
 * no delegated capability in the chain is ladder-signed, or when every
 * ladder-signed one satisfies an admission predicate. Non-`did:webvh` proof
 * methods (and cross-host ones, which could not have verified here) are
 * outside the clause and pass untouched, so a chain of ordinary client
 * delegations pays one string check per link.
 * @param options {WebvhResolverContext}   storage + serverUrl, as threaded to
 *   the local `did:webvh` resolver
 * @returns {InspectCapabilityChain}
 */
export function clientAnnexChainInspector({
  storage,
  serverUrl
}: WebvhResolverContext): InspectCapabilityChain {
  return async ({ capabilityChain, capabilityChainMeta }) => {
    for (const [index, capability] of capabilityChain.entries()) {
      // The root is synthesized rather than delegated.
      if (index === 0) {
        continue
      }
      const verificationMethod = delegationVerificationMethod({
        capability: capability as { proof?: unknown },
        meta: capabilityChainMeta[index]
      })
      if (!verificationMethod?.startsWith('did:webvh:')) {
        continue
      }
      const [did] = verificationMethod.split('#')
      const logLocation = parseSelfHostedWebvh(did, { serverUrl })
      if (logLocation === undefined) {
        continue
      }
      // A memoized read: the signature verification that just accepted this
      // proof resolved (and cached) the same document.
      let doc: DIDDoc
      try {
        doc = await resolveWebvhController({ storage, serverUrl, did: did! })
      } catch (err) {
        return { valid: false, error: err as Error }
      }
      if (!isLadderVerificationMethod({ doc, verificationMethod })) {
        continue
      }
      const admitted = await ladderDelegationAdmitted({
        capability,
        doc,
        logLocation,
        parent: capabilityChain[index - 1] as { invocationTarget?: string },
        storage,
        serverUrl
      })
      if (!admitted) {
        return {
          valid: false,
          error: new Error(
            'A capability in the chain is delegated by a delegation-only ' +
              '(ladder) verification method and is none of the admitted ' +
              "shapes: it neither names the account document's client-annex " +
              'DID as controller, nor carries a bridge-shaped invocation ' +
              'target, nor is a single-verb GET or DELETE on the parent ' +
              "capability's own bare Space URL."
          )
        }
      }
    }
    return { valid: true }
  }
}
