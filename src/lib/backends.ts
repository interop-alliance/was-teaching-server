/**
 * Collection backend selection helpers (spec "Backends" / "Collection Backend
 * Selected"). A Collection carries an optional `backend` object whose `id` MUST
 * name one of the Space's backends-available; this module centralizes the three
 * operations that need that list: enumerating the available backends, validating
 * (and default-filling) a client-supplied `backend` on create/update, and
 * resolving a stored `{ id }` to its full descriptor for `GET .../backend`.
 *
 * The server's own backends are the `ServerBackends` set (lib/serverBackends.ts):
 * every Space's backends-available opens with the `default` alias and each
 * configured server backend under its fixed id, followed by the Space's
 * registered `external` records.
 */
import type {
  BackendDescriptor,
  BackendConnectionPublic,
  BackendRegistration,
  CollectionMetadata,
  StoredBackendRecord
} from '../types.js'
import { InvalidRequestBodyError, UnsupportedBackendError } from '../errors.js'
import { isUrlSafeSegment } from './validateId.js'
import {
  DEFAULT_BACKEND_ID,
  isServerBackendId,
  type ServerBackendId,
  type ServerBackends
} from './serverBackends.js'

/**
 * Builds the self-description a server-configured backend advertises at
 * `GET /space/:spaceId/backends`. Every such backend is server-managed,
 * stores both JSON documents and binary blobs, and survives restarts -- its
 * fixed `id` and display `name` distinguish them.
 *
 * The descriptor advertises no affordances. The guarantees a Collection needs
 * -- conditional writes, the `epoch` stamp, the `writerId` writer-attribution
 * label -- are baseline requirements of every backend a Collection may be
 * created on, because the server, not the storage engine, serializes each
 * write and mints its own opaque validator.
 *
 * The wire type only REQUIRES `id`; a server backend always populates every
 * field except the `external`-only `provider` / `connection`, so the return is
 * the stricter `Required<Omit<..., 'provider' | 'connection'>>` (which also
 * lets the quota reports read a non-optional `managedBy` off `describe()`).
 * @param options {object}
 * @param options.id {string}   the backend's fixed id (`fs`, `postgres`)
 * @param options.name {string}   the backend's display name
 * @returns {Required<Omit<BackendDescriptor, 'provider' | 'connection'>>}
 */
export function serverBackendDescriptor({
  id,
  name
}: {
  id: ServerBackendId
  name: string
}): Required<Omit<BackendDescriptor, 'provider' | 'connection'>> {
  return {
    id,
    name,
    managedBy: 'server',
    persistence: 'durable'
  }
}

// `listRegisteredBackends` (defined below, with the registration helpers) is the
// single source of a Space's selectable backends -- the server backends plus
// its registered `external` records -- used by both the selection-validation
// (`assertSupportedBackend`) and descriptor-resolution (`resolveBackendDescriptor`)
// paths below.

/** The public (secret-free) subset of a connection a sanitized read may carry. */
const PUBLIC_CONNECTION_FIELDS = [
  'account',
  'scope',
  'connectedAt',
  'rootFolderName'
] as const

/**
 * Validates a client-supplied Collection `backend` value and returns the
 * normalized `{ id }` to persist. An absent value defaults to the server's
 * default backend. A present-but-malformed value (not an object, or no string
 * `id`) is `invalid-request-body` (400); a well-formed value whose `id` is not
 * in the Space's backends-available (the server backends plus its registered
 * `external` backends) is `unsupported-backend` (409). The id is stored as
 * sent: `default` stays the alias. Routing the data plane of the selected
 * backend is the resolver's job (lib/backendRegistry.ts).
 *
 * @param options {object}
 * @param options.serverBackends {ServerBackends}   the server's own backends
 * @param options.spaceId {string}   the Space whose backends-available is checked
 * @param [options.backend] {unknown}   the request body's `backend` value
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {Promise<{ id: string }>}   the normalized backend reference to store
 */
export async function assertSupportedBackend({
  serverBackends,
  spaceId,
  backend,
  requestName
}: {
  serverBackends: ServerBackends
  spaceId: string
  backend?: unknown
  requestName?: string
}): Promise<{ id: string }> {
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
  // The server's own backends head every Space's backends-available, so
  // selecting one needs no read of the registered records.
  if (serverBackends.has(id)) {
    return { id }
  }
  const available = await listRegisteredBackends({ serverBackends, spaceId })
  if (!available.some(entry => entry.id === id)) {
    throw new UnsupportedBackendError({ backendId: id })
  }
  return { id }
}

