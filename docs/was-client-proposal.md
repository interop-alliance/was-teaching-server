# Design: `@interop/was-client` -- a developer-friendly WAS client

## Context

The WAS protocol is currently exercised only through raw `@interop/ezcap`
`ZcapClient.request(...)` calls (see `was-teaching-server/conformance/`). Every
operation hand-builds a full URL, picks the right trailing-slash variant, sets
`method`/`action`, threads JSON vs binary bodies, and reasons about zcap
delegation inline. This is the low-level transport; it is not an ergonomic
surface for application developers.

The goal is a **higher-level WAS client** that wraps an ezcap `ZcapClient`
(which already holds the active signer / key material) and exposes the WAS
containment model (`SpacesRepository > Space > Collection > Resource`) through
navigational handles modeled on the MongoDB driver's DX (cheap lazy handles,
result objects, cursors-ish listings, options-last signatures), while staying
focused on what WAS actually supports today (no query-by-filter yet).

The conformance suite is the de-facto catalogue of "operations worth
abstracting"; the acceptance bar for this design is that the conformance
scenarios can be re-expressed through the client with no loss of coverage.

### Decisions locked in (from planning Q&A)

- **Naming flavor:** Hybrid. MongoDB-style navigational handles + result
  objects, but WAS-specific verbs (`add`/`get`/`put`/`remove`/`list`), not
  `insertOne`/`findOne` (which would imply query filters WAS currently lacks).
- **v1 scope:** everything -- core CRUD, delegation/sharing, export/import, and
  first-class binary resources.
- **Package home:** new standalone package `@interop/was-client` depending on
  `@interop/ezcap`.
- **Read miss:** reads return `null` on 404 (MongoDB `findOne` semantics).
  Documented caveat: WAS returns 404 for *both* not-found and unauthorized, so
  `null` means "not visible to you."

## Dependencies Interface

- `ZcapClient` (ezcap 7.1.1, `ezcap/src/ZcapClient.ts`):
  - Constructor:
    `new ZcapClient({ SuiteClass, invocationSigner, delegationSigner })`.
  -
  `request({ url, capability?, method='GET', action?, headers?, json?, body? })`
  -- `action` defaults to `method`. **We must use `request()`, not the
  `read()`/`write()` helpers**: those send `action:'read'`/`'write'`, but the
  WAS server authorizes on HTTP-verb actions (`GET/POST/PUT/DELETE`), as the
  conformance tests confirm.
  -
  `delegate({ controller, invocationTarget?, allowedActions?, expires?, capability? })`
  returns a signed delegated zcap; `expires` defaults to 5 min,
  `allowedActions` to `[]` (= all). Narrowing `invocationTarget` to a sub-path
  is supported.
  - `body` is typed `Blob | Uint8Array` (no streams) -- relevant to binary.
  - Digest header for bodies is computed internally by
    `signCapabilityInvocation`; the client does **not** compute digests.
- `@interop/http-client` (`src/httpClient.ts`) is ky-based: **throws on non-2xx
  **
  with `err.status`, `err.response`, and `err.data` = parsed `problem+json`
  (`{ title, errors:[{detail}] }`). Success returns an `HttpResponse` with
  `.data` auto-parsed only for JSON content-types (undefined for binary; read
  the body).
- Server contract (routes/handlers): POST creates with server-gen id +
  `Location`; PUT is create-or-update by id; trailing-slash is canonicalized per
  operation; resources are single-representation blobs keyed by id;
  `GET /spaces/`
  is currently `501`.

## Design overview

### Construction

```ts
import { WasClient } from '@interop/was-client'

// Primary form: wrap an existing ezcap ZcapClient (holds the signer).
const was = new WasClient({serverUrl, zcapClient})

// Optional convenience: build the ZcapClient internally from a signer.
const was = WasClient.fromSigner({serverUrl, signer})  // uses Ed25519Signature2020
```

- `serverUrl` is the base for **both** URL building and zcap `invocationTarget`s,
  so the "SERVER_URL must equal invocationTarget host:port" constraint is
  satisfied by construction.
- The signer's controller DID is derivable as
  `zcapClient.invocationSigner.id.split('#')[0]`; used to default `controller`
  on `createSpace`.

