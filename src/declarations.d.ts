/**
 * Ambient module declarations for runtime dependencies that do not ship their
 * own types and lack an `@types/*` package.
 *
 * Populated during the file-by-file conversion (Phase 5) once the
 * dependency-typing audit determines which imported packages need a minimal
 * ambient declaration covering only the surface this codebase uses. Candidates
 * flagged by the conversion plan: `fs-json-store`,
 * `@interop-alliance/http-signature-zcap-verify`,
 * `@interop/http-signature-header`.
 */

export {}
