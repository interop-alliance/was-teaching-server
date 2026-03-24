# WAS Teaching Server (_was-teaching-server_)

> A basic [Wallet Attached Storage](https://digitalcredentials.github.io/wallet-attached-storage-spec/) Server used to demonstrate the specification

## Table of Contents

- [Background](#background)
- [Install](#install)
- [Usage](#usage)
- [Security](#security)
- [License](#license)

## Background

See:

* [Wallet Attached Storage Specification](https://digitalcredentials.github.io/wallet-attached-storage-spec/)

### Supported Features

Authorization: Uses `ZcapClient` from `@digitalcredentials/ezcap`,
see the [zCap Developer Guide](https://github.com/interop-alliance/zcap-developer-guide)
for more details.

#### Spaces API

* [Create Space](https://digitalcredentials.github.io/wallet-attached-storage-spec/#http-api-post-spaces)
  (`POST /spaces/`)
* [Get Space by Id](https://digitalcredentials.github.io/wallet-attached-storage-spec/#read-space-operation)
  (`GET /space/:spaceId`)
* [Update Space (or Create Space by Id)](https://digitalcredentials.github.io/wallet-attached-storage-spec/#update-space-operation)
  (`PUT /space/:spaceId`)
* [Delete Space by Id](https://digitalcredentials.github.io/wallet-attached-storage-spec/#delete-space-operation)
  (`DELETE /space/:spaceId`)

#### Collections API

* [Create Collection](https://digitalcredentials.github.io/wallet-attached-storage-spec/#create-collection-add-collection-to-a-space-operation)
  (`POST /space/:spaceId/`)
* [Update Collection (or Create Collection by Id)](https://digitalcredentials.github.io/wallet-attached-storage-spec/#update-or-create-by-id-collection-operation)
  (`PUT /space/:spaceId/:collectionId`)
* [Get a Collection Description object](https://digitalcredentials.github.io/wallet-attached-storage-spec/#get-collection-description-operation)
  (`GET /space/:spaceId/:collectionId` - no trailing slash)
* [List Resources in a Collection](https://digitalcredentials.github.io/wallet-attached-storage-spec/#get-collection-operation)
  (`GET /space/:spaceId/:collectionId/` - with trailing slash)
* [Delete Collection by Id](https://digitalcredentials.github.io/wallet-attached-storage-spec/#delete-collection-operation)
  (`DELETE /space/:spaceId/:collectionId`)

#### Resources API

* [Create Resource](https://digitalcredentials.github.io/wallet-attached-storage-spec/#create-resource-add-resource-to-collection-operation)
  (`POST /space/:spaceId/:collectionId/`)
  * both JSON objects and binary blobs
* [Get Resource by Id](https://digitalcredentials.github.io/wallet-attached-storage-spec/#read-resource-operation)
  (`GET /space/:spaceId/:collectionId/:resourceId`)
* [Delete Resource by Id](https://digitalcredentials.github.io/wallet-attached-storage-spec/#delete-resource-operation)
  (`DELETE /space/:spaceId/:collectionId/:resourceId`)

## Install

```
pnpm install
```

## Usage

### Starting the Server

```
SERVER_URL='http://localhost:3002' PORT=3002 npm start
```

### Running Tests

```
npm test
```
or
```
yarn test
```

## Security

This is an experimental research server.

## License
[GNU AFFERO GENERAL PUBLIC LICENSE v3](LICENSE)
