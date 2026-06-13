/**
 * Collection backend selection helpers (spec "Backends" / "Collection Backend
 * Selected"). A Collection carries an optional `backend` object whose `id` MUST
 * name one of the Space's backends-available; this module centralizes the three
 * operations that need that list: enumerating the available backends, validating
 * (and default-filling) a client-supplied `backend` on create/update, and
 * resolving a stored `{ id }` to its full descriptor for `GET .../backend`.
 *
 * This reference server ships a single server-configured backend (the active
 * `StorageBackend`, registered as `default`), so the available list has one
 * entry; the indirection leaves room for multiple registered backends later.
 */
import type {
  BackendDescriptor,
  CollectionDescription,
  StorageBackend
} from '../types.js'
import { InvalidRequestBodyError, UnsupportedBackendError } from '../errors.js'

/** The conventional id of the server-assigned default backend (spec). */
export const DEFAULT_BACKEND_ID = 'default'

/**
 * The backends registered for a Space, as advertised at
 * `GET /space/:spaceId/backends`. Currently the single active backend.
 * @param storage {StorageBackend}   the request's storage backend
 * @returns {BackendDescriptor[]}
 */
export function listAvailableBackends(
  storage: StorageBackend
): BackendDescriptor[] {
  return [storage.describe()]
}

/**
 * Validates a client-supplied Collection `backend` value and returns the
 * normalized `{ id }` to persist. An absent value defaults to the server's
 * default backend. A present-but-malformed value (not an object, or no string
 * `id`) is `invalid-request-body` (400); a well-formed value whose `id` is not
 * in the Space's backends-available is `unsupported-backend` (409).
 *
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param [options.backend] {unknown}   the request body's `backend` value
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {{ id: string }}   the normalized backend reference to store
 */
export function assertSupportedBackend({
  storage,
  backend,
  requestName
}: {
  storage: StorageBackend
  backend?: unknown
  requestName?: string
}): { id: string } {
  if (backend === undefined) {
    return { id: DEFAULT_BACKEND_ID }
  }
  if (
    typeof backend !== 'object' ||
    backend === null ||
    typeof (backend as { id?: unknown }).id !== 'string'
  ) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Collection "backend" must be an object with a string "id".',
      pointer: '#/backend'
    })
  }
  const { id } = backend as { id: string }
  if (!listAvailableBackends(storage).some(available => available.id === id)) {
    throw new UnsupportedBackendError({ backendId: id })
  }
  return { id }
}

/**
 * Resolves a Collection's selected backend to its full descriptor, for the
 * `GET .../backend` ("Collection Backend Selected") response. A stored
 * description without a `backend` (created before the property existed)
 * defaults to the server's default backend.
 *
 * @param options {object}
 * @param options.storage {StorageBackend}   the request's storage backend
 * @param options.collectionDescription {CollectionDescription}
 * @returns {BackendDescriptor}
 */
export function resolveBackendDescriptor({
  storage,
  collectionDescription
}: {
  storage: StorageBackend
  collectionDescription: CollectionDescription
}): BackendDescriptor {
  const id = collectionDescription.backend?.id ?? DEFAULT_BACKEND_ID
  const descriptor = listAvailableBackends(storage).find(
    available => available.id === id
  )
  // A stored backend id should always resolve (it was validated on write); fall
  // back to the default descriptor defensively rather than returning undefined.
  return descriptor ?? storage.describe()
}
