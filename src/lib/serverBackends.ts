/**
 * The server's own storage backends as one set (spec "Backends"). A
 * deployment configures any number of them, each by its own setting
 * (`WAS_DATA_DIR` for the filesystem backend, `DATABASE_URL` for Postgres),
 * and each carries a fixed id (`fs`, `postgres`) it reports from
 * `describe()`. `WAS_DEFAULT_BACKEND` names the one the conventional
 * `default` id aliases; it is the control plane (`request.server.storage`),
 * which holds every Space and Collection Metadata object, the policies, the
 * backend and replica registrations, and the Resources of every Collection
 * selecting `default` or its concrete id. A Collection selecting another
 * server backend's id has its Resources, listings and `changes` feed served
 * there. The set exposes the default wrapped by `mirroringControlPlane`
 * (lib/backendMirror.ts), so a write through it keeps the copies the other
 * server backends hold.
 *
 * A Collection's `backend.id` is stored as the client sent it: `default` stays
 * `default` and resolves through the alias on every read, so a deployment
 * that renames its default moves every `default` Collection's data plane. The
 * admin guide says so.
 */
import { mirroringControlPlane } from './backendMirror.js'
import type { BackendDescriptor, StorageBackend } from '../types.js'

/**
 * The conventional id of the server-assigned default backend (spec).
 */
export const DEFAULT_BACKEND_ID = 'default'

/**
 * The fixed id of the filesystem backend.
 */
export const FILESYSTEM_BACKEND_ID = 'fs'

/**
 * The fixed id of the Postgres backend.
 */
export const POSTGRES_BACKEND_ID = 'postgres'

/**
 * Every fixed server backend id. Reserved against client registration whether
 * or not the deployment configures the backend, so a later configuration
 * cannot collide with a Space's registered record.
 */
export const SERVER_BACKEND_IDS = [
  FILESYSTEM_BACKEND_ID,
  POSTGRES_BACKEND_ID
] as const

/**
 * A fixed server backend id.
 */
export type ServerBackendId = (typeof SERVER_BACKEND_IDS)[number]

/**
 * Whether `id` is a fixed server backend id, configured or not.
 * @param id {string}
 * @returns {boolean}
 */
export function isServerBackendId(id: string): id is ServerBackendId {
  return (SERVER_BACKEND_IDS as readonly string[]).includes(id)
}

/**
 * The server backends by their fixed ids, with the alias the deployment
 * picked. Built once by the plugin and decorated onto the instance as
 * `serverBackends`; the request layer and the pull loop read it to route a
 * Collection's data plane.
 */
export class ServerBackends {
  readonly #byId: ReadonlyMap<string, StorageBackend>
  readonly #defaultId: string
  readonly #others: readonly StorageBackend[]

