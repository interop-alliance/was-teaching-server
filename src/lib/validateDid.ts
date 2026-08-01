/**
 * Validation for the `controller` DID supplied in Space Description request
 * bodies. Two controller shapes are accepted, and only one of them everywhere:
 *
 * - An Ed25519 `did:key`, whose multibase encoding always begins `z6Mk` (the
 *   `0xed01` Ed25519-pub multicodec prefix) followed by base58btc characters.
 *   This is the only shape Space create, and the keystore routes, accept.
 * - Additionally, on Update Space only: a **self-hosted** `did:webvh` --
 *   `did:webvh:<scid>:<didDomainComponent>:space:<spaceId>:id`, whose embedded
 *   host is this server. Its history log lives in that Space's world-readable
 *   `id` collection, so it resolves from local storage and never over the
 *   network. A cross-host `did:webvh`, a `did:web`, and every other DID method
 *   stay refused.
 *
 * Both are syntactic checks at the request layer, so a malformed or
 * unsupported controller is rejected on the way in, rather than being stored
 * and only failing later at capability-verification time. Whether a
 * syntactically self-hosted `did:webvh` actually *resolves* is a separate,
 * storage-reading check (`lib/webvhController.ts`).
 */
import { InvalidControllerError } from '../errors.js'
import { isUrlSafeSegment } from './validateId.js'
import type { IDID } from '../types.js'

// An Ed25519 `did:key` is `did:key:` + `z6Mk` + a base58btc payload. The
// base58btc (Bitcoin) alphabet omits `0`, `O`, `I`, and `l`.
const DID_KEY_ED25519_PATTERN = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]+$/

/**
 * A did:webvh SCID is a base58btc-encoded multihash of the first log entry.
 * Shape-checked only (the resolver re-derives and pins it against the log).
 */
const SCID_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{16,}$/

/**
 * The method-specific path a self-hosted controller DID must carry: the log is
 * published as `did.jsonl` in the `id` collection of the Space named by the
 * DID, i.e. `<host>/space/<spaceId>/id/did.jsonl`.
 */
const WEBVH_SPACE_SEGMENT = 'space'
const WEBVH_COLLECTION_ID = 'id'

/** The Resource holding a self-hosted DID's history log. */
export const WEBVH_LOG_RESOURCE_ID = 'did.jsonl'

/**
 * Returns true when `value` is a syntactically valid Ed25519 `did:key` DID.
 * @param value {unknown}
 * @returns {boolean}
 */
export function isValidController(value: unknown): value is IDID {
  return typeof value === 'string' && DID_KEY_ED25519_PATTERN.test(value)
}

/**
 * Parses a self-hosted `did:webvh` controller into the two parts the resolver
 * needs, or returns `undefined` when `value` is not one.
 *
 * The accepted form is exactly
 * `did:webvh:<scid>:<didDomainComponent>:space:<spaceId>:id`, where the
 * `didDomainComponent` is the DID-method encoding of a host (a port is
 * percent-encoded as `%3A`, since `:` is the method's own separator) and must
 * decode to this server's own host. Nothing else -- no extra path segments, no
 * cross-host domain, no other DID method -- parses.
 *
 * @param value {unknown}   the candidate controller DID
 * @param options {object}
 * @param options.serverUrl {string}   this server's base URL
 * @returns {{ scid: string, spaceId: string } | undefined}
 */
export function parseSelfHostedWebvh(
  value: unknown,
  { serverUrl }: { serverUrl: string }
): { scid: string; spaceId: string } | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  // `did`, `webvh`, scid, didDomainComponent, `space`, spaceId, `id`.
  const segments = value.split(':')
  if (segments.length !== 7) {
    return undefined
  }
  const [scheme, method, scid, didDomainComponent, spaceSegment, spaceId, cid] =
    segments as [string, string, string, string, string, string, string]
  if (scheme !== 'did' || method !== 'webvh') {
    return undefined
  }
  if (spaceSegment !== WEBVH_SPACE_SEGMENT || cid !== WEBVH_COLLECTION_ID) {
    return undefined
  }
  if (!SCID_PATTERN.test(scid)) {
    return undefined
  }
  // The spaceId lands in a storage path, so it gets the same URL-safe-segment
  // check every id parsed off a request URL gets (path-traversal defense).
  if (!isUrlSafeSegment(spaceId)) {
    return undefined
  }
  let didHost: string
  try {
    didHost = decodeURIComponent(didDomainComponent).toLowerCase()
  } catch {
    // A malformed percent-escape in the domain component.
    return undefined
  }
  if (didHost !== new URL(serverUrl).host.toLowerCase()) {
    return undefined
  }
  return { scid, spaceId }
}

/**
 * Returns true when `value` is a syntactically valid `did:webvh` anchored in a
 * Space on *this* server (see {@link parseSelfHostedWebvh}).
 * @param value {unknown}
 * @param options {object}
 * @param options.serverUrl {string}   this server's base URL
 * @returns {boolean}
 */
export function isSelfHostedWebvhController(
  value: unknown,
  { serverUrl }: { serverUrl: string }
): value is IDID {
  return parseSelfHostedWebvh(value, { serverUrl }) !== undefined
}

/**
 * Asserts that `controller` is a valid Ed25519 `did:key`, throwing
 * InvalidControllerError (400) otherwise.
 * @param controller {unknown}   the `controller` value from the request body
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 * @returns {void}
 */
export function assertValidController(
  controller: unknown,
  { requestName }: { requestName?: string } = {}
): void {
  if (!isValidController(controller)) {
    throw new InvalidControllerError({ requestName })
  }
}

/**
 * Asserts that `controller` is a controller shape a Space (or a keystore) may
 * be *updated* to, or listed by: an Ed25519 `did:key`, or a self-hosted
 * `did:webvh` anchored on this server. The sibling of
 * {@link assertValidController}, kept separate so the create paths stay
 * `did:key`-only by construction rather than by a flag.
 *
 * @param controller {unknown}   the `controller` value from the request body
 * @param options {object}
 * @param options.serverUrl {string}   this server's base URL
 * @param [options.requestName] {string}   request name used in the error title
 * @returns {void}
 */
export function assertValidSpaceController(
  controller: unknown,
  { serverUrl, requestName }: { serverUrl: string; requestName?: string }
): void {
  if (
    !isValidController(controller) &&
    !isSelfHostedWebvhController(controller, { serverUrl })
  ) {
    throw new InvalidControllerError({ requestName, allowWebvh: true })
  }
}
