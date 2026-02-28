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

* [Create Space](https://digitalcredentials.github.io/wallet-attached-storage-spec/#http-api-post-spaces) (`POST /spaces/`)
* [Get Space by Id](https://digitalcredentials.github.io/wallet-attached-storage-spec/#read-space-operation) (`GET /space/:spaceId`)

#### Collections API

* [Create Collection]() (`POST /space/:spaceId/`)
* [Get a Collection Description object]() (`GET /space/:spaceId/:collectionId` - no trailing slash)
* [List Resources in a Collection](https://digitalcredentials.github.io/wallet-attached-storage-spec/#get-collection-operation) (`GET /space/:spaceId/:collectionId/` - with trailing slash)

#### Resources API

* [Create Resource]() (`POST /space/:spaceId/:collectionId/`)
  * both JSON objects and binary blobs
* [Get Resource by Id](https://digitalcredentials.github.io/wallet-attached-storage-spec/#read-resource-operation) (`GET /space/:spaceId/:collectionId/`)

## Install

```
yarn install
```
## Usage

### Starting the Server

```
yarn start
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

Note: This is an experimental research server, not for production use.

## License
[GNU AFFERO GENERAL PUBLIC LICENSE v3](LICENSE)
