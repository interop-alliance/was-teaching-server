/**
 * Single source of truth for the server's relative URL path templates. The route
 * shapes registered in `routes.ts` (`/space/:spaceId`, `/space/:spaceId/:col`,
 * the `policy` / `linkset` auxiliary resources) are mirrored here as builder
 * functions, so handlers and policy code construct the same paths from one place
 * rather than re-deriving them inline (which risks drift from the routes).
 *
 * These return the canonical, no-trailing-slash form. Trailing-slash "list/add"
 * variants stay at their call sites (the slash carries spec meaning there).
 */

/**
 * `/space/:spaceId`
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {string}
 */
export function spacePath({ spaceId }: { spaceId: string }): string {
  return `/space/${spaceId}`
}

/**
 * `/space/:spaceId/:collectionId`
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @returns {string}
 */
export function collectionPath({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId: string
}): string {
  return `/space/${spaceId}/${collectionId}`
}

/**
 * `/space/:spaceId/:collectionId/:resourceId`
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @returns {string}
 */
export function resourcePath({
  spaceId,
  collectionId,
  resourceId
}: {
  spaceId: string
  collectionId: string
  resourceId: string
}): string {
  return `/space/${spaceId}/${collectionId}/${resourceId}`
}

/**
 * The `policy` auxiliary resource path for whichever level the ids address:
 * Space (`spaceId`), Collection (`+ collectionId`), or Resource
 * (`+ collectionId + resourceId`).
 * @param options {object}
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}
 * @param [options.resourceId] {string}
 * @returns {string}
 */
export function policyPath({
  spaceId,
  collectionId,
  resourceId
}: {
  spaceId: string
  collectionId?: string
  resourceId?: string
}): string {
  if (collectionId !== undefined && resourceId !== undefined) {
    return `${resourcePath({ spaceId, collectionId, resourceId })}/policy`
  }
  if (collectionId !== undefined) {
    return `${collectionPath({ spaceId, collectionId })}/policy`
  }
  return `${spacePath({ spaceId })}/policy`
}

/**
 * The `linkset` discovery resource path for a Space (`spaceId`) or Collection
 * (`+ collectionId`).
 * @param options {object}
 * @param options.spaceId {string}
 * @param [options.collectionId] {string}
 * @returns {string}
 */
export function linksetPath({
  spaceId,
  collectionId
}: {
  spaceId: string
  collectionId?: string
}): string {
  const anchor =
    collectionId !== undefined
      ? collectionPath({ spaceId, collectionId })
      : spacePath({ spaceId })
  return `${anchor}/linkset`
}
