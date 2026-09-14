/**
 * The client-annex chain-inspection hook -- the second `inspectCapabilityChain`
 * inspector beside the revocation one (`lib/revocations.ts`), wired into every
 * verification on both route families that engages the local `did:webvh`
 * resolver.
 *
 * It bounds what a *ladder* verification method may delegate. The ladder VM is
 * the stable, credential-derived method a wallet publishes on a
 * ladder-anchored account document. It is recognized purely by relation
 * asymmetry -- a `capabilityDelegation` member absent from
 * `capabilityInvocation` -- so no marker vocabulary is consulted. A delegation
 * whose proof VM resolves to a ladder VM is admitted iff one of four
 * predicates holds:
 *
 * 1. Annex-DID controller inside the account Space's items subtree. Three
 *    bounds hold together. The delegation's sole `controller` equals the annex
 *    DID named by the `https://w3id.org/byoe#DelegatedClients` service entry of
 *    the account document the chain already resolved as delegator (a memoized
 *    read, so no extra I/O), behind the syntactic gate that the string parses
 *    as a self-hosted did:webvh. Its `invocationTarget` is the canonical
 *    trailing-slash URL of the Space carrying that account's log, or a path
 *    under that URL, except the Space Metadata URL `/space/<S>/meta` and
 *    anything under it; the no-slash Space URL and any keystore target are
 *    refused. Its `allowedAction` is present, non-empty, and within the closed
 *    WAS verb vocabulary.
 * 2. Bridge-shaped target, two branches: the delegation's `invocationTarget`
 *    equals the delegator account's own history log resource URL -- derived
 *    from the account DID itself, which carries its log's Space and Collection
 *    -- with `allowedAction` within {PUT}; or equals the canonical
 *    trailing-slash URL of a Space whose Metadata object declares it
 *    delegated-clients bookkeeping (typed `AuxiliarySpace` +
 *    `DelegatedClientsSpace`), with `allowedAction` within {GET, PUT} (one
 *    memoized Space Metadata read).
 * 3. Target-exact single-verb Space delete or Space Metadata read, split by
 *    verb. DELETE branch: the delegation's `invocationTarget` is the canonical
 *    trailing-slash Space URL, it equals the parent capability's
 *    `invocationTarget` unchanged, and its `allowedAction` is exactly
 *    `['DELETE']`. The parent is either a delegated capability or the Space's
 *    synthesized root, whose own target is that same trailing-slash URL. This
 *    is the shape the spec's container rule restates for Delete Space. GET
 *    branch: the `invocationTarget` is the Space Metadata URL
 *    `/space/<S>/meta`, its `allowedAction` is exactly `['GET']`, and the
 *    parent's `invocationTarget` is either that same Metadata URL or the
 *    Space's canonical trailing-slash URL -- a narrowing down to the one read
 *    the ladder VM may sign, never a widening. A two-verb set never qualifies
 *    on either branch.
 * 4. Target-exact single-verb read of one Resource. The delegation's
 *    `invocationTarget` is a Resource URL `/space/<S>/<C>/<R>` (three
 *    URL-safe segments, `<C>` and `<R>` outside the reserved path-segment
 *    registry, so a Collection Metadata object, a policy, or a query endpoint
 *    is not a Resource here), its `allowedAction` is exactly `['GET']`, and
 *    the parent's `invocationTarget` is either that same Resource URL or the
 *    canonical trailing-slash URL of the Resource's Space. The parent may be
 *    a delegated capability or the Space's synthesized root. This is the
 *    shape a transient wallet session mints to read one record (the keyring
 *    record of an unlock Space) under a management delegation the Space's
 *    controller granted the account: a narrowing from the whole Space down
 *    to the one read. Nothing recognizes an unlock Space: the bound holds
 *    for any Space, since the parent already bounds which Space the read
 *    can target. By attenuation the grant also reaches the reads under that
 *    Resource URL (its `/meta`, `/policy`, and chunks), all reads. The
 *    delegator's own `did.jsonl` history log is a Resource like any other
 *    here, so a GET-only grant of it is admitted by this predicate; the
 *    {PUT} bound of predicate 2's first branch says what the bridge shape
 *    may write, not that the log is excluded from reads.
 *
 * Under the v0.4 layout predicate 3 targeted the bare (no-slash) Space URL.
 * That gave DELETE no different reach from today's: the zcap library's target
 * attenuation is a `/`-boundary prefix rule, so a `/space/<S>` DELETE grant
 * already covered `/space/<S>/...`, and the bare-vs-slash distinction was
 * cosmetic for DELETE. What the distinction did carry was the bound on the
 * subtree grants of predicates 1 and 2: the same prefix rule refuses the
 * slashless parent, so a `/space/<S>/` grant covered neither
 * `PUT /space/<S>` (Update Space Description) nor `DELETE /space/<S>`.
 *
 * The v0.5 consequence: both operations moved inside the subtree. The Space
 * Metadata object is at `/space/<S>/meta`, so the controller rewrite is
 * `PUT /space/<S>/meta`, and Delete Space is `DELETE /space/<S>/`, the subtree
 * URL itself. A subtree grant admitted under predicate 1 or predicate 2 branch
 * two therefore reaches both by attenuation at invocation time, and the target
 * bound on the delegation's own `invocationTarget` no longer holds the locked
 * property by path alone. The `meta` exclusion in predicate 1 refuses a ladder
 * delegation aimed at the Metadata URL directly, but a delegation targeting the
 * whole subtree still covers it. So the clause adds an invocation-time bound,
 * applied to every chain that carries a ladder-signed link, whatever predicate
 * admitted it: invoked as `PUT` on a Space Metadata URL, the chain is refused;
 * invoked as `DELETE` on a canonical Space URL, it is refused unless every
 * ladder-signed link in the chain is itself the predicate 3 DELETE shape for
 * that Space -- target-exact, `allowedAction` exactly `['DELETE']`. The bound
 * reads the ladder-signed links and not the chain's tail, because a holder
 * below a ladder-signed link can narrow its own grant into the target-exact
 * DELETE-only shape by ordinary attenuation; see `ladderInvocationRefusal`.
 * The zcap library's hook receives only the
 * dereferenced chain, so `handleZcapVerify` (which builds this inspector per
 * verification, with the operation's target and action in hand) threads them
 * in through the `invocation` option. A route that builds the inspector
 * without one (the revocation route, whose target is never a Space URL or a
 * Space Metadata URL) gets the delegation-shape bound alone.
 *
 * Neither operation rests on this bound alone any more: the container rule
 * (`lib/containerRule.ts`) governs both from the route, reading the invoked
 * capability's shape rather than who signed a link, so it also covers a chain
 * that carries no ladder-signed link. The two operations have since parted
 * ways. The only route that PUTs a Space Metadata URL carries the
 * `controller-only` rule, which refuses every delegated invocation before this
 * clause runs, so the PUT branch of the bound decides no case today; it is
 * kept as defense in depth, for a route that might verify such a PUT without
 * the rule, and because the cross-repo decision records state it. The DELETE
 * branch is the one that still decides a case: `DELETE /space/<S>/` carries
 * `exact-delete`, which admits a target-exact DELETE-only tail whoever signed
 * it, and this bound is what refuses such a tail when a ladder-signed link
 * above it granted the whole subtree -- what a ladder verification method
 * signed, which no downstream attenuation can restore.
 *
 * A second invocation-time bound keys on a different signer: the *transient
 * annex VM*, the per-visit method a wallet publishes in its client-annex
 * document under `capabilityInvocation` and `capabilityDelegation` and under
 * no other relation (wallet-core decision 0013). It is not a ladder VM (no
 * relation asymmetry), so the bound above never sees the links it signs, and
 * the container rule reads the invoked capability alone. That left one path
 * open: a transient VM holding a generation delegation (the Space-subtree
 * grant with the full verb set, signed by an enrolled client, so no ladder
 * link anywhere) could narrow it into a target-exact DELETE-only child,
 * invoke the child, and satisfy the container rule's Delete Space exception.
 * So a `DELETE` on a canonical Space URL is refused whenever any link in the
 * chain is signed by a transient annex VM, whoever signed the links above it.
 * The bound reads who signed a link, not who invokes: a per-visit key's own
 * delegation never ends an account or its annex, while a DELETE-only child an
 * enrolled client signs to the annex DID stays admitted, as the wallet's own
 * delete flows are. A `PUT` on a Space Metadata URL needs no branch here:
 * the `controller-only` container rule refuses every delegated invocation at
 * the only route that PUTs one, off the header, before any chain is read.
 *
 * Recognizing the signer is `signerKindOf`'s job, off the signer's own
 * document alone. That keeps the bound total: it holds for a retired annex
 * generation the account document's `DelegatedClients` entry no longer names
 * but whose grant is still live (the annex GC re-points first and tolerates
 * a refused revocation), and for an annex delegated to by a `did:key`
 * controller, which a walk through the delegator's document would miss. The
 * document is the one the signature verification just resolved, so the check
 * costs no read.
 *
 * The locked property: no ladder authority whose exercise leaves no record --
 * every admitted ladder delegation either resolves through a loud annex entry
 * and stays inside the account Space's items subtree, can only write a log, or
 * is a target-exact single-verb DELETE of one Space or GET of one Space
 * Metadata object of the delegator's own account, or a target-exact GET of
 * one Resource. The third shape is a read, or a destruction whose
 * account-Space case removes the log any record would live in; the fourth is
 * a read alone. A DELETE admitted under predicate 3 writes no log. Two bounds
 * keep that predicate narrow. On the `manageCapability` arm the parent already
 * carries DELETE on exactly that Space URL, so the predicate widens who signs
 * the last link rather than what the account may do. And the child's target is
 * its parent's unchanged, so the ladder VM cannot aim it anywhere new.
 *
 * The disjuncts carry different grades of record. Disjunct 2 is exact: all the
 * delegation can do is write a log, and the write is the record. Disjunct 1 is
 * bounded by target as well as by grantee. A per-visit annex verification
 * method publishes under `capabilityDelegation` beside `capabilityInvocation`
 * (wallet-core decision 0013), so it can mint onward grants that no annex entry
 * records. Every such grant is a child of the admitted delegation, so none of
 * them can exceed the account Space's items subtree. The Space Metadata PUT
 * that rewrites the Space's controller, and Space DELETE, are inside that
 * subtree under v0.5 and are held out of reach by the invocation-time bound
 * above. Keystores are outside the subtree by path. What stays free is to whom
 * an onward grant goes, and for how long within the parent's expiry. That
 * freedom is the trade the annex entry's loudness covers: the entry says a
 * per-visit key exists and may delegate.
 *
 * The clause binds the capability decision only: a refused delegation does not
 * authorize, and the refusal falls through to the access-control policy like
 * any other failed verification (a world-readable read still serves). The
 * clause is fail-open across servers -- one running unmodified verification
 * accepts what this refuses -- so a wallet publishes a ladder VM only on a host
 * it assumes enforces the client-annex profile. WAS defines no venue at the
 * authorization-profile layer for a server to advertise the clause, so the
 * wallet's assumption is unverified today; a migration path would need one.
 */