### Handle model (consistent at every level)

Each container exposes **self-lifecycle** verbs and **contained-item** verbs,
mirroring `MongoClient` to `db` to `collection`:

| Level                | Handle factory            | Self lifecycle                          | Contained items                                              |
|----------------------|---------------------------|-----------------------------------------|-------------------------------------------------------------|
| `SpacesRepository`   | --                        | --                                      | `space(id)`, `createSpace()`, `listSpaces()`                |
| `Space`              | `was.space(id)`           | `describe()`, `configure()`, `delete()` | `collection(id)`, `createCollection()`, `collections()`     |
| `Collection`         | `space.collection(id)`    | `describe()`, `configure()`, `delete()` | `resource(id)`, `add()`, `get(id)`, `put(id,data)`, `list()` |
| `Resource`           | `collection.resource(id)` | `get()`, `put(data)`, `delete()`        | --                                                          |

Handles are **lazy and synchronous to obtain** (no I/O); only the verb methods
hit the network. `describe()`/`get()`/`list()` are reads (null on 404).

**One delete verb, bound to the handle.** `delete()` is uniform at every level,
takes **no argument**, and always deletes the thing the handle points at
(`space.delete()` / `collection.delete()` / `resource.delete()`). It is
idempotent. Because `delete()` never takes an id, there is no
`collection.delete()` (whole collection) vs `collection.delete(id)` (one item)
footgun -- deleting a resource by id is the explicit
`collection.resource(id).delete()`.

**Lazy chains never throw.** `was.space(x).collection(y)` does no I/O and
succeeds even if `x` does not exist -- both calls just accumulate URL context.
Existence is checked on the first network verb: a **read** (`list`/`get`/
`describe`) returns `null` on a missing/unauthorized parent; a **write**
(`add`/`put`) throws `NotFoundError`, because -- unlike MongoDB -- WAS does
**not** auto-create parent containers.

### Full surface

```ts
class WasClient {
  constructor(opts: { serverUrl: string; zcapClient: ZcapClient })

  static fromSigner(opts: { serverUrl: string; signer: ISigner }): WasClient

  space(spaceId: string, opts?: { capability?: IZcap }): Space

  createSpace(desc: {
    id?: string;
    name?: string;
    controller?: string
  }): Promise<Space>

  listSpaces(): Promise<SpaceListing>          // server is 501 today: NotImplementedError
  fromCapability(zcap: IZcap): Space | Collection | Resource  // depth from invocationTarget

  grant(opts: GrantOptions): Promise<IZcap>     // general delegation primitive (target/capability explicit)
  request(opts: RequestInput): Promise<HttpResponse>  // signed escape hatch; raw response, raw errors
}

class Space {
  readonly id: string

  describe(): Promise<SpaceDescription | null>             // GET /space/:id
  configure(desc: { name?; controller? }): Promise<SpaceDescription>  // PUT /space/:id
  delete(): Promise<void>                                  // DELETE /space/:id

  collection(id: string, opts?): Collection

  createCollection(desc: { id?; name? }): Promise<Collection>  // POST /space/:id/
  collections(): Promise<CollectionListing>               // GET /space/:id/collections/

  grant(opts: GrantOptions): Promise<IZcap>                // delegate, target = this space URL
  export(): Promise<Uint8Array>                           // POST /space/:id/export (x-tar)
  import(tar: Uint8Array | Blob): Promise<ImportStats>    // POST /space/:id/import
}

class Collection {
  readonly spaceId: string
  readonly id: string

  describe(): Promise<CollectionDescription | null>       // GET /space/:id/:cid
  configure(desc: { name? }): Promise<CollectionDescription>  // PUT /space/:id/:cid
  delete(): Promise<void>                                 // DELETE /space/:id/:cid (the collection)

  resource(id: string, opts?): Resource

  add(data: Json | Blob | Uint8Array | Buffer,
      opts?: { contentType?: string }): Promise<AddResult>   // POST /space/:id/:cid/
  get(resourceId: string): Promise<Json | Blob | null>       // GET resource (auto JSON)
  put(resourceId: string, data, opts?: { contentType? }): Promise<void>  // PUT resource
  list(): Promise<ResourceListing>                        // GET /space/:id/:cid/
  // delete a resource by id via the handle: collection.resource(id).delete()

  grant(opts: GrantOptions): Promise<IZcap>                // target = this collection URL
}

class Resource {                                          // sugar over Collection item ops
  get(): Promise<Json | Blob | null>

  getText(): Promise<string | null>

  getBytes(): Promise<Uint8Array | null>

  put(data, opts?): Promise<void>

  delete(): Promise<void>                                 // DELETE the resource
}
```

