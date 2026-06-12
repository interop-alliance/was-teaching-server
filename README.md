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
- [Update Resource (or Create Resource by Id)](https://digitalcredentials.github.io/wallet-attached-storage-spec/#update-or-create-by-id-resource-operation)
  (`PUT /space/:spaceId/:collectionId/:resourceId`)
- [Delete Resource by Id](https://digitalcredentials.github.io/wallet-attached-storage-spec/#delete-resource-operation)
  (`DELETE /space/:spaceId/:collectionId/:resourceId`)

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

### Environment Variables

| Variable                  | Default             | Description                                                                                                                                                                                   |
| ------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SERVER_URL`              | (none)              | This server's base URL; used to build and match ZCap `invocationTarget` URLs (host and port must match the client's exactly).                                                                 |
| `PORT`                    | `3002`              | TCP port to listen on.                                                                                                                                                                        |
| `STORAGE_LIMIT_PER_SPACE` | (unset = unlimited) | Per-Space storage quota in **bytes** (spec "Quotas"). When set, writes that would push a Space over this limit are rejected with `quota-exceeded` (507). Unset means each Space is unlimited. |

### Running Tests

The full gate (lint + build + Vitest integration tests):

```
pnpm test
```

Just the Vitest integration suite under `test/`:

```
pnpm test-node
```

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
