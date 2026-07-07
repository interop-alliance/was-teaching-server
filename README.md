# WAS Teaching Server (_was-teaching-server_)

[![Node.js CI](https://github.com/interop-alliance/was-teaching-server/workflows/CI/badge.svg)](https://github.com/interop-alliance/was-teaching-server/actions?query=workflow%3A%22CI%22)

> A basic
> [Wallet Attached Storage](https://digitalcredentials.github.io/wallet-attached-storage-spec/)
> Server used to demonstrate the specification

## Table of Contents

- [Background](#background)
- [Install](#install)
- [Usage](#usage)
- [Security](#security)
- [License](#license)

## Background

See:

- [Wallet Attached Storage Specification](https://digitalcredentials.github.io/wallet-attached-storage-spec/)

### Supported Features

Authorization: Uses `ZcapClient` from `@interop/ezcap`, see the
[zCap Developer Guide](https://github.com/interop-alliance/zcap-developer-guide)
for more details.

#### Spaces API

- [Create Space](https://digitalcredentials.github.io/wallet-attached-storage-spec/#http-api-post-spaces)
  (`POST /spaces/`)
- [Get Space by Id](https://digitalcredentials.github.io/wallet-attached-storage-spec/#read-space-operation)
  (`GET /space/:spaceId`)
- [Update Space (or Create Space by Id)](https://digitalcredentials.github.io/wallet-attached-storage-spec/#update-space-operation)
  (`PUT /space/:spaceId`)
- [Delete Space by Id](https://digitalcredentials.github.io/wallet-attached-storage-spec/#delete-space-operation)
  (`DELETE /space/:spaceId`)

#### Collections API

- [Create Collection](https://digitalcredentials.github.io/wallet-attached-storage-spec/#create-collection-add-collection-to-a-space-operation)
  (`POST /space/:spaceId/`)
- [Update Collection (or Create Collection by Id)](https://digitalcredentials.github.io/wallet-attached-storage-spec/#update-or-create-by-id-collection-operation)
  (`PUT /space/:spaceId/:collectionId`)
- [Get a Collection Description object](https://digitalcredentials.github.io/wallet-attached-storage-spec/#get-collection-description-operation)
  (`GET /space/:spaceId/:collectionId` - no trailing slash)
- [List Resources in a Collection](https://digitalcredentials.github.io/wallet-attached-storage-spec/#get-collection-operation)
  (`GET /space/:spaceId/:collectionId/` - with trailing slash)
- [Delete Collection by Id](https://digitalcredentials.github.io/wallet-attached-storage-spec/#delete-collection-operation)
  (`DELETE /space/:spaceId/:collectionId`)

#### Resources API

- [Create Resource](https://digitalcredentials.github.io/wallet-attached-storage-spec/#create-resource-add-resource-to-collection-operation)
  (`POST /space/:spaceId/:collectionId/`)
  - both JSON objects and binary blobs
- [Get Resource by Id](https://digitalcredentials.github.io/wallet-attached-storage-spec/#read-resource-operation)
  (`GET /space/:spaceId/:collectionId/:resourceId`)
- [Head Resource by Id](https://digitalcredentials.github.io/wallet-attached-storage-spec/#content-types-and-representations)
  (`HEAD /space/:spaceId/:collectionId/:resourceId`)
  - same headers as `GET` with no body; `Content-Type`/`Content-Length` from the
    Resource's Metadata
- [Update Resource (or Create Resource by Id)](https://digitalcredentials.github.io/wallet-attached-storage-spec/#update-or-create-by-id-resource-operation)
  (`PUT /space/:spaceId/:collectionId/:resourceId`)
- [Delete Resource by Id](https://digitalcredentials.github.io/wallet-attached-storage-spec/#delete-resource-operation)
  (`DELETE /space/:spaceId/:collectionId/:resourceId`)

**Uploading binary resources (and large files).** Send the file as the **raw
request body** with its own `Content-Type` (e.g. `image/png`) -- not wrapped in
a form. The server streams a raw-body upload straight to storage (enforcing the
upload cap as it goes), so this is the path for large files. The write must
still be zCap-signed, and because the signature covers the `Digest` header, the
client hashes the whole body before sending (a plain browser `<form>` cannot do
this -- uploads are made programmatically by a signing client). The OPTIONAL
`multipart/form-data` upload is supported as a convenience for the HTML-form
workflow: it MUST carry exactly one file part, and the server buffers that part
in memory bounded by `MAX_UPLOAD_BYTES`, so it is best suited to smaller
uploads.

#### Access Control Policy (public read)

By default every operation requires a capability invocation. A **policy**
auxiliary resource can override this to make a Space, Collection, or Resource
world-readable — the common "create public link" use case (e.g. a wallet sharing
a Verifiable Credential).

- CRUD the policy at any level (controller-only):
  - `GET|PUT|DELETE /space/:spaceId/policy`
  - `GET|PUT|DELETE /space/:spaceId/:collectionId/policy`
  - `GET|PUT|DELETE /space/:spaceId/:collectionId/:resourceId/policy`
- Discover a policy via the `linkset` property on the Space/Collection
  Description, or `GET /space/:spaceId[/:collectionId]/linkset`
  (`application/linkset+json`, RFC9264).

How a read is authorized: the server tries the capability invocation first; if
none is presented, or it does not grant access, it falls back to the **effective
policy** (resolved most-specific-first: Resource > Collection > Space). Policies
are **permissive-only** — they can only broaden access beyond capabilities,
never deny a valid capability holder. A denied read returns `404` (so existence
is not leaked); writes always require a capability.

The policy document is a small, `type`-discriminated, extensible shape. v1
recognizes one type (any other `type` is treated as "grants nothing", so it
falls through to the capability-only decision):

```json
{ "type": "PublicCanRead" }
```

Set it, for example, on a `public-credentials` Collection so anyone can
`GET /space/:spaceId/public-credentials/:resourceId` without authorization. This
minimal canned-policy approach (cf. S3 `public-read`, `chmod o+r`) covers the
dominant public-read case; a richer policy language (e.g. Cedar) is left as a
future, separate tier.

## Install

Requires Node.js 24.x and [`pnpm`](https://pnpm.io/).

```
pnpm install
```

This server is written in TypeScript. In development it runs directly via
[`tsx`](https://github.com/privatenumber/tsx) (no build step); for production it
is compiled with `tsc` to `dist/`.

## Usage

### Running in Development

`tsx` runs the TypeScript sources directly and watches for changes (views are
served from `src/views`, so no asset copy is needed):

```
SERVER_URL='http://localhost:3002' PORT=3002 pnpm dev
```

### Building and Starting the Server

`pnpm build` compiles `src/` to `dist/` and copies `src/views` > `dist/views`,
then `pnpm start` runs the compiled output:

```
pnpm build
SERVER_URL='http://localhost:3002' PORT=3002 pnpm start
```

### Using as a Library

The WAS protocol surface is also exported as a registerable Fastify plugin,
`fastifyWas`, so a downstream server can compose it with its own persistence
backend and security plugins. See
[Consuming the Server as a Library](docs/consuming-server-as-library.md).

### Environment Variables

The whole env surface below is read and validated once at startup
(`loadConfigFromEnv` in `src/config.default.ts`): a missing `SERVER_URL` or any
malformed value fails startup immediately with the offending variable named,
rather than surfacing later as broken ZCap matching.

| Variable                    | Default                     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SERVER_URL`                | (none)                      | **Required.** This server's base URL; used to build and match ZCap `invocationTarget` URLs (host and port must match the client's exactly). Must be an absolute `http:`/`https:` URL with no path, query, or fragment -- deploying under a sub-path is not supported.                                                                                                                                                                                                                                                                                       |
| `PORT`                      | `3002`                      | TCP port to listen on (an integer between 1 and 65535).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `DATABASE_URL`              | (unset = filesystem)        | Selects the **PostgreSQL storage backend**: a `postgres://` connection string (e.g. `postgres://was:was@localhost:5433/was`). When set, all WAS + WebKMS data is stored in Postgres (schema migrations are applied automatically at startup); unset, the server uses the default filesystem backend rooted at `data/`. See [Storage Backends](#storage-backends).                                                                                                                                                                                           |
| `STORAGE_LIMIT_PER_SPACE`   | (unset = unlimited, warned) | Per-Space storage quota in **bytes** (spec "Quotas"). When set, writes that would push a Space over this limit are rejected with `quota-exceeded` (507). Unset means each Space is unlimited, and startup logs a warning; set `unlimited` to acknowledge the choice explicitly and silence it.                                                                                                                                                                                                                                                              |
| `MAX_UPLOAD_BYTES`          | `67108864` (64 MiB)         | Per-upload size cap in **bytes** (spec "Quotas", the backend's `maxUploadBytes` constraint), default-on. A single upload exceeding it is rejected with `payload-too-large` (413) -- distinct from the cumulative `STORAGE_LIMIT_PER_SPACE`. Set `unlimited` to remove the cap (filesystem backend only: the Postgres backend buffers each upload in memory as a single `bytea`, so it rejects `unlimited` at startup).                                                                                                                                      |
| `MAX_SPACES_PER_CONTROLLER` | `100`                       | Max number of Spaces a single controller DID may create (a default-on count quota). A create beyond the limit is rejected with `quota-exceeded` (507); overwriting an existing Space never trips it. Set `unlimited` for no cap. Hard (transactional) on the Postgres backend, soft under concurrency on the filesystem backend -- like the byte quota.                                                                                                                                                                                                     |
| `MAX_COLLECTIONS_PER_SPACE` | `100`                       | Max number of Collections one Space may hold (a default-on count quota, also enforced during a tar import). A create beyond the limit is rejected with `quota-exceeded` (507); overwriting an existing Collection's description never trips it. Set `unlimited` for no cap.                                                                                                                                                                                                                                                                                 |
| `MAX_RESOURCES_PER_SPACE`   | `10000`                     | Max number of live Resources one Space may hold across all its Collections (a default-on count quota, also enforced during a tar import; tombstoned Resources do not count). A create beyond the limit is rejected with `quota-exceeded` (507); overwriting an existing Resource never trips it, and a delete frees a slot. Set `unlimited` for no cap.                                                                                                                                                                                                     |
| `KMS_RECORD_KEK`            | (unset = disabled)          | At-rest encryption key for WebKMS key records: a single AES-256 key-encryption key (KEK) in base58btc Multikey form (`secretKeyMultibase`, header `0xa2 0x01`). When set, the secret fields of newly generated `/kms` key records are envelope-encrypted under it before they reach storage; existing plaintext records stay readable. Unset means key records are stored **plaintext** (the teaching default). See [`_spec/encrypted-kms-plan.md`](./_spec/encrypted-kms-plan.md).                                                                         |
| `WAS_ONBOARDING_TOKEN`      | (unset = disabled)          | Shared-secret onboarding token gating the two open provisioning endpoints (`POST /spaces/` and `POST /kms/keystores`). When set, those two endpoints require an `Authorization: Bearer <token>` header, which then substitutes for ZCap verification on that request; every other operation still uses the normal capability-invocation path. Unset means provisioning is open -- anyone may create a Space or keystore by proving control of the `controller` DID in the request body (the teaching default). See [Provisioning gate](#provisioning-gate). |

### Provisioning gate

By default, anyone may create a Space (`POST /spaces/`) or a WebKMS keystore
(`POST /kms/keystores`) by proving control of the `controller` DID named in the
request body -- the open, teaching-server behavior. A deployment can gate those
two endpoints in one of two mutually-exclusive ways:

- **Onboarding token** -- set `WAS_ONBOARDING_TOKEN` (or pass `onboardingToken`
  to the `fastifyWas` plugin / `createApp`). Provisioning then requires an
  `Authorization: Bearer <token>` header matching the configured secret; a valid
  token substitutes for ZCap verification on that request.
- **Custom policy** -- pass an `authorizeProvisioning` callback to the plugin.
  It receives `{ request }` and returns `'verify'` (run the normal ZCap path),
  `'grant'` (authorize the request itself, skipping ZCap verification), or
  `'deny'` (403); it may also throw a `ProblemError` for a custom response.

Both configure the same seam; setting both at once is rejected at startup.

### Storage Backends

Two interchangeable first-party backends implement the same `StorageBackend`
contract (`src/types.ts`):

- **Filesystem** (default): stores everything under `data/`. Zero setup.
- **PostgreSQL**: selected by setting `DATABASE_URL`. Quota accounting is
  transactional (a _hard_ per-Space limit, unlike the filesystem's documented
  soft limit), conditional writes use row locks instead of an in-process mutex
  (so multiple server processes can share one database), and blob uploads are
  buffered `bytea` writes bounded by `MAX_UPLOAD_BYTES` (default 64 MiB;
  `MAX_UPLOAD_BYTES=unlimited` is rejected at startup, since the in-memory
  buffering makes an unbounded upload unsafe). Design details:
  [`_spec/historical/postgres-plan.md`](./_spec/historical/postgres-plan.md).

To run a disposable local Postgres with Podman (substitute `docker` if you
prefer; the commands are identical):

```bash
# One-time: pull and start Postgres 17 with a named volume for data.
# Host port 5433 avoids colliding with any system Postgres on 5432.
podman run -d --name was-postgres \
  -e POSTGRES_USER=was \
  -e POSTGRES_PASSWORD=was \
  -e POSTGRES_DB=was \
  -p 5433:5432 \
  -v was-pgdata:/var/lib/postgresql/data \
  docker.io/library/postgres:17

# Verify it is accepting connections:
podman exec was-postgres pg_isready -U was

# Day-to-day lifecycle:
podman stop was-postgres
podman start was-postgres

# Full teardown (drops all stored data):
podman rm -f was-postgres && podman volume rm was-pgdata
```

Then start the server against it:

```bash
DATABASE_URL=postgres://was:was@localhost:5433/was pnpm dev
```

Schema migrations are embedded (`src/backends/postgresSchema.ts`) and applied
idempotently at startup. To migrate existing data between backends, export each
Space from one server and import it into the other — both backends speak the
same tar archive dialect (`POST /space/:id/export` / `.../import`).

### Running Tests

The full gate (lint + build + Vitest integration tests):

```
pnpm test
```

Just the Vitest integration suite under `test/`:

```
pnpm test-node
```

The Postgres backend tests are **opt-in**: they are skipped unless
`WAS_TEST_DATABASE_URL` points at a running (disposable) Postgres. With the
Podman container above running:

```
pnpm test:pg
```

Each suite isolates itself in a throwaway `was_test_<hex>` schema, dropped on
teardown, so parallel test workers never collide and the container stays
reusable.

### Conformance Tests

The `conformance/` suite runs against any external WAS server. The server's
`SERVER_URL` and the test's `TEST_SERVER_URL` **must be byte-for-byte
identical** (including host and port) — ZCap `invocationTarget` URLs embed the
full host:port, so even `localhost` vs `127.0.0.1` or a port mismatch will make
delegated-access tests 404.

For a local run, `pnpm conformance:local` does the whole dance for you: it spins
up the server on a fixed local URL, waits until it answers, runs the suite with
a matching `TEST_SERVER_URL`, and tears the server down afterward (even if the
suite fails) — so the two URLs can't drift out of sync.

```bash
# One-shot local run (recommended). Override the port with PORT=... if 3002 is
# taken; the server and test URLs are both derived from it, so they stay in sync.
pnpm conformance:local

# Against an already-running or external server. Start it with a matching
# SERVER_URL, then in another shell:
TEST_SERVER_URL=https://was.example.com pnpm conformance

# With an onboarding token, for servers that require one for POST /spaces/:
TEST_SERVER_URL=https://was.example.com TEST_ONBOARDING_TOKEN=abc123 pnpm conformance
```

## Security

This is an experimental research server.

## License

[GNU AFFERO GENERAL PUBLIC LICENSE v3](LICENSE)
