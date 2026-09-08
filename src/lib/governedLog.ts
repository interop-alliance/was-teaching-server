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
import {
  InvalidRequestBodyError,
  PreconditionFailedError,
  StorageError
} from '../errors.js'
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
 * The number of entry lines in a log body under the line contract (a
 * trailing newline closes the last line rather than opening an empty one).
 * @param body {string}
 * @returns {number}
 */
function lineCount(body: string): number {
  const lines = body.split('\n')
  return lines.at(-1) === '' ? lines.length - 1 : lines.length
}

/**
 * The checks a log write runs atomically with the write: the line contract
 * on the new body, the head `state`'s shape as an encryption descriptor (the
 * same gate a Description write passes), the fast-forward rule against the
 * stored log, and the descriptor transition from the prior head (`epochs`
 * append-only, `currentEpoch` never older, `hmac` id and type permanent,
 * `scheme` and `version` set-once), raising exactly what a Description PUT
 * raises today.
 *
 * The fast-forward rule is what keeps the log append-only at the server: an
 * append carries the stored bytes verbatim followed by exactly one new line.
 * A body the stored log is not a prefix of presumes a log that is not the
 * current one (a stale read, or a rewritten prefix) and is refused as
 * `precondition-failed` (412), whether or not the write carried `If-Match`;
 * a body that extends the stored bytes by other than one line is a malformed
 * append (`invalid-request-body`, 400). So a holder of a write capability
 * can add to the history but cannot erase it; a break inside an appended
 * entry (a bad proof, a broken hash chain) is still the verifying reader's
 * to detect under the governing profile. A create (no stored log) is bound
 * by the line contract alone.
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
  if (!body.startsWith(prior)) {
    throw new PreconditionFailedError({
      requestName,
      detail:
        'The stored history log is not a prefix of the body: an append ' +
        'carries the stored bytes verbatim followed by the new line.'
    })
  }
  const added = lineCount(body) - lineCount(prior)
  if (added !== 1) {
    throw new InvalidRequestBodyError({
      requestName,
      detail:
        `An append adds exactly one line to the stored history log ` +
        `(${added} added).`
    })
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
