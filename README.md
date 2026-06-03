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

`pnpm build` compiles `src/` to `dist/` and copies `src/views` → `dist/views`,
then `pnpm start` runs the compiled output:

```
pnpm build
SERVER_URL='http://localhost:3002' PORT=3002 pnpm start
```

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

```bash
# Start a server with a matching SERVER_URL, then in another shell:
TEST_SERVER_URL=https://was.example.com pnpm conformance

# With an onboarding token, for servers that require one for POST /spaces/:
TEST_SERVER_URL=https://was.example.com TEST_ONBOARDING_TOKEN=abc123 pnpm conformance
```

## Security

This is an experimental research server.

## License

[GNU AFFERO GENERAL PUBLIC LICENSE v3](LICENSE)
