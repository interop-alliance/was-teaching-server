# Architecture

How a request flows through the Wallet Attached Storage (WAS) reference server,
the domain model, and the ZCap authorization structure. For contribution
conventions see [CONTRIBUTING.md](CONTRIBUTING.md); for agent-facing rules
(tests, logging, endpoint recipes) see [AGENTS.md](AGENTS.md).

## Request Flow

A request flows through these layers, in order:

```
start.ts → server.ts → routes.ts → requests/*Request.ts → storage.ts → backends/*.ts
 (env,      (createApp,  (URL→handler   (per-operation       (storage     (persistence:
  listen)    plugins,     mapping +      handlers; auth       facade)       filesystem)
             decorate)    auth hooks)    verify + storage)
```

- **`src/start.ts`** — entry point. Reads `SERVER_URL` / `PORT` from env, calls
  `createApp()` and `listen()`.
- **`src/server.ts`** — `createApp({ serverUrl })` builds the Fastify instance,
  registers plugins (cors, static, view, multipart), decorates the instance with
  `serverUrl`, and registers the four route groups.
- **`src/routes.ts`** — four `init*Routes(app)` functions map URL patterns to
  handler methods. Every group installs the same hook chain first: the
  `requireAuthHeadersOrPublicRead` then `parseAuthHeaders` `onRequest` hooks,
  then the `captureRawBody` (preParsing) and `verifyBodyDigest` (preValidation)
  digest hooks. Slash/no-slash variants redirect to the canonical form
  (spec-defined; see Glossary note on trailing slashes).
- **`src/requests/*Request.ts`** — request handlers as static class methods
  (`SpaceRequest.post`, etc.). Each handler follows the same shape: fetch the
  Space/Collection for context, call `handleZcapVerify(...)`, then call a
  storage method. Handlers read both `serverUrl` and `storage` from
  `request.server` (the `FastifyInstance` decorated in `server.ts`), not via a
  `this` binding.
- **`src/auth-header-hooks.ts`** — `requireAuthHeaders` (401 if missing) and
  `parseAuthHeaders` (parses `Authorization` / `Capability-Invocation` /
  `Digest` into `request.zcap`).
- **`src/digest.ts`** — Request Body Integrity (spec "Request Body Integrity"):
  `captureRawBody` (preParsing) tees JSON/text body bytes onto
  `request.rawBody`; `verifyBodyDigest` (preValidation) requires the `digest`
  header be covered by the signature and recomputes/compares it against the body
  before capability verification (400 `invalid-authorization-header` on
  failure).
- **`src/zcap.ts`** — `handleZcapVerify()` performs the capability-invocation
  signature verification against the Space controller's key.
- **`src/storage.ts`** — supplies `defaultBackend()`, the `FileSystemBackend`
  (rooted at `data/`) that `createApp()` uses when no backend is injected. The
  active backend is injected via `createApp({ backend })` and decorated onto the
  instance as `request.server.storage`.
- **`src/backends/{filesystem}.ts`** — interchangeable persistence
  implementation (`implements StorageBackend` from `src/types.ts`).
- **`src/errors.ts`** — custom error classes plus `handleError`, the Fastify
  error handler installed by each route group.
- **`src/types.ts`** — shared domain types and the Fastify module augmentation
  (`FastifyInstance.serverUrl`, `FastifyInstance.storage`,
  `FastifyRequest.zcap`); reuses `@interop/data-integrity-core` types where they
  fit.

## Glossary

Containment: **SpacesRepository ⊃ Space ⊃ Collection ⊃ Resource**.

- **SpacesRepository** — the top-level container the server hosts. New Spaces
  are created under it via `POST /spaces/`.
- **Space** — a storage area identified by `spaceId`. Has a `controller` (a DID)
  that owns it and authorizes access. Contains Collections.
- **Collection** — a named grouping of Resources within a Space
  (`/space/:spaceId/:collectionId`). Has a description object.
- **Resource** — an individual stored item, JSON object or binary blob, within a
  Collection (`/space/:spaceId/:collectionId/:resourceId`).
- **Controller** — the `did:key` that owns a Space; its Ed25519 key signs
  capability invocations and is checked during ZCap verification.
- **ZCap (Authorization Capability)** — the authorization model. Clients sign
  HTTP requests; the server verifies the signature against the Space
  controller's key rather than using sessions or bearer tokens.
- **`invocationTarget`** — the full URL (including host and port) a capability
  authorizes. Must exactly match the server's `serverUrl`-derived URL — see the
  ZCap constraint under Test Suite in [AGENTS.md](AGENTS.md).
- **Root capability** — `urn:zcap:root:<url-encoded target>`, whose controller
  is the Space controller. Synthesized by the document loader in `zcap.ts`.
- **`did:key`** — the only DID method used here; keys are Ed25519
  (`Ed25519VerificationKey2020` / `Ed25519Signature2020`).

**Trailing slashes:** the spec assigns distinct meaning to `.../` vs `...`. By
convention, "create/update by id" (`PUT`) uses the no-trailing-slash form, while
"list" and "add to" (`GET` / `POST`) use the trailing-slash form. Routes
redirect mismatches to the canonical variant.

## ZCap Structure

A zcap answers "**who** can do **what**, **with** which resource, **given** what
restrictions": `controller` (who, a DID) / `allowedAction` (what, e.g. HTTP
verbs) / `invocationTarget` (with, a URL) / caveats like `expires` (given). A
delegated zcap also carries `parentCapability` and a `proof` with a
`capabilityChain`; a root zcap carries none of those.

**Root vs delegated invocation** (the `Capability-Invocation` header):

- Root: `zcap id="urn:zcap:root:<url-encoded target>"` — just the id.
- Delegated: `zcap capability="<base64url(gzip(json))>",action="GET"` — the full
  capability and its `proof.capabilityChain`, embedded and compressed.

Both verify through the same path: the `urn` protocol handler in `verifyZcap`
synthesizes the root capability on demand (its controller is the Space
controller). For a bare root invocation that _is_ the capability; for a
delegated invocation it's the terminal `parentCapability` at the base of the
chain, which the verifier walks down to.

**Signing:** requests are signed with Cavage HTTP Signatures Draft 12 (not yet
RFC 9421). The `Authorization` header signs
`(key-id) (created) (expires) (request-target) host capability-invocation`, plus
`content-type digest` when there's a body. The `Digest` header is a multihash
(`mh=`, sha256). See the
[zCap Developer Guide](https://github.com/interop-alliance/zcap-developer-guide).