### Binary vs JSON resources

- **Write** (`add`/`put`): if `data` is a plain object/array it is sent as JSON
  (`contentType` defaults `application/json`); if `Blob`/`Uint8Array`/`Buffer`
  it is sent as binary (`contentType` from `opts.contentType` or `Blob.type`,
  else `application/octet-stream`). `Buffer` is coerced to `Uint8Array` for
  ezcap. (Streaming upload is out of scope: ezcap `body` is `Blob | Uint8Array`;
  large-file streaming is a later enhancement.)
- **Read** (`get`): auto-parse -- returns the parsed object when the stored
  content-type is JSON, otherwise a `Blob` (whose `.type` carries the
  content-type). `getText()` / `getBytes()` are explicit escape hatches.

### Delegation / sharing

```ts
interface GrantOptions {
  to: string                       // delegate's controller DID
  actions: Action[]                // 'read'|'write'|'delete' aliases, or raw 'GET'|'PUT'|'POST'|'DELETE'
  expires?: string | Date          // default: ezcap's 5-minute default
  target?: string                  // invocationTarget URL (top-level grant); scoped grants fill this
  capability?: IZcap                // parent capability to attenuate/re-delegate (delegation chains)
}
```

- **`was.grant(...)` is the general primitive.** It maps to
  `zcapClient.delegate({ controller: to, invocationTarget: target, allowedActions, expires, capability })`
  and returns the signed zcap to hand off out-of-band. The two extra fields are
  what make it a superset: an arbitrary `target` (delegate against any URL,
  handle or not) and a parent `capability` (re-delegation/attenuation -- Bob,
  holding a delegated zcap, grants onward to Carol).
- **`space.grant(...)` / `collection.grant(...)` are sugar** that prefill
  `target` with that handle's URL (the common-case DX win over raw `delegate`).
  A capability-bound handle (from `fromCapability`) also prefills `capability`
  with its own, so re-delegation reads as `sharedSpace.grant({ to, actions })`.
- Action aliases map `read` to `GET`, `write` to `[PUT, POST]`, `delete` to
  `DELETE`; raw HTTP verbs pass through. Mapping lives in `internal/actions.ts`.
- The **recipient** rebuilds access from the received zcap:
  `was.fromCapability(zcap)` parses `invocationTarget` to return a handle at the
  right depth, pre-bound with `{ capability }`; all its requests pass that
  capability to `zcapClient.request({ capability })`. Equivalently any handle
  factory accepts `{ capability }`.

### Manual requests (escape hatch)

Mirroring ezcap's generic `request()`, `was.request(...)` is the low-level
catch-all for hand-built calls. Every handle method is implemented in terms of
the same internal request helper; `was.request()` simply exposes it publicly.

```ts
interface RequestInput {
  path?: string                    // resolved against serverUrl, e.g. '/space/:id/:cid/'
  url?: string                     // or an absolute URL instead of path
  method?: string                  // default 'GET'
  action?: string                  // default: same as method (never ezcap's 'read'/'write')
  headers?: Record<string, string>
  json?: object
  body?: Blob | Uint8Array
  capability?: IZcap
}
```

It resolves `path` against `serverUrl`, defaults `action` to `method`, and signs
via the wrapped `ZcapClient`. As a deliberate escape hatch it returns the **raw
`HttpResponse`** and throws **raw ezcap/ky errors** -- it does *not* apply the
null-on-404 translation or typed-error mapping; those conveniences live only in
the high-level handle methods.

### Future / spec-reserved endpoints (sketch)

