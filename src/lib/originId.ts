/**
 * The per-store origin id: the origin half of a write's replicated identity.
 * Every store (a filesystem data dir, a Postgres schema) carries exactly one,
 * minted on first boot or taken verbatim from `WAS_ORIGIN_ID`, and keeps it
 * for the store's life. It only has to be stable and unique among every server
 * a Space may replicate to, since nothing verifies a stamp; so it can be short
 * and opaque, and an operator who wants a readable one sets it. Advertised on
 * `/service` as `originId` on the core `https://w3id.org/pws` entry.
 */
import { randomBytes } from 'node:crypto'
import { base58 } from '@scure/base'

/**
 * The charset and length an origin id must match, set or minted.
 */
export const ORIGIN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Whether `value` is a well-formed origin id.
 * @param value {unknown}
 * @returns {value is string}
 */
export function isValidOriginId(value: unknown): value is string {
  return typeof value === 'string' && ORIGIN_ID_PATTERN.test(value)
}

/**
 * Mints a fresh origin id: sixteen random bytes, base58-encoded (about
 * twenty-two alphanumeric characters), so it is within the charset and well
 * under the length limit.
 * @returns {string}
 */
export function mintOriginId(): string {
  return base58.encode(randomBytes(16))
}
