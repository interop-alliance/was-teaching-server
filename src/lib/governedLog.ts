/**
 * A Collection's governing history log (the `governed-history-logs` feature):
 * the `.../meta/log` sub-resource whose head entry's `state` the server serves
 * as the Collection's `encryption` descriptor. The server checks the line
 * contract alone (JSON Lines, each line an object with a `state` member, the
 * last line is the head) and, on each append, runs the encryption descriptor's
 * transition checks between the prior head and the new one. Entry proofs, the
 * hash chain, `state.type`, and the reserved `history` member inside `state`
 * belong to the governing profile and are not checked here; a verifying reader
 * checks them and compares its result against the derived member.
 */
import type { CollectionEncryption } from '@interop/storage-core'
import { InvalidRequestBodyError, StorageError } from '../errors.js'
import { isPlainObject } from './isPlainObject.js'
import {
  assertEncryptionDescriptorTransition,
  assertSupportedEncryption
} from './encryption.js'

/**
 * The content type the log is served under (JSON Lines, not JSON).
 */
export const LOG_CONTENT_TYPE = 'text/jsonl'

/**
 * Parses a log body under the line contract. Returns the head entry's `state`
 * and the genesis entry's `parameters.method` when it carries one (the
 * format identifier the derived member's `history.method` echoes). Throws
 * `invalid-request-body` (400) on a body that breaks the contract: empty, a
 * blank line other than a trailing newline, a line that is not a JSON object,
 * or a line without an object `state`.
 *
 * @param options {object}
 * @param options.body {string}   the JSON Lines log body
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {{ head: Record<string, unknown>, method?: string }}
 */
export function parseGoverningLog({
  body,
  requestName
}: {
  body: string
  requestName?: string
}): { head: Record<string, unknown>; method?: string } {
  const lines = body.split('\n')
  if (lines.at(-1) === '') {
    lines.pop()
  }
  if (lines.length === 0) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'A history log must carry at least one entry line.'
    })
  }
  const entries = lines.map((line, index) => {
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      entry = undefined
    }
    if (!isPlainObject(entry) || !isPlainObject(entry.state)) {
      throw new InvalidRequestBodyError({
        requestName,
        detail:
          `History log line ${index + 1} must be a JSON object with an ` +
          'object "state" member.'
      })
    }
    return entry
  })
  const genesisParameters = entries[0]!.parameters
  const method = isPlainObject(genesisParameters)
    ? genesisParameters.method
    : undefined
  return {
    head: entries.at(-1)!.state as Record<string, unknown>,
    ...(typeof method === 'string' && { method })
  }
}

/**
 * The checks a log write runs atomically with the write: the line contract
 * on the new body, the head `state`'s shape as an encryption descriptor (the
 * same gate a Description write passes), and the descriptor transition from
 * the prior head (`epochs` append-only, `currentEpoch` never older, `hmac`
 * id and type permanent, `scheme` and `version` set-once), raising exactly
 * what a Description PUT raises today.
 *
 * @param options {object}
 * @param options.body {string}   the new log body
 * @param [options.prior] {string}   the stored log body, absent on a create
 * @param options.requestName {string}
 * @returns {void}
 */
export function assertGoverningLogAppend({
  body,
  prior,
  requestName
}: {
  body: string
  prior?: string
  requestName: string
}): void {
  const { head } = parseGoverningLog({ body, requestName })
  const incoming = assertSupportedEncryption({ encryption: head, requestName })
  if (prior === undefined) {
    return
  }
  const existing = parseGoverningLog({ body: prior, requestName }).head
  assertEncryptionDescriptorTransition({
    existing: existing as CollectionEncryption,
    incoming
  })
}

/**
 * The derived `encryption` member of a governed Collection: the log head's
 * `state` with `history: { method, resource }` stamped on, `method` being the
 * genesis entry's format identifier and `resource` the log's own URL. Exactly
 * what a verifying reader computes after stripping `history`.
 *
 * The body is stored data, validated when it was written (a `/log` PUT or an
 * import), so a body the line contract rejects here is a server-side fault
 * and surfaces as `StorageError` (500) rather than as the client-facing 400
 * the parser raises.
 *
 * @param options {object}
 * @param options.body {string}   the stored log body
 * @param options.logUrl {string}   the absolute URL of the log sub-resource
 * @returns {CollectionEncryption}
 */
export function deriveGovernedEncryption({
  body,
  logUrl
}: {
  body: string
  logUrl: string
}): CollectionEncryption {
  let parsed: ReturnType<typeof parseGoverningLog>
  try {
    parsed = parseGoverningLog({ body })
  } catch (err) {
    throw new StorageError({
      cause: new Error('Stored history log breaks the line contract.', {
        cause: err
      })
    })
  }
  const { head, method } = parsed
  // `history` names the log's format identifier and location together; a
  // log whose genesis carries no `parameters.method` gets no `history` stamp
  // (the location is derivable from the Collection URL regardless).
  return {
    ...head,
    ...(method !== undefined && { history: { method, resource: logUrl } })
  } as CollectionEncryption
}