The spec's **Reserved Path Segment Registry** defines a set of optional
endpoints not yet implemented in the reference server. We name the matching
client methods **now** so the surface is stable as the server catches up; each
currently surfaces `NotImplementedError` (the server returns `501`) until
implemented -- the same treatment as `listSpaces()`. These hang off the
existing handles; they are post-v1 and do not block the core CRUD work.

**Sub-accessors** keep the verb set clean where an endpoint is itself CRUD-able.
Policy is GET/PUT/DELETE at all three levels; resource metadata is GET/PUT:

```ts
interface PolicyAccessor {              // space.policy / collection.policy / resource.policy
  get(): Promise<Policy | null>         // GET    .../policy
  set(policy: Policy): Promise<void>    // PUT    .../policy
  delete(): Promise<void>               // DELETE .../policy
}

interface MetaAccessor {                // resource.meta
  get(): Promise<ResourceMeta | null>   // GET .../{rid}/meta
  set(props: Partial<ResourceMeta>): Promise<void>  // PUT .../{rid}/meta
}
```

| Spec endpoint                                  | Segment      | Planned client API                       |
|------------------------------------------------|--------------|------------------------------------------|
| `GET\|PUT\|DELETE /space/:id/policy`           | `policy`     | `space.policy.get/set/delete()`          |
| `GET /space/:id/backends`                      | `backends`   | `space.backends()`                       |
| `GET /space/:id/linkset`                       | `linkset`    | `space.linkset()`                        |
| `POST /space/:id/query`                        | `query`      | `space.query(q)`                         |
| `GET /space/:id/quotas`                        | `quotas`     | `space.quotas()`                         |
| `GET\|PUT\|DELETE /space/:id/:cid/policy`      | `policy`     | `collection.policy.get/set/delete()`     |
| `GET /space/:id/:cid/backend`                  | `backend`    | `collection.backend()`                   |
| `GET /space/:id/:cid/linkset`                  | `linkset`    | `collection.linkset()`                   |
| `POST /space/:id/:cid/query`                   | `query`      | `collection.query(q)`                    |
| `GET /space/:id/:cid/quota`                    | `quota`      | `collection.quota()`                     |
| `GET\|PUT /space/:id/:cid/:rid/meta`           | `meta`       | `resource.meta.get/set()`                |

- `linkset` / `backends` / `quota(s)` / `backend` are read-only discovery and
  report reads (null on 404, like other reads). `linkset()` also doubles as the
  spec's feature-detection mechanism.
- `query` is `POST` with a backend-specific body; typed loosely as
  `query(q: unknown): Promise<QueryResult>` until a query DSL is specified (the
  spec leaves it backend-specific). This is the seam for the roadmap's
  querying/search work.
- `collections` and `export` are already first-class (`collections()`,
  `export()`); they appear in the registry too but need no new surface.
- **Backend selection at creation.** `createCollection({ id?, name?, backend? })`
  and `collection.configure({ name?, backend? })` accept `backend: { id }` per
  the Collection description (defaults to `{ id: 'default' }`); validated against
  `space.backends()`.
- **Reserved-id guard (client-side).** `createCollection`/`add`/`put` reject ids
  that collide with a reserved segment (`policy`, `backends`, `backend`,
  `collections`, `export`, `linkset`, `query`, `quota`, `quotas`, `meta`) up
  front with a clear `ValidationError`, rather than letting the server answer
  `409 Conflict`. The lists live in `internal/reserved.ts`.

### Error model

`internal/request.ts` wraps every `zcapClient.request(...)` and maps thrown ky
errors to typed client errors (carrying `status`, `title`, `details`,
`requestUrl` from `err.data`):

| status | read methods          | write/delete methods  |
|--------|-----------------------|-----------------------|
| 404    | return `null`         | `NotFoundError`       |
| 400    | `ValidationError`     | `ValidationError`     |
| 401    | `AuthRequiredError`   | `AuthRequiredError`   |
| 501    | `NotImplementedError` | `NotImplementedError` |
| 5xx    | `WasServerError`      | `WasServerError`      |

Error classes (`src/errors.ts`): `WasError` base + the five above. Document the
404-conflation caveat on every read method.

### What stays hidden from the user

