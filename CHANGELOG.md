# History

## 0.0.7 - TBD

### Changed

- Convert the codebase from JavaScript (ES2020 + JSDoc) to TypeScript (strict,
  `NodeNext`). Dev runs via `tsx`; production builds with `tsc` to `dist/`.
  Tooling adopted: ESLint flat config, Prettier, Vitest.
- Migrate the `test/` integration suite to Vitest; keep the `conformance/` suite
  standalone (run via `tsx --test`).
- Bump `@interop/*` packages to v7: `did-method-key` 7.x, `ed25519-signature`
  7.x, `ed25519-verification-key` 7.x; update `security-document-loader` to
  9.2.x and `ezcap` (dev) to 7.x.
- Swap `@interop-alliance/http-signature-zcap-verify` for the typed
  `@interop/http-signature-zcap-verify` fork.

### Added

- Add `@interop/data-integrity-core` as a direct dependency (source of shared
  types).

### Fixed

- `writeResource` now awaits `request.file()` in both backends (multipart
  resource writes).
- `ResourceRequest.delete` / `CollectionRequest.delete` now import the
  `StorageError` they throw.

## 0.0.6 - 2026-05-31

### Changed

- Migrate to `@interop/` forks of the key, signature and DID packages.

## 0.0.5 - 2026-05-11

### Added

- Implement 'List Collections' request.

## 0.0.4 - 2026-05-11

### Changed

- Refactor storage.js into file and memory backends.
- Fix start server error logging.
- Refactor listCollectionItems to use 'items' instead of 'rows'.
- Add exportSpace functionality to FileSystemBackend.
- Bump deps to latest.

## 0.0.3 - 2026-03-25

### Changed

- Add PUT Resource route.
- Refactor listCollections result objects.

## 0.0.2 - 2026-03-24

### Changed

- Add SERVER_URL and PORT env vars, better errors.

## 0.0.1 - 2025-08-25

### Added

- Initial commits