import type { InspectCapabilityChain } from '@interop/zcap'
import {
  actionsExactly,
  actionsWithin,
  type ChainCapability
} from './chainCapability.js'
import type { DIDDoc } from '@interop/did-method-webvh'
import {
  isSelfHostedWebvhController,
  parseSelfHostedWebvh,
  WEBVH_LOG_RESOURCE_ID
} from './validateDid.js'
import { resolveWebvhController } from './webvhController.js'
import type { WebvhResolverContext } from './webvhController.js'
import { getCachedSpaceMetadata } from './spaceMetadataCache.js'
import { isDelegatedClientsSpace } from './spaceType.js'
import {
  isUrlSafeSegment,
  RESERVED_COLLECTION_IDS,
  RESERVED_RESOURCE_IDS
} from './validateId.js'
import { resourcePath, spaceMetaPath, spacePath } from './paths.js'

/**
 * The service-entry type IRI naming the account's current annex DID.
 * Readers dispatch on this IRI -- fragment ids on service entries are
 * non-semantic.
 */
const DELEGATED_CLIENTS_SERVICE_TYPE = 'https://w3id.org/byoe#DelegatedClients'

/**
 * The closed set of actions the WAS routes recognize. It is the whole
 * vocabulary, not a chosen subset: predicate 1 uses it to refuse an absent or
 * open `allowedAction` and any action outside the protocol, while the target
 * bound does the narrowing.
 */