- Trailing-slash canonicalization (item-create/list use `/`, get/put/delete by
  id do not) -- encoded once in `internal/paths.ts`.
- `action` defaulting to the HTTP method (never ezcap's `read`/`write`).
- Digest header computation (handled inside ezcap).
- Root-zcap synthesis (ezcap auto-generates the root zcap from the URL when no
  `capability` is passed).

## Package structure

New standalone package, mirroring `was-teaching-server`'s tooling (TS strict,
NodeNext, ESLint flat + Prettier, Vitest) and the isomorphic-lib-template
conventions (browser + Node):

```
was-client/
  src/
    index.ts            # public exports
    WasClient.ts
    Space.ts
    Collection.ts
    Resource.ts
    errors.ts
    types.ts            # SpaceDescription, CollectionListing, AddResult, ImportStats, IZcap, Action, Policy, ResourceMeta...
    internal/
      request.ts        # ezcap request wrapper + error mapping
      paths.ts          # URL builders w/ trailing-slash rules
      content.ts        # JSON vs binary detection + body coercion
      actions.ts        # action alias to HTTP verb mapping
      reserved.ts       # reserved path-segment lists + id-collision guard
  test/
  package.json  tsconfig.json  eslint.config.js  vite.config.ts  README.md
```

- Dependencies: `@interop/ezcap` (consumed from the npm registry, per global
  guidelines -- not a `workspace:`/`link:` ref); `@interop/ed25519-signature`
  and `@interop/data-integrity-core` for `fromSigner` + types.
- Type names reuse `@interop/data-integrity-core/zcap` (`IZcap`/
  `IDelegatedZcap`)
  where they fit, rather than hand-rolling.

## Implementation phases

1. **Scaffold + transport core.** Package tooling; `types.ts`; `errors.ts`;
   `internal/{paths,content,actions}.ts`; `internal/request.ts` (the
   ezcap-wrap + error-map). Expose `was.request()` (the raw escape hatch) on top
   of the same helper. This is the load-bearing layer.
2. **Core CRUD handles.** `WasClient` (`space`/`createSpace`/`listSpaces`),
   `Space` (`describe`/`configure`/`delete`/`collection`/`createCollection`/
   `collections`), `Collection` (`describe`/`configure`/`delete`/`add`/`get`/
   `put`/`list`), `Resource` (incl. `delete`). JSON resources first.
3. **Binary resources.** Body coercion + content-type inference in `add`/`put`;
   auto-parse + `getText`/`getBytes` in reads.
4. **Delegation/sharing.** `GrantOptions`, the general `was.grant()` +
   `space`/`collection` sugar, `fromCapability()`, capability-bound handles.
5. **Export/import.** `space.export()` (binary response handling) +
   `space.import()`.
6. **Reserved-id guard.** `internal/reserved.ts` + wiring into
   `createCollection`/`add`/`put`; `backend` selection on
   `createCollection`/`configure`.
7. **Docs.** README with a MongoDB-vs-WAS quickstart and the 404/null caveat.

**Post-v1 (spec-reserved endpoints).** `policy`/`meta` sub-accessors,
`linkset`/`backends`/`quota(s)`/`backend` reads, and `query` -- added as the
reference server implements each; until then they surface `NotImplementedError`.

## Verification

- **Unit/integration tests (Vitest)** in `was-client/test/`, spinning up the WAS
  server in-process via `createApp({ backend })` (devDependency on
  `was-teaching-server`, matching its own per-suite `mkdtemp``FileSystemBackend`
  pattern) with `serverUrl` equal to the injected app's URL so zcap targets
  match. Cover: create space, create collection, add/get/put/remove JSON +
  binary resource, list, delegation round-trip (alice grants bob, bob reads via
  `fromCapability`, bob denied write), export/import, 404-returns-null.
- **Acceptance check:** re-express the existing
  `was-teaching-server/conformance/*` scenarios through the client and confirm
  no operation is unreachable -- the abstraction must fully cover the
  conformance
  surface. (Optionally, later, refactor `conformance/helpers.ts` to use the
  client; tracked separately, not part of v1.)
- **Lint/build gate:** `pnpm lint && pnpm build && pnpm test` green in the new
  package.
