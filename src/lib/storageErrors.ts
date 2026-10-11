/**
 * The storage-call wrapper request handlers share. It lives outside
 * `errors.ts` because that module's exports are the package's public error
 * surface.
 */
import { rethrowOrWrapStorageError } from '../errors.js'

/**
 * Runs a storage call and routes a failure through
 * `rethrowOrWrapStorageError`: a `ProblemError` propagates unchanged and
 * anything else becomes a 500 `StorageError`. The `try` / `catch` request
 * handlers wrap around storage operations, as one call.
 * @param options {object}
 * @param [options.requestName] {string}   request name used in the error title
 * @param run {() => Promise<T>}   the storage call
 * @returns {Promise<T>}
 */
export async function withStorageErrors<T>(
  { requestName }: { requestName?: string },
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run()
  } catch (err) {
    rethrowOrWrapStorageError({ err, requestName })
  }
}