const WAS_ACTIONS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']

/**
 * The reserved segment under a Space URL that addresses its Metadata object.
 */
const META_SEGMENT = 'meta'

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
 * Which signer a delegation proof's verification method is, read off the
 * signer's own resolved document. The ladder VM is recognized by relation
 * asymmetry: listed under `capabilityDelegation` and absent from
 * `capabilityInvocation`. The transient annex VM is the per-visit method a
 * wallet publishes in its client-annex document under `capabilityInvocation`
 * and `capabilityDelegation` and under no other relation (wallet-core
 * decision 0013); reading the signer's document alone keeps that
 * recognition total, whatever document names the annex and whether it still
 * does. Anything else -- an enrolled-client method, which carries
 * `authentication` and `assertionMethod` as well -- is `other`. A method in
 * neither capability relation could not have verified a delegation proof at
 * all.
 * @param options {object}
 * @param options.doc {DIDDoc}   the signer's resolved document
 * @param options.verificationMethod {string}   the proof's method id
 * @returns {'ladder' | 'transient' | 'other'}
 */
function signerKindOf({
  doc,
  verificationMethod
}: {
  doc: DIDDoc
  verificationMethod: string
}): 'ladder' | 'transient' | 'other' {
  const docId = doc.id ?? ''
  const listedUnder = (entries: unknown): boolean =>
    relationshipMethodIds({ entries, docId }).includes(verificationMethod)
  if (!listedUnder(doc.capabilityDelegation)) {
    return 'other'
  }
  if (!listedUnder(doc.capabilityInvocation)) {
    return 'ladder'
  }
  const transient =
    !listedUnder(doc.authentication) &&
    !listedUnder(doc.assertionMethod) &&
    !listedUnder(doc.keyAgreement)
  return transient ? 'transient' : 'other'
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
 * The Space id when a target is a clean URL on this server of one shape under
 * `/space/<S>/`, matched by exact string equality against the canonical form;
 * `undefined` otherwise. The shared skeleton of the three target matchers
 * below: parse, require the `/space/<S>` prefix with a URL-safe Space id, hand
 * the tail segments after it to `canonicalPath`, and compare the target against
 * the canonical URL that path names. An alternate encoding of the same path
 * never passes.
 * @param options {object}
 * @param options.target {string}   the delegation's `invocationTarget`
 * @param options.serverUrl {string}   this server's base URL
 * @param options.canonicalPath {function}   maps the Space id and the tail
 *   segments after it to the shape's canonical path, or `undefined` when the
 *   tail is not that shape (its length included)
 * @returns {string | undefined}
 */
function localSpaceTargetId({
  target,
  serverUrl,
  canonicalPath
}: {
  target: string
  serverUrl: string
  canonicalPath: (options: {
    spaceId: string
    tail: string[]
  }) => string | undefined
}): string | undefined {
  const segments = localPathSegments({ target, serverUrl })
  if (!segments || segments[0] !== '' || segments[1] !== 'space') {
    return undefined
  }
  const spaceId = segments[2]!
  if (!isUrlSafeSegment(spaceId)) {
    return undefined
  }
  const path = canonicalPath({ spaceId, tail: segments.slice(3) })
  if (path === undefined) {
    return undefined
  }
  const canonical = new URL(path, serverUrl).toString()
  return target === canonical ? spaceId : undefined
}

/**
 * The Space id when a target is the canonical trailing-slash Space URL
 * (`<base>/space/<S>/`); `undefined` otherwise. It is the Space-as-container
 * target a delegated chain attenuates under, the target a generation
 * delegation already carries, and the target of the Space's synthesized root.
 * The no-slash form is not a canonical target under v0.5 (the route only
 * redirects), so it matches nothing here. A `@interop/was-client` caller
 * passes the canonical form via the grant's `target` option.
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
  return localSpaceTargetId({
    target,
    serverUrl,
    canonicalPath: ({ spaceId, tail }) =>
      tail.length === 1 && tail[0] === ''
        ? spacePath({ spaceId, trailingSlash: true })
        : undefined
  })
}

/**
 * The Space id when a target is a Space Metadata URL (`<base>/space/<S>/meta`);
 * `undefined` otherwise. The sibling of {@link spaceUrlTargetId}, which
 * matches the container form instead; the two address different things, so
 * neither helper is loosened to cover both.
 * @param options {object}
 * @param options.target {string}   the delegation's `invocationTarget`
 * @param options.serverUrl {string}   this server's base URL
 * @returns {string | undefined}
 */
function spaceMetaUrlTargetId({
  target,
  serverUrl
}: {
  target: string
  serverUrl: string
}): string | undefined {
  return localSpaceTargetId({
    target,
    serverUrl,
    canonicalPath: ({ spaceId, tail }) =>
      tail.length === 1 && tail[0] === META_SEGMENT
        ? spaceMetaPath({ spaceId })
        : undefined
  })
}

/**
 * The Space id when a target is a Resource URL (`<base>/space/<S>/<C>/<R>`);
 * `undefined` otherwise. All three ids are URL-safe segments, and `<C>` and
 * `<R>` are outside the reserved path-segment registry, so a Collection
 * Metadata URL (`/space/<S>/<C>/meta`), a policy, or a query endpoint does not
 * match: the predicate admits a read of one Resource, not of any three-segment
 * path. A Collection URL (trailing slash, so an empty fourth segment) matches
 * nothing either.
 * @param options {object}
 * @param options.target {string}   the delegation's `invocationTarget`
 * @param options.serverUrl {string}   this server's base URL
 * @returns {string | undefined}
 */
function resourceUrlTargetSpaceId({
  target,
  serverUrl
}: {
  target: string
  serverUrl: string
}): string | undefined {
  return localSpaceTargetId({
    target,
    serverUrl,
    canonicalPath: ({ spaceId, tail }) => {
      if (tail.length !== 2) {
        return undefined
      }
      const [collectionId, resourceId] = tail as [string, string]
      if (
        !isUrlSafeSegment(collectionId) ||
        !isUrlSafeSegment(resourceId) ||
        RESERVED_COLLECTION_IDS.has(collectionId) ||
        RESERVED_RESOURCE_IDS.has(resourceId)
      ) {
        return undefined
      }
      return resourcePath({ spaceId, collectionId, resourceId })
    }
  })
}

/**
 * Whether a target lies within one Space's items subtree: a clean local URL
 * whose path is `<base>/space/<S>/` or any path under it, with the Space id
 * segment equal to `spaceId` as an exact string, except the Space Metadata
 * URL `<base>/space/<S>/meta` and anything under it.
 *
 * The `meta` exclusion refuses a ladder delegation aimed at the Metadata
 * object directly, whose `PUT` rewrites the Space's controller. It is a bound
 * on the delegation's own target only: a grant on the whole subtree still
 * covers the Metadata URL by attenuation at invocation time, which is what
 * {@link ladderInvocationRefusal} holds. The no-slash Space URL
 * `<base>/space/<S>` is not a canonical target under v0.5 and is excluded by
 * the segment count.
 *
 * Keystore targets (`<base>/kms/...`) are outside the subtree: their second
 * path segment is `kms`, so they never match the `/space/<S>/` shape.
 *
 * @param options {object}
 * @param options.target {string}   the delegation's `invocationTarget`
 * @param options.spaceId {string}   the Space the subtree belongs to
 * @param options.serverUrl {string}   this server's base URL
 * @returns {boolean}
 */
function isWithinSpaceItemsSubtree({
  target,
  spaceId,
  serverUrl
}: {
  target: string
  spaceId: string
  serverUrl: string
}): boolean {
  const segments = localPathSegments({ target, serverUrl })
  return (
    segments !== undefined &&
    segments.length >= 4 &&
    segments[0] === '' &&
    segments[1] === 'space' &&
    segments[2] === spaceId &&
    segments[3] !== META_SEGMENT
  )
}

/**
 * Judges one ladder-signed delegation against the four admission predicates.
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
 * @param options.storage {StorageBackend}   for the Space Metadata read
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
  capability: ChainCapability
  doc: DIDDoc
  logLocation: { spaceId: string; collectionId: string }
  parent: { invocationTarget?: string }
} & WebvhResolverContext): Promise<boolean> {
  const target = capability.invocationTarget
  if (typeof target !== 'string') {
    return false
  }

  // Predicate 1, bound one -- the grantee. The delegation's sole controller is,
  // by pointer equality, the annex DID the account document currently names --
  // so a GC pointer swap instantly kills the prior generation's delegations.
  // `controller` is normalized from the array form first (spec-legal, even if
  // in-ecosystem clients emit a string), and exactly one entry is required: a
  // second controller could invoke too, outside the pointer. The syntactic
  // self-hosted gate keeps the admitted controller resolvable here.
  //
  // Bound two -- the target. The grant stays within the items subtree of the
  // account Space, the Space carrying the delegator DID's own log, and may not
  // aim at the Space Metadata URL directly. Keystore targets (`/kms/...`) are
  // outside the subtree, since they are not under `/space/<S>/` at all. Under
  // v0.5 the subtree itself contains Update Space Metadata (a controller
  // rewrite) and Delete Space, so a whole-subtree grant reaches both by
  // attenuation; the invocation-time bound in `clientAnnexChainInspector`
  // is what keeps them out of ladder reach.
  //
  // Bound three -- the action. `allowedAction` must be present, non-empty, and
  // drawn from the full closed WAS verb vocabulary. The full set is admitted
  // rather than a narrower one: the generation delegation (app-connect-spec
  // decision 0002) carries exactly that vocabulary, and a child capability may
  // not exceed its parent, so any verb left out here would hold every
  // transient-visit grant below the durable client's own shape. The bound is
  // here to refuse an absent or open `allowedAction` and any verb outside the
  // vocabulary. The target bound does the real narrowing.
  const controllers = capabilityControllers(capability)
  const clientAnnexDid = clientAnnexDidOf(doc)
  if (
    controllers.length === 1 &&
    clientAnnexDid !== undefined &&
    controllers[0] === clientAnnexDid &&
    isSelfHostedWebvhController(clientAnnexDid, { serverUrl }) &&
    isWithinSpaceItemsSubtree({
      target,
      spaceId: logLocation.spaceId,
      serverUrl
    }) &&
    actionsWithin({ capability, allowed: WAS_ACTIONS })
  ) {
    return true
  }

  // Predicate 2, branch one: the delegation can only write the delegator
  // account's own history log.
  if (
    isOwnAccountLogTarget({ target, logLocation, serverUrl }) &&
    actionsWithin({ capability, allowed: ['PUT'] })
  ) {
    return true
  }

  // Predicate 2, branch two: a whole-Space grant, but only on a Space whose
  // Metadata object declares it delegated-clients bookkeeping -- a path-shape
  // match alone would hand the ladder VM any Space wholesale.
  const spaceId = spaceUrlTargetId({ target, serverUrl })
  if (
    spaceId !== undefined &&
    actionsWithin({ capability, allowed: ['GET', 'PUT'] })
  ) {
    const spaceMetadata = await getCachedSpaceMetadata({ storage, spaceId })
    if (isDelegatedClientsSpace(spaceMetadata)) {
      return true
    }
  }

  // Predicate 3, DELETE branch: a target-exact DELETE of one Space. The target
  // is the canonical trailing-slash Space URL and is the parent's own target
  // unchanged -- whether the parent is a delegated capability or the Space's
  // synthesized root -- so the ladder VM cannot aim the grant anywhere new,
  // only sign the last link. Exactly DELETE: a two-verb grant is refused. The
  // target shape is shared with predicate 2 branch two, which declined on the
  // action before any storage read.
  if (
    spaceId !== undefined &&
    parent.invocationTarget === target &&
    actionsExactly({ capability, action: 'DELETE' })
  ) {
    return true
  }

  // Predicate 3, GET branch: a target-exact GET of one Space Metadata object.
  // Predicate 4: a target-exact GET of one Resource, `/space/<S>/<C>/<R>`.
  // Predicate 4 shares the parent bound: the parent's target is either the
  // delegation's own target or the Space's canonical URL, so the grant only
  // ever narrows toward the one read. Both are GET-only.
  const readSpaceId =
    spaceMetaUrlTargetId({ target, serverUrl }) ??
    resourceUrlTargetSpaceId({ target, serverUrl })
  if (readSpaceId === undefined || parent.invocationTarget === undefined) {
    return false
  }
  const parentSpaceUrl = new URL(
    spacePath({ spaceId: readSpaceId, trailingSlash: true }),
    serverUrl
  ).toString()
  return (
    (parent.invocationTarget === target ||
      parent.invocationTarget === parentSpaceUrl) &&
    actionsExactly({ capability, action: 'GET' })
  )
}

/**
 * Which of the two operations the invocation-time bounds read an invocation
 * as: a `PUT` on a Space Metadata URL (the controller rewrite), a `DELETE`
 * on a canonical Space URL, or neither. Both bounds classify the same way;
 * each then applies its own condition.
 * @param options {object}
 * @param options.invocation {object}   the operation being verified
 * @param options.invocation.target {string}   its canonical target URL
 * @param options.invocation.action {string}   its zcap action (the HTTP verb)
 * @param options.serverUrl {string}   this server's base URL
 * @returns {'put-space-meta' | 'delete-space' | undefined}
 */
function spaceOperationOf({
  invocation: { target, action },
  serverUrl
}: {
  invocation: { target: string; action: string }
  serverUrl: string
}): 'put-space-meta' | 'delete-space' | undefined {
  if (
    action === 'PUT' &&
    spaceMetaUrlTargetId({ target, serverUrl }) !== undefined
  ) {
    return 'put-space-meta'
  }
  if (
    action === 'DELETE' &&
    spaceUrlTargetId({ target, serverUrl }) !== undefined
  ) {
    return 'delete-space'
  }
  return undefined
}

/**
 * The invocation-time bound on a ladder-descended chain: the reason the
 * invoked operation is refused, or `undefined` when it is allowed. Invoked as
 * `PUT` on a Space Metadata URL (the controller rewrite), the chain is always
 * refused -- a branch the `controller-only` container rule now shadows at the
 * only route that PUTs such a URL, kept here as defense in depth. Invoked as
 * `DELETE` on a canonical Space URL, it is refused unless
 * every ladder-signed link in the chain is itself the predicate 3 DELETE shape
 * for that Space -- carrying exactly that URL as its `invocationTarget` and
 * exactly `['DELETE']` as its `allowedAction`. Every other operation passes:
 * the delegation-shape predicates already bound it.
 *
 * The bound is evaluated on the ladder-signed links rather than on the chain's
 * tail, because the tail's shape is not the ladder VM's to determine. Anything
 * below a ladder-signed link can narrow itself INTO the target-exact
 * DELETE-only shape, and a tail-only check would read that narrowing as the
 * predicate 3 grant it is not. Concretely: a ladder VM signs a predicate 1
 * whole-subtree grant (target `/space/<S>/`, the full WAS verb vocabulary) to
 * the annex DID; the annex verification method publishes under
 * `capabilityInvocation` beside `capabilityDelegation` (wallet-core decision
 * 0013), so it is not itself a ladder VM and may mint onward grants; it mints
 * a child with the same target and `allowedAction: ['DELETE']`, which is a
 * legal attenuation and lands a conforming tail on the chain. Checking the
 * ladder-signed links closes that: a subtree grant yields no Space DELETE
 * however it is narrowed downstream, while a genuine predicate 3 grant still
 * verifies and may still be delegated onward, since attenuation can only keep
 * such a child target-exact and DELETE-only.
 * @param options {object}
 * @param options.target {string}   the invoked operation's canonical target
 *   URL
 * @param options.operation {'put-space-meta' | 'delete-space' | undefined}
 *   which Space operation the invocation is, per `spaceOperationOf`
 * @param options.ladderLinks {object[]}   the chain's ladder-signed links, in
 *   chain order
 * @returns {string | undefined}   the refusal reason, or `undefined`
 */
function ladderInvocationRefusal({
  target,
  operation,
  ladderLinks
}: {
  target: string
  operation: 'put-space-meta' | 'delete-space' | undefined
  ladderLinks: ChainCapability[]
}): string | undefined {
  if (operation === 'put-space-meta') {
    return 'invoked as PUT on a Space Metadata URL'
  }
  if (
    operation === 'delete-space' &&
    !ladderLinks.every(
      link =>
        link.invocationTarget === target &&
        actionsExactly({ capability: link, action: 'DELETE' })
    )
  ) {
    return (
      'invoked as DELETE on a Space URL under a chain whose ladder-signed ' +
      'delegation is not a target-exact DELETE-only grant of that Space'
    )
  }
  return undefined
}

/**
 * Builds the annex-chain inspection hook for one verification: valid when
 * no delegated capability in the chain is ladder-signed or transient-annex-
 * signed, or when every ladder-signed one satisfies an admission predicate
 * and the invoked operation passes both invocation-time bounds.
 * Non-`did:webvh` proof methods (and cross-host ones, which could not have
 * verified here) are outside the clause and pass untouched, so a chain of
 * ordinary client delegations pays one string check per link. A `did:webvh`
 * signer is classified once by `signerKindOf`, off its already-resolved
 * document; the transient bound then applies only to a Space DELETE. Invoked
 * as `PUT` on a Space Metadata URL, such a chain is already refused by the
 * `controller-only` container rule at the only route that PUTs one, before
 * any chain is dereferenced, so that bound carries no PUT branch of its own.
 * @param options {object}
 * @param options.storage {StorageBackend}   as threaded to the local
 *   `did:webvh` resolver
 * @param options.serverUrl {string}   this server's base URL
 * @param [options.invocation] {object}   the operation being verified, when
 *   the caller has one: the invocation-time bound is applied only when given
 * @param options.invocation.target {string}   its canonical target URL
 * @param options.invocation.action {string}   its zcap action
 * @returns {InspectCapabilityChain}
 */
export function clientAnnexChainInspector({
  storage,
  serverUrl,
  invocation
}: WebvhResolverContext & {
  invocation?: { target: string; action: string }
}): InspectCapabilityChain {
  return async ({ capabilityChain, capabilityChainMeta }) => {
    // The ladder-signed links themselves, not merely whether the chain has
    // one; for a transient annex VM one signed link is the whole statement.
    const ladderLinks: ChainCapability[] = []
    let transientAnnexSigned = false
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
      const signer = signerKindOf({ doc, verificationMethod })
      if (signer !== 'ladder') {
        transientAnnexSigned ||= signer === 'transient'
        continue
      }
      ladderLinks.push(capability as ChainCapability)
      const admitted = await ladderDelegationAdmitted({
        capability: capability as ChainCapability,
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
              "DID as sole controller with a target inside the account Space's " +
              'items subtree (its Metadata URL excluded), nor carries a ' +
              'bridge-shaped invocation target, nor is a DELETE-only grant ' +
              "of the parent capability's own Space URL, nor a GET-only " +
              "grant of that Space's Metadata URL or of one Resource in it."
          )
        }
      }
    }
    if (invocation === undefined) {
      return { valid: true }
    }
    const operation = spaceOperationOf({ invocation, serverUrl })
    if (transientAnnexSigned && operation === 'delete-space') {
      return {
        valid: false,
        error: new Error(
          'A chain carrying a delegation signed by a transient annex ' +
            'verification method (a per-visit key) is invoked as DELETE on ' +
            "a Space URL: a per-visit key's own delegation never ends an " +
            'account or its annex.'
        )
      }
    }
    if (ladderLinks.length === 0) {
      return { valid: true }
    }
    const refusal = ladderInvocationRefusal({
      target: invocation.target,
      operation,
      ladderLinks
    })
    if (refusal !== undefined) {
      return {
        valid: false,
        error: new Error(
          'A chain carrying a delegation signed by a delegation-only ' +
            `(ladder) verification method is ${refusal}: Update Space ` +
            'Metadata and Delete Space are outside ladder reach.'
        )
      }
    }
    return { valid: true }
  }
}
