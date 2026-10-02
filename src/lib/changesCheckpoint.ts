/**
 * The wire checkpoint of the `changes` query profile. On the wire it is an
 * opaque string: a client stores it, compares it by equality only, and echoes
 * it back verbatim. This server encodes a Collection's feed position in it,
 * together with the absolute URL of the Collection whose feed issued it and
 * the generation of that feed's counter, as
 * `base64urlnopad(JSON.stringify({ feed, generation, position }))`. The
 * Collection URL scopes a checkpoint to the server and Collection that issued
 * it. The generation scopes it to one life of that Collection's feed: a
 * Collection deleted and re-created under the same URL, by hand or by a
 * restore, restarts its counter at 1 under a fresh generation, so a
 * checkpoint held from before is refused rather than read as a position in
 * the new feed.
 */
import { base64urlnopad } from '@scure/base'
import { isPlainObject } from './isPlainObject.js'

/**
 * Encodes a feed position as the opaque checkpoint that resumes the feed
 * right after it.
 * @param options {object}
 * @param options.feed {string}   the absolute URL of the Collection, with its
 *   trailing slash
 * @param options.generation {string}   the feed counter's generation
 * @param options.position {number}   the feed position
 * @returns {string}
 */
export function encodeChangesCheckpoint({
  feed,
  generation,
  position
}: {
  feed: string
  generation: string
  position: number
}): string {
  return base64urlnopad.encode(
    new TextEncoder().encode(JSON.stringify({ feed, generation, position }))
  )
}

/**
 * Decodes a checkpoint this server issued for the feed at `feed`. Resolves
 * `undefined` for anything else: a value that is not a string, a string that
 * does not decode to exactly `{ feed, generation, position }`, a checkpoint
 * issued for another Collection or another server, or a position that is not
 * a non-negative safe integer. The generation is returned, not checked: the
 * caller compares it with the feed counter's current generation, which only
 * the backend knows.
 * @param options {object}
 * @param options.checkpoint {unknown}   the client's `checkpoint` member
 * @param options.feed {string}   the absolute URL of the Collection being read,
 *   with its trailing slash
 * @returns {{ generation: string, position: number } | undefined}   the feed
 *   counter generation the checkpoint was issued under, and the position to
 *   resume after
 */
export function decodeChangesCheckpoint({
  checkpoint,
  feed
}: {
  checkpoint: unknown
  feed: string
}): { generation: string; position: number } | undefined {
  if (typeof checkpoint !== 'string') {
    return undefined
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        base64urlnopad.decode(checkpoint)
      )
    )
  } catch {
    return undefined
  }
  if (!isPlainObject(decoded)) {
    return undefined
  }
  const keys = Object.keys(decoded)
  if (
    keys.length !== 3 ||
    decoded.feed !== feed ||
    typeof decoded.generation !== 'string' ||
    !Number.isSafeInteger(decoded.position) ||
    (decoded.position as number) < 0
  ) {
    return undefined
  }
  return {
    generation: decoded.generation,
    position: decoded.position as number
  }
}