/**
 * Resolves a Collection's selected backend to its full descriptor, for the
 * `GET .../backend` ("Collection Backend Selected") response, consulting the
 * Space's backends-available (the server backends plus the registered
 * `external` records). A stored description without a `backend` (created
 * before the property existed) resolves as `default`.
 *
 * @param options {object}
 * @param options.serverBackends {ServerBackends}   the server's own backends
 * @param options.spaceId {string}   the Space whose backends-available is checked
 * @param options.collectionMetadata {CollectionMetadata}
 * @returns {Promise<BackendDescriptor>}
 */
export async function resolveBackendDescriptor({
  serverBackends,
  spaceId,
  collectionMetadata
}: {
  serverBackends: ServerBackends
  spaceId: string
  collectionMetadata: CollectionMetadata
}): Promise<BackendDescriptor> {
  const id = collectionMetadata.backend?.id ?? DEFAULT_BACKEND_ID
  const available = await listRegisteredBackends({ serverBackends, spaceId })
  const descriptor = available.find(entry => entry.id === id)
  // A stored backend id should always resolve (it was validated on write); fall
  // back to the default alias defensively rather than returning undefined.
  return descriptor ?? serverBackends.describeDefault()
}

// --- External backend registration (spec "Backends") ---
//
// A registered `external` backend is both listed (below) and now *selectable* as
// a Collection's `backend` (`assertSupportedBackend` / `resolveBackendDescriptor`
// above consult `listRegisteredBackends`). Routing the selected Collection's data
// plane to the live provider adapter is the resolver's job
// (lib/backendRegistry.ts); a selected backend with no registered provider
// adapter fails closed there.

/**
 * Projects a full (secret-bearing) `StoredBackendRecord` down to the sanitized
 * `BackendDescriptor` that every client-facing read path returns: the public
 * descriptor fields plus a `connection` reduced to its public subset (no
 * `authorizationCode` / `refreshToken` / etc.). The single projection shared by
 * `FileSystemBackend.listBackends` and the register (`POST`/`PUT`) responses, so
 * the secret material has exactly one place it could leak -- and does not.
 * @param record {StoredBackendRecord}
 * @returns {BackendDescriptor}
 */
export function sanitizeBackendRecord(
  record: StoredBackendRecord
): BackendDescriptor {
  const { connection } = record
  const publicConnection: BackendConnectionPublic = {
    kind: connection.kind,
    status:
      (connection.status as BackendConnectionPublic['status']) ?? 'registered'
  }
  for (const field of PUBLIC_CONNECTION_FIELDS) {
    const value = connection[field]
    if (typeof value === 'string') {
      publicConnection[field] = value
    }
  }
  return {
    id: record.id,
    ...(record.name !== undefined && { name: record.name }),
    managedBy: record.managedBy,
    ...(record.persistence !== undefined && {
      persistence: record.persistence
    }),
    provider: record.provider,
    connection: publicConnection
  }
}

/**
 * The backends advertised at `GET /space/:spaceId/backends`: the server's
 * own backends first (the `default` alias, then each under its fixed id),
 * followed by the Space's sanitized registered `external` backends, read from
 * the default backend, which holds the registrations. Also the single source
 * of a Space's selectable backends for `assertSupportedBackend` /
 * `resolveBackendDescriptor`.
 * @param options {object}
 * @param options.serverBackends {ServerBackends}
 * @param options.spaceId {string}
 * @returns {Promise<BackendDescriptor[]>}
 */
export async function listRegisteredBackends({
  serverBackends,
  spaceId
}: {
  serverBackends: ServerBackends
  spaceId: string
}): Promise<BackendDescriptor[]> {
  return [
    ...serverBackends.describeAll(),
    ...(await serverBackends.default.listBackends({ spaceId }))
  ]
}

/**
 * Validates a backend-registration request body and returns the typed
 * `BackendRegistration`. Enforces: an object body; a string `id`; a non-empty
 * string `provider`; `managedBy` absent or `'external'` (a client may not
 * register a `server` backend); and a `connection` object with a string `kind`.
 * Throws `InvalidRequestBodyError` (400) with the offending `#/...` pointer.
 * Does not check `id` URL-safety -- callers run `assertValidBackendId`.
 * @param body {unknown}   the parsed request body
 * @param options {object}
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {BackendRegistration}
 */
