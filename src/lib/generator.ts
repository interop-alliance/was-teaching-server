/**
 * Collection app-attribution helpers (spec "Collection Data Model"): the
 * OPTIONAL `generator` and `generatorOrigin` members of a Collection
 * Description. `generator` names the DID of the application the Collection was
 * provisioned for (the AS2 `generator` sense) and `generatorOrigin` the Web
 * origin that DID was bound to at provisioning time -- e.g. the
 * browser-attested requesting origin of an App Connect exchange, preserved so
 * attribution survives without the app-key credential at hand.
 *
 * Both are ASSERTIONS BY THE SPACE CONTROLLER, not server observations: the
 * server validates only their shape, stores them verbatim, and echoes them on
 * reads. Nothing here is ever an authorization input, and the server never
 * defaults or computes either value -- contrast the server-observed, read-only
 * `createdBy`, which under delegated provisioning names the invoker (the wallet
 * user), never the application. They are writable at CREATE and on UPDATE (so a
 * controller can backfill Collections provisioned before an application
 * recorded its attribution), and merge like `name`: a supplied value overwrites,
 * an absent one preserves the stored value. There is no clear/removal mechanism.
 */
import type { IDID } from '../types.js'
import { InvalidRequestBodyError } from '../errors.js'

/**
 * Validates the OPTIONAL client-supplied Collection `generator` and returns the
 * value to persist, or `undefined` when absent (no attribution asserted). A
 * present value MUST be a non-empty string in the DID form (a `did:` prefix),
 * else `invalid-request-body` (400, pointer `#/generator`). The check is
 * deliberately shallow: the server does not resolve the DID, does not verify
 * that the application controls it, and never treats it as an authorization
 * input -- it is the controller's assertion, kept honest only against obvious
 * client bugs (a passed object, an empty string, a bare origin).
 *
 * @param options {object}
 * @param [options.generator] {unknown}   the request body's `generator` value
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {IDID | undefined}   the value to store, or undefined when absent
 */
export function assertValidGenerator({
  generator,
  requestName
}: {
  generator?: unknown
  requestName?: string
}): IDID | undefined {
  if (generator === undefined) {
    return undefined
  }
  if (!isDidString(generator)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Collection "generator" must be a DID string (starting "did:").',
      pointer: '#/generator'
    })
  }
  return generator
}

/**
 * Tests whether a value is a non-empty string in the DID form, narrowing it to
 * the `IDID` wire type. Shape only -- the DID is never resolved.
 *
 * @param value {unknown}   the candidate DID
 * @returns {boolean}
 */
function isDidString(value: unknown): value is IDID {
  return typeof value === 'string' && value.startsWith('did:')
}

/**
 * Validates the OPTIONAL client-supplied Collection `generatorOrigin` and
 * returns the value to persist, or `undefined` when absent. A present value
 * MUST be the ASCII serialization of a Web origin -- tested by round-tripping
 * it through the URL parser (`new URL(value).origin === value`), which rejects
 * an empty string, an unparseable value, and any spelling carrying a path,
 * query, fragment, credentials, or a trailing slash. A failure is
 * `invalid-request-body` (400, pointer `#/generatorOrigin`). Like `generator`,
 * the value is the controller's assertion: the server checks the shape, stores
 * it opaquely, and never verifies that the origin served the application.
 *
 * @param options {object}
 * @param [options.generatorOrigin] {unknown}   the request body's value
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {string | undefined}   the value to store, or undefined when absent
 */
export function assertValidGeneratorOrigin({
  generatorOrigin,
  requestName
}: {
  generatorOrigin?: unknown
  requestName?: string
}): string | undefined {
  if (generatorOrigin === undefined) {
    return undefined
  }
  if (typeof generatorOrigin !== 'string' || !isWebOrigin(generatorOrigin)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail:
        'Collection "generatorOrigin" must be the ASCII serialization of a Web origin (e.g. "https://app.example.com").',
      pointer: '#/generatorOrigin'
    })
  }
  return generatorOrigin
}

/**
 * Tests whether a string is exactly the ASCII serialization of a Web origin:
 * it parses as a URL AND that URL's `origin` re-serializes to the same string.
 * An opaque origin (a scheme with no host, which the URL parser serializes as
 * `"null"`) therefore fails unless the input itself was that serialization,
 * which the DID-shaped sibling never produces here.
 *
 * @param value {string}   the candidate origin serialization
 * @returns {boolean}
 */
function isWebOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value
  } catch {
    return false
  }
}
