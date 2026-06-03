/**
 * Ambient module declarations for runtime dependencies that do not ship their
 * own types and lack an `@types/*` package.
 *
 * Minimal ambient declarations covering only the surface this codebase uses,
 * for runtime dependencies that do not ship their own types and lack an
 * `@types/*` package.
 */

declare module 'fs-json-store' {
  export interface StoreOptions {
    file: string
  }

  /** Reads/writes a single JSON document atomically to `options.file`. */
  export class Store<T = unknown> {
    constructor(options: StoreOptions)
    /** Resolves the parsed document, or `undefined` if the file is absent. */
    read(): Promise<T | undefined>
    /** Writes the document and resolves the written value. */
    write(data: T): Promise<T>
  }

  const _default: { Store: typeof Store }
  export default _default
}

export {}
