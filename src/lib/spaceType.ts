/**
 * Validation and inspection of a Space Description's `type` member.
 *
 * A Space Description's `type` is an array of type names subtyping `Space`, so
 * a Space may declare a more specific role while every consumer keeps matching
 * on the base `Space` type. An auxiliary Space -- one holding server-side
 * bookkeeping rather than user data, e.g.
 * `['Space', 'AuxiliarySpace', 'DelegatedClientsSpace']` -- is excluded from
 * user-data listings on that basis.
 *
 * `type` is set at creation and immutable afterwards, so a Space cannot change
 * role under a consumer that already classified it.
 */
import { InvalidRequestBodyError } from '../errors.js'

/** The base type every Space Description carries. */
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
 * Validates a client-supplied Space Description `type` and returns it, or
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
  const valid =
    Array.isArray(type) &&
    type.length > 0 &&
    type.every(entry => typeof entry === 'string' && entry.length > 0) &&
    type.includes(BASE_SPACE_TYPE)
  if (!valid) {
    throw new InvalidRequestBodyError({
      requestName,
      detail:
        'The Space Description "type" property must be a non-empty array of' +
        ` type names that includes "${BASE_SPACE_TYPE}".`,
      pointer: '#/type'
    })
  }
  const typeArray = type as string[]
  if (
    typeArray.includes(DELEGATED_CLIENTS_SPACE_TYPE) &&
    !typeArray.includes(AUXILIARY_SPACE_TYPE)
  ) {
    throw new InvalidRequestBodyError({
      requestName,
      detail:
        `A Space Description "type" naming "${DELEGATED_CLIENTS_SPACE_TYPE}"` +
        ` must also name "${AUXILIARY_SPACE_TYPE}".`,
      pointer: '#/type'
    })
  }
  return typeArray
}

/**
 * The default `type` for a Space Description created without one.
 * @returns {string[]}
 */
export function defaultSpaceType(): string[] {
  return [BASE_SPACE_TYPE]
}

/**
 * Whether two Space Description `type` values name the same set of types,
 * ignoring order and repetition. The immutability comparison behind Update
 * Space.
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
 * Whether a Space Description declares itself an auxiliary Space.
 * @param spaceDescription {{ type?: unknown } | undefined}
 * @returns {boolean}
 */
export function isAuxiliarySpace(
  spaceDescription: { type?: unknown } | undefined
): boolean {
  const { type } = spaceDescription ?? {}
  return Array.isArray(type) && type.includes(AUXILIARY_SPACE_TYPE)
}

/**
 * Whether a Space Description declares itself a delegated-clients bookkeeping
 * Space: typed with both `AuxiliarySpace` and `DelegatedClientsSpace`, the
 * only combination {@link assertValidSpaceType} admits for the latter. The
 * membership check behind the annex clause's whole-Space branch.
 * @param spaceDescription {{ type?: unknown } | undefined}
 * @returns {boolean}
 */
export function isDelegatedClientsSpace(
  spaceDescription: { type?: unknown } | undefined
): boolean {
  const { type } = spaceDescription ?? {}
  return (
    Array.isArray(type) &&
    type.includes(AUXILIARY_SPACE_TYPE) &&
    type.includes(DELEGATED_CLIENTS_SPACE_TYPE)
  )
}