export function parseBackendRegistration(
  body: unknown,
  { requestName }: { requestName?: string } = {}
): BackendRegistration {
  if (typeof body !== 'object' || body === null) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Backend registration body must be a JSON object.',
      pointer: '#'
    })
  }
  const candidate = body as Record<string, unknown>
  if (typeof candidate.id !== 'string') {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Backend registration requires a string "id".',
      pointer: '#/id'
    })
  }
  if (
    typeof candidate.provider !== 'string' ||
    candidate.provider.length === 0
  ) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Backend registration requires a non-empty string "provider".',
      pointer: '#/provider'
    })
  }
  if (candidate.managedBy !== undefined && candidate.managedBy !== 'external') {
    throw new InvalidRequestBodyError({
      requestName,
      detail:
        'Backend "managedBy" must be "external"; server backends are not client-registered.',
      pointer: '#/managedBy'
    })
  }
  const connection = candidate.connection
  if (
    typeof connection !== 'object' ||
    connection === null ||
    typeof (connection as Record<string, unknown>).kind !== 'string'
  ) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Backend "connection" must be an object with a string "kind".',
      pointer: '#/connection'
    })
  }
  return {
    id: candidate.id,
    ...(typeof candidate.name === 'string' && { name: candidate.name }),
    managedBy: 'external',
    provider: candidate.provider,
    connection: connection as BackendRegistration['connection']
  }
}

/**
 * Enforces the optional server-wide registration allowlist (config
 * `WAS_ENABLED_BACKENDS`): the set of backend `provider` names a client may
 * register. An `undefined` allowlist is **permissive** -- any provider passes,
 * preserving the prior behavior where any provider could be registered. When the
 * allowlist is configured, a `provider` outside it is rejected with
 * `unsupported-backend` (409) pointing at `#/provider`. This is the fail-fast
 * registration gate; the resolver's data-plane factory check
 * (lib/backendRegistry.ts) remains the backstop for a provider with no live
 * adapter.
 * @param options {object}
 * @param options.provider {string}   the registration's `provider`
 * @param [options.enabledProviders] {string[]}   the configured allowlist, or
 *   `undefined` for permissive
 * @returns {void}
 */
export function assertProviderAllowed({
  provider,
  enabledProviders
}: {
  provider: string
  enabledProviders?: string[]
}): void {
  if (enabledProviders === undefined) {
    return
  }
  if (!enabledProviders.includes(provider)) {
    throw new UnsupportedBackendError({
      backendId: provider,
      detail: `Backend provider '${provider}' is not enabled on this server.`,
      pointer: '#/provider'
    })
  }
}

/**
 * Asserts a registered-backend id is a single URL-safe path segment (it becomes
 * both a URL segment and a `.backend.<id>.json` filename). A backend id is a
 * body field, so a failure is `invalid-request-body` (400) pointing at `#/id`
 * rather than a URL-param id error.
 * @param id {string}
 * @param options {object}
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {void}
 */
export function assertValidBackendId(
  id: string,
  { requestName }: { requestName?: string } = {}
): void {
  if (!isUrlSafeSegment(id)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Backend "id" must be a single, URL-safe path segment.',
      pointer: '#/id'
    })
  }
}

/**
 * Rejects a server backend id for a registered backend: `default` and each
 * fixed server backend id (`fs`, `postgres`) name the server's own backends,
 * configured or not, and cannot be registered (or replaced) by a client.
 * Throws `InvalidRequestBodyError` (400) with pointer `#/id`.
 * @param options {object}
 * @param options.backendId {string}   the backend id being registered
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {void}
 */
export function assertNotServerBackendId({
  backendId,
  requestName
}: {
  backendId: string
  requestName?: string
}): void {
  if (backendId === DEFAULT_BACKEND_ID || isServerBackendId(backendId)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: `"${backendId}" is a reserved server backend id and cannot be registered.`,
      pointer: '#/id'
    })
  }
}

/**
 * Assembles the full `StoredBackendRecord` to persist from a validated
 * `BackendRegistration`: the descriptor fields, `managedBy: 'external'`, and the
 * full (secret-bearing) connection stamped
 * with `status: 'registered'` and the registration timestamp. The record is
 * inert until the live provider adapter (future work) connects it.
 * @param registration {BackendRegistration}
 * @returns {StoredBackendRecord}
 */
export function buildBackendRecord(
  registration: BackendRegistration
): StoredBackendRecord {
  const { id, name, provider, connection } = registration
  return {
    id,
    ...(name !== undefined && { name }),
    managedBy: 'external',
    provider,
    connection: {
      ...connection,
      status: 'registered',
      connectedAt: new Date().toISOString()
    }
  }
}
