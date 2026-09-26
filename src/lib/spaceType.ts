/**
 * Validation and inspection of a Space Metadata object's `type` member.
 *
 * A Space Metadata object's `type` is an array of type names subtyping `Space`, so
 * a Space may declare a more specific role while every consumer keeps matching
 * on the base `Space` type. An auxiliary Space -- one holding server-side
 * bookkeeping rather than user data, e.g.
 * `['AuxiliarySpace', 'DelegatedClientsSpace', 'Space']` -- is excluded from
 * user-data listings on that basis.
 *
 * `type` is set at creation and immutable afterwards, so a Space cannot change
 * role under a consumer that already classified it.
 */
import { InvalidRequestBodyError } from '../errors.js'

/** The base type every Space Metadata object carries. */
const BASE_SPACE_TYPE = 'Space'

/**
 * The general subtype for a Space that is not a user data Space. Auxiliary
 * Spaces are excluded from List Spaces.
 */
export const AUXILIARY_SPACE_TYPE = 'AuxiliarySpace'

/**
 * The auxiliary-Space subtype naming a wallet's delegated-clients bookkeeping
 * Space. The annex-chain inspector (`lib/clientAnnexClause.ts`) admits a
 * ladder-signed delegation whose `invocationTarget` is the trailing-slash URL
 * of a Space so typed. Because that widens what a ladder VM may delegate, the
 * subtype is only valid alongside `AuxiliarySpace` ({@link
 * assertValidSpaceType}): a Space carrying it is bookkeeping by declaration
 * and excluded from List Spaces, so it cannot double as a listed data Space.
 */
export const DELEGATED_CLIENTS_SPACE_TYPE = 'DelegatedClientsSpace'

/**
 * Validates a client-supplied Space Metadata `type` and returns it, or
 * `undefined` when the request body carries none (the caller defaults it).
 *
 * A supplied `type` MUST be a non-empty array of non-empty strings that
 * includes the base `Space` type; anything else is a 400 on `#/type`. A type
 * naming `DelegatedClientsSpace` MUST also name `AuxiliarySpace` (see the
 * constant's note), refused the same way.
 *
 * @param type {unknown}   the `type` value from the request body
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 * @returns {string[] | undefined}   the validated type array, or undefined
 */
export function assertValidSpaceType(
  type: unknown,
  { requestName }: { requestName?: string } = {}
): string[] | undefined {
  if (type === undefined) {
    return undefined
  }
  const problem = spaceTypeProblem(type)
  if (problem !== undefined) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: problem,
      pointer: '#/type'
    })
  }
  return type as string[]
}

/**
 * The rule behind {@link assertValidSpaceType}, as a description of what is
 * wrong with a `type` value rather than a thrown error, for a caller that
 * drops an invalid value instead of refusing the request (the import of an
 * archived Space Metadata object).
 *
 * @param type {unknown}   a `type` value
 * @returns {string | undefined}   why the value is not a valid Space Metadata
 *   `type`, or undefined when it is
 */
export function spaceTypeProblem(type: unknown): string | undefined {
  const valid =
    Array.isArray(type) &&
    type.length > 0 &&
    type.every(entry => typeof entry === 'string' && entry.length > 0) &&
    type.includes(BASE_SPACE_TYPE)
  if (!valid) {
    return (
      'The Space Metadata "type" property must be a non-empty array of' +
      ` type names that includes "${BASE_SPACE_TYPE}".`
    )
  }
  const typeArray = type as string[]
  if (
    typeArray.includes(DELEGATED_CLIENTS_SPACE_TYPE) &&
    !typeArray.includes(AUXILIARY_SPACE_TYPE)
  ) {
    return (
      `A Space Metadata "type" naming "${DELEGATED_CLIENTS_SPACE_TYPE}"` +
      ` must also name "${AUXILIARY_SPACE_TYPE}".`
    )
  }
  return undefined
}

/**
 * The default `type` for a Space created without one.
 * @returns {string[]}
 */
export function defaultSpaceType(): string[] {
  return [BASE_SPACE_TYPE]
}

/**
 * The immutability rule behind Update Space and the import of an archived
 * Space Metadata object, as a description of what is wrong with a requested
 * `type` rather than a thrown error, since the two callers refuse with
 * different error classes: a Space's `type` is set at creation and cannot
 * change once the Space exists, so a requested value must name the same set of
 * types the stored object does (`isSameTypeSet`).
 *
 * @param options {object}
 * @param options.requested {unknown}   the `type` a write asks for
 * @param options.stored {unknown}   the existing Space's `type`
 * @returns {string | undefined}   why the requested value is refused, or
 *   undefined when it names the stored set
 */
export function spaceTypeChangeProblem({
  requested,
  stored
}: {
  requested: unknown
  stored: unknown
}): string | undefined {
  if (isSameTypeSet({ left: requested, right: stored })) {
    return undefined
  }
  return 'The Space Metadata "type" is immutable once the Space exists.'
}

/**
 * Whether two Space Metadata `type` values name the same set of types,
 * ignoring order and repetition. The comparison behind
 * {@link spaceTypeChangeProblem}.
 * @param options {object}
 * @param options.left {unknown}   one type value (an array, or anything else)
 * @param options.right {unknown}   the other type value
 * @returns {boolean}
 */
export function isSameTypeSet({
  left,
  right
}: {
  left: unknown
  right: unknown
}): boolean {
  const leftSet = new Set(Array.isArray(left) ? left : [])
  const rightSet = new Set(Array.isArray(right) ? right : [])
  if (leftSet.size !== rightSet.size) {
    return false
  }
  for (const entry of leftSet) {
    if (!rightSet.has(entry)) {
      return false
    }
  }
  return true
}

/**
 * Whether a Space Metadata object declares itself an auxiliary Space.
 * @param spaceMetadata {{ type?: unknown } | undefined}
 * @returns {boolean}
 */
export function isAuxiliarySpace(
  spaceMetadata: { type?: unknown } | undefined
): boolean {
  const { type } = spaceMetadata ?? {}
  return Array.isArray(type) && type.includes(AUXILIARY_SPACE_TYPE)
}

/**
 * Whether a Space Metadata object declares itself a delegated-clients bookkeeping
 * Space: typed with both `AuxiliarySpace` and `DelegatedClientsSpace`, the
 * only combination {@link assertValidSpaceType} admits for the latter. The
 * membership check behind the annex clause's whole-Space branch.
 * @param spaceMetadata {{ type?: unknown } | undefined}
 * @returns {boolean}
 */
export function isDelegatedClientsSpace(
  spaceMetadata: { type?: unknown } | undefined
): boolean {
  const { type } = spaceMetadata ?? {}
  return (
    Array.isArray(type) &&
    type.includes(AUXILIARY_SPACE_TYPE) &&
    type.includes(DELEGATED_CLIENTS_SPACE_TYPE)
  )
}
