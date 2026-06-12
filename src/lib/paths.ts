/**
 * Single source of truth for the server's relative URL path templates. The route
 * shapes registered in `routes.ts` (the `/spaces` repository, `/space/:spaceId`,
 * `/space/:spaceId/:collectionId`, the `policy` / `linkset` auxiliary resources,
 * and the `export` / `import` actions) are mirrored here as builder functions, so
 * handlers, the policy code, and the storage backends construct the same paths
 * from one place rather than re-deriving them inline (which risks drift from the
 * routes).
 *
 * Builders return the canonical, no-trailing-slash member form by default. The
 * spec assigns distinct meaning to a trailing slash -- it addresses the
 * container / "list-or-add-to" view of a member -- so the container builders take
 * an explicit `trailingSlash` option (or, for the always-container `/spaces/` and
 * `.../collections/`, bake the slash in) rather than leaving the slash to drift
 * across call sites. A leaf Resource has no children, so `resourcePath` has no
 * container form.
 */

/**
 * The SpacesRepository container (`/spaces/`) or one of its members
 * (`/spaces/:spaceId`). The member form is used for the `Location` header of a
 * newly created Space; the container form is the `POST`/`GET` target.
 * @param options {object}
 * @param [options.spaceId] {string}   when present, the repository member path;
 *   otherwise the (trailing-slash) container path
 * @returns {string}
 */
export function spacesPath({ spaceId }: { spaceId?: string } = {}): string {
  return spaceId !== undefined ? `/spaces/${spaceId}` : `/spaces/`
}

/**
 * `/space/:spaceId` (member) or `/space/:spaceId/` (container -- the
 * "add a Collection" / Space-as-container view) when `trailingSlash` is set.
 * @param options {object}
 * @param options.spaceId {string}
 * @param [options.trailingSlash] {boolean}   address the container form
 * @returns {string}
 */
export function spacePath({
  spaceId,
  trailingSlash = false
}: {
  spaceId: string
  trailingSlash?: boolean
}): string {
  return `/space/${spaceId}${trailingSlash ? '/' : ''}`
}

/**
 * `/space/:spaceId/collections/` -- the "List Collections" container path.
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {string}
 */
export function collectionsPath({ spaceId }: { spaceId: string }): string {
  return `${spacePath({ spaceId })}/collections/`
}

/**
 * `/space/:spaceId/export` -- the "Export Space" action path.
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {string}
 */
export function exportPath({ spaceId }: { spaceId: string }): string {
  return `${spacePath({ spaceId })}/export`
}

/**
 * `/space/:spaceId/import` -- the "Import Space" action path.
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {string}
 */
export function importPath({ spaceId }: { spaceId: string }): string {
  return `${spacePath({ spaceId })}/import`
}

/**
 * `/space/:spaceId/:collectionId` (member) or `/space/:spaceId/:collectionId/`
 * (container -- the "add a Resource" / "list items" view) when `trailingSlash`
 * is set.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param [options.trailingSlash] {boolean}   address the container form
 * @returns {string}
 */
export function collectionPath({
  spaceId,
  collectionId,
  trailingSlash = false
}: {
  spaceId: string
  collectionId: string
  trailingSlash?: boolean
}): string {
  return `/space/${spaceId}/${collectionId}${trailingSlash ? '/' : ''}`
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
 * `/space/:spaceId/backends` -- the "Space Backends Available" list path.
 * @param options {object}
 * @param options.spaceId {string}
 * @returns {string}
 */
export function backendsPath({ spaceId }: { spaceId: string }): string {
  return `${spacePath({ spaceId })}/backends`
}

/**
 * `/space/:spaceId/:collectionId/:resourceId/meta` -- the Resource Metadata
 * (reserved `meta` segment) path. Reserved only at the Resource level, so it
 * takes the full id triple.
 * @param options {object}
 * @param options.spaceId {string}
 * @param options.collectionId {string}
 * @param options.resourceId {string}
 * @returns {string}
 */
export function metaPath({
  spaceId,
  collectionId,
  resourceId
}: {
  spaceId: string
  collectionId: string
  resourceId: string
}): string {
  return `${resourcePath({ spaceId, collectionId, resourceId })}/meta`
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