  /**
   * @param options {object}
   * @param options.backends {StorageBackend[]}   the open backends, each
   *   under a distinct `describe().id`
   * @param [options.defaultId] {string}   the id `default` aliases; `fs` when
   *   that backend is configured, else the only one
   * @throws {Error}   two backends under one id, a `defaultId` naming no
   *   configured backend, no backend at all, or origin ids that differ
   */
  constructor({
    backends,
    defaultId
  }: {
    backends: StorageBackend[]
    defaultId?: string
  }) {
    if (backends.length === 0) {
      throw new Error(
        'No storage backend is configured. Set WAS_DATA_DIR for the ' +
          'filesystem backend, DATABASE_URL for Postgres, or both.'
      )
    }
    const byId = new Map<string, StorageBackend>()
    for (const backend of backends) {
      const { id } = backend.describe()
      if (id === DEFAULT_BACKEND_ID) {
        throw new Error(
          `A server backend may not describe itself as "${DEFAULT_BACKEND_ID}"; ` +
            'that id is the alias of the configured default.'
        )
      }
      if (byId.has(id)) {
        throw new Error(`Two storage backends carry the id "${id}".`)
      }
      byId.set(id, backend)
    }
    // Every backend mints write stamps for one store as a replication peer
    // sees it, so the origin id is one value for the process.
    const originIds = new Set(
      [...byId.values()].map(({ originId }) => originId)
    )
    if (originIds.size > 1) {
      throw new Error(
        'The configured storage backends carry different origin ids ' +
          `(${[...originIds].join(', ')}). Set WAS_ORIGIN_ID to one value ` +
          'so every backend stamps writes under it.'
      )
    }
    const configured = [...byId.keys()].join(', ')
    if (defaultId !== undefined && !byId.has(defaultId)) {
      throw new Error(
        `WAS_DEFAULT_BACKEND names "${defaultId}", which is not a ` +
          `configured storage backend (configured: ${configured}).`
      )
    }
    // Unset, the alias falls back to the filesystem backend, or to the only
    // configured backend; several without it is a choice the deployment makes.
    let resolvedDefaultId = defaultId
    if (resolvedDefaultId === undefined) {
      const [onlyId] = byId.keys()
      if (byId.has(FILESYSTEM_BACKEND_ID)) {
        resolvedDefaultId = FILESYSTEM_BACKEND_ID
      } else if (byId.size === 1 && onlyId !== undefined) {
        resolvedDefaultId = onlyId
      } else {
        throw new Error(
          'WAS_DEFAULT_BACKEND is unset and no filesystem backend is ' +
            `configured; name one of the configured backends (${configured}).`
        )
      }
    }
    // The default is served wrapped, so every writer of a container object,
    // the pull loop included, keeps the other backends' copies.
    byId.set(
      resolvedDefaultId,
      mirroringControlPlane({
        serverBackends: this,
        backend: byId.get(resolvedDefaultId)!
      })
    )
    this.#byId = byId
    this.#defaultId = resolvedDefaultId
    this.#others = [...byId.entries()]
      .filter(([id]) => id !== resolvedDefaultId)
      .map(([, backend]) => backend)
  }

  /**
   * The id `default` aliases.
   * @returns {string}
   */
  get defaultId(): string {
    return this.#defaultId
  }

  /**
   * The default backend: the control plane.
   * @returns {StorageBackend}
   */
  get default(): StorageBackend {
    return this.#byId.get(this.#defaultId)!
  }

  /**
   * Every configured server backend, the default first.
   * @returns {StorageBackend[]}
   */
  all(): StorageBackend[] {
    return [this.default, ...this.#others]
  }

  /**
   * Every configured server backend other than the default.
   * @returns {StorageBackend[]}
   */
  others(): StorageBackend[] {
    return [...this.#others]
  }

  /**
   * Whether `id` selects a server backend: `default`, or a configured
   * backend's fixed id.
   * @param id {string}
   * @returns {boolean}
   */
  has(id: string): boolean {
    return id === DEFAULT_BACKEND_ID || this.#byId.has(id)
  }

  /**
   * The server backend a Collection's `backend.id` selects: the default for
   * an absent id or `default`, the backend of a configured fixed id, and
   * `undefined` for any other id (a registered external backend, or an id this
   * deployment does not configure).
   * @param [id] {string}
   * @returns {StorageBackend | undefined}
   */
  resolve(id: string | undefined): StorageBackend | undefined {
    if (id === undefined || id === DEFAULT_BACKEND_ID) {
      return this.default
    }
    return this.#byId.get(id)
  }

  /**
   * The server backend other than the default a Collection's `backend.id`
   * selects: the one `resolve` finds when it is not the control plane, else
   * `undefined`. The mirror and export paths act on this backend alone.
   * @param [id] {string}
   * @returns {StorageBackend | undefined}
   */
  resolveOther(id: string | undefined): StorageBackend | undefined {
    const backend = this.resolve(id)
    return backend === this.default ? undefined : backend
  }

  /**
   * The `default` alias entry of a Space's backends-available: the default
   * backend's descriptor under the id `default`.
   * @returns {BackendDescriptor}
   */
  describeDefault(): BackendDescriptor {
    return { ...this.default.describe(), id: DEFAULT_BACKEND_ID }
  }

  /**
   * The server-managed entries of a Space's backends-available: the `default`
   * alias first, carrying the name of the backend it aliases, then each
   * configured backend under its fixed id.
   * @returns {BackendDescriptor[]}
   */
  describeAll(): BackendDescriptor[] {
    return [
      this.describeDefault(),
      ...this.all().map(backend => backend.describe())
    ]
  }
}
