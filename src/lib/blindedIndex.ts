/**
 * Blinded-index query evaluation -- the `blinded-index` profile of the reserved
 * Collection `POST .../query` endpoint (the `blinded-index-query` backend
 * feature). An EDV-encrypted Resource stored in a Collection carries an
 * `indexed` array of HMAC-blinded attribute entries (produced client-side by
 * `@interop/edv-client`'s IndexHelper); this module evaluates EDV queries
 * (`equals` / `has`) against those entries, and enforces the write-time EDV
 * unique-attribute invariant (`unique: true` claims;
 * `assertNoUniqueBlindedConflict`). Everything here is opaque
 * base64url string matching: the server never sees plaintext attribute names
 * or values and performs no cryptography, so it is agnostic to the client's
 * attribute-blinding version.
 *
 * Both storage backends answer the profile through `runBlindedIndexQuery` so
 * their matching, ordering, and pagination semantics cannot drift (the same
 * pattern as `preconditions.ts` for conditional writes). Matching semantics
 * follow the EDV reference servers (`@interop/edv-server`,
 * `bedrock-edv-storage`): `equals` is an OR across array elements of an AND
 * within each element's `{name: value}` pairs, scoped to the queried index's
 * entries; `has` requires every named attribute be present (value
 * irrelevant). Pagination replaces EDV's `limit`+`hasMore`-only story with
 * WAS's opaque cursor convention (`lib/cursor.ts`), closing the known EDV
 * protocol gap: `cursor` names the keyset position (ascending `resourceId`)
 * to resume from.
 */
import type { ResourceInput } from '../types.js'
import type {
  EqualityCandidate,
  NormalizedIndexDeclaration
} from './equalityIndex.js'
import { isPlainObject } from './isPlainObject.js'
import {
  assertEqualsIsNonEmptyArray,
  assertExactlyOneOfEqualsOrHas,
  assertHasIsNonEmptyStringArray,
  assertNoTermOverlap,
  pageMatches,
  parseQueryPaging
} from './queryProfile.js'
import {
  InvalidRequestBodyError,
  UniqueAttributeConflictError
} from '../errors.js'

/**
 * A validated blinded-index query: the HMAC key id naming which blinded index
 * to search, and exactly one of `equals` / `has`. All names and values are
 * opaque blinded (base64url) strings.
 */
export interface BlindedIndexQuery {
  index: string
  equals?: Array<Record<string, string>>
  has?: string[]
}

/**
 * A page of matching documents: the stored JSON bodies verbatim (EDV encrypted
 * documents pass through untouched), in ascending `resourceId` order.
 * `cursor` is present if and only if a further page may follow (`hasMore`);
 * echo it back in the next query body to resume.
 */
export interface BlindedIndexQueryPage {
  documents: unknown[]
  hasMore: boolean
  cursor?: string
}

/** The shape of an `indexed` entry's attribute, as far as matching reads it. */
interface IndexedAttribute {
  name?: unknown
  value?: unknown
}

/**
 * Validates and normalizes the `blinded-index` profile's query body fields
 * (everything besides `profile`), throwing `invalid-request-body` (400) on a
 * malformed query. Mirrors the EDV query schema (`{index, equals | has,
 * count, limit}`, with `equals` and `has` mutually exclusive and exactly one
 * required) plus the WAS `cursor`. `limit` is coerced leniently like the
 * `changes` profile (a non-numeric or `< 1` value falls back to the default;
 * the backend clamps an oversized one), and the opaque `cursor` is validated
 * by the backend's cursor decode (`invalid-cursor` 400).
 *
 * @param options {object}
 * @param options.body {object}   the parsed query POST body
 * @param [options.requestName] {string}
 * @returns {{ query: BlindedIndexQuery, count: boolean, limit?: number, cursor?: string }}
 */
export function parseBlindedIndexQueryBody({
  body,
  requestName
}: {
  body: {
    index?: unknown
    equals?: unknown
    has?: unknown
    count?: unknown
    limit?: unknown
    cursor?: unknown
  }
  requestName?: string
}): {
  query: BlindedIndexQuery
  count: boolean
  limit?: number
  cursor?: string
} {
  const { index, equals, has, count, limit, cursor } = body

  if (typeof index !== 'string' || index.length === 0) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'A blinded-index query requires a non-empty string "index".',
      pointer: '#/index'
    })
  }

  // Exactly one of `equals` / `has` (the EDV client never sends both; the
  // reference server schema requires at least one).
  assertExactlyOneOfEqualsOrHas({
    equals,
    has,
    detail: 'A blinded-index query requires exactly one of "equals" or "has".',
    requestName
  })

  const query: BlindedIndexQuery = { index }
  if (equals !== undefined) {
    const elements = assertEqualsIsNonEmptyArray({ equals, requestName })
    for (const element of elements) {
      if (
        !isPlainObject(element) ||
        Object.values(element).some(value => typeof value !== 'string')
      ) {
        throw new InvalidRequestBodyError({
          requestName,
          detail:
            '"equals" elements must be objects mapping blinded attribute names to blinded string values.',
          pointer: '#/equals'
        })
      }
    }
    query.equals = equals as Array<Record<string, string>>
  }
  if (has !== undefined) {
    query.has = assertHasIsNonEmptyStringArray({
      has,
      detail: '"has" must be a non-empty array of blinded attribute names.',
      requestName
    })
  }

  return {
    query,
    ...parseQueryPaging({ count, limit, cursor, requestName })
  }
}

/**
 * The shared walk over a document's `indexed` array: yields, per well-formed
 * entry (an object with an `attributes` array), its HMAC key id (unchecked --
 * each consumer applies its own scope / shape rule) and its attributes.
 * Malformed entries are skipped, never thrown on.
 * @param indexed {unknown[]}   the document's `indexed` array
 * @returns {Generator<{ hmacId: unknown, attributes: IndexedAttribute[] }>}
 */
function* indexedEntries(
  indexed: unknown[]
): Generator<{ hmacId: unknown; attributes: IndexedAttribute[] }> {
  for (const entry of indexed) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const { hmac, attributes } = entry as {
      hmac?: { id?: unknown }
      attributes?: unknown
    }
    if (!Array.isArray(attributes)) {
      continue
    }
    yield { hmacId: hmac?.id, attributes: attributes as IndexedAttribute[] }
  }
}

/**
 * Collects the `{name: value}` attribute pairs of a document's `indexed`
 * entries into flat `name:value` terms. `scopedTo` limits collection to the
 * entries of one HMAC key id (the `equals` scope); without it, attributes of
 * every entry are collected (the `has` scope, matching the reference servers'
 * Mongo-parity semantics where `has` names may come from any entry).
 * Malformed entries and attributes are skipped, never thrown on.
 *
 * @param options {object}
 * @param options.indexed {unknown[]}   the document's `indexed` array
 * @param [options.scopedTo] {string}   collect only entries with this hmac id
 * @returns {{ names: Set<string>, terms: Set<string> }}
 */
function collectIndexedAttributes({
  indexed,
  scopedTo
}: {
  indexed: unknown[]
  scopedTo?: string
}): { names: Set<string>; terms: Set<string> } {
  const names = new Set<string>()
  const terms = new Set<string>()
  for (const { hmacId, attributes } of indexedEntries(indexed)) {
    if (scopedTo !== undefined && hmacId !== scopedTo) {
      continue
    }
    for (const attribute of attributes) {
      if (typeof attribute?.name !== 'string') {
        continue
      }
      names.add(attribute.name)
      if (typeof attribute.value === 'string') {
        terms.add(`${attribute.name}:${attribute.value}`)
      }
    }
  }
  return { names, terms }
}

/**
 * True when a stored JSON document matches a blinded-index query. The document
 * must carry an `indexed` entry for the queried `index` (HMAC key id); then
 * `equals` matches when SOME array element has ALL its `{name: value}` pairs
 * present among that index's blinded attributes (an empty element matches
 * nothing -- the reference servers' Mongo `$all: []` parity, which the EDV
 * client emits when querying a never-indexed attribute), and `has` matches
 * when ALL named attributes are present (from any indexed entry). Purely
 * structural string matching -- no decoding, no crypto.
 *
 * @param options {object}
 * @param options.document {unknown}   the stored (parsed) resource JSON
 * @param options.query {BlindedIndexQuery}
 * @returns {boolean}
 */
function matchesBlindedIndexQuery({
  document,
  query
}: {
  document: unknown
  query: BlindedIndexQuery
}): boolean {
  if (typeof document !== 'object' || document === null) {
    return false
  }
  const { indexed } = document as { indexed?: unknown }
  if (!Array.isArray(indexed)) {
    return false
  }

  // The document must be indexed under the queried HMAC key at all.
  const scoped = collectIndexedAttributes({ indexed, scopedTo: query.index })
  if (scoped.names.size === 0) {
    return false
  }

  if (query.equals !== undefined) {
    return query.equals.some(element => {
      const pairs = Object.entries(element)
      return (
        pairs.length > 0 &&
        pairs.every(([name, value]) => scoped.terms.has(`${name}:${value}`))
      )
    })
  }
  // `has`: every named attribute present, from any indexed entry.
  const all = collectIndexedAttributes({ indexed })
  return (query.has ?? []).every(name => all.names.has(name))
}

/**
 * Evaluates a blinded-index query over a Collection's candidate documents and
 * shapes the result: a bare `{count}` for a count query, else a page of
 * matching documents in ascending `resourceId` (code-unit) order with the
 * standard opaque-cursor pagination (`limit` clamped to `[1, MAX_PAGE_SIZE]`,
 * default `DEFAULT_PAGE_SIZE`; `cursor` resumes strictly after its anchor id,
 * so paging stays correct if the anchor was deleted between pages). A
 * malformed `cursor` rejects with `invalid-cursor` (400).
 *
 * Backends call this with every live JSON document of the Collection -- an
 * O(n) full scan, deliberate for these teaching backends (an indexed backend
 * would answer from flattened `hmacId:name:value` attribute tokens, the
 * bedrock-edv-storage strategy).
 *
 * @param options {object}
 * @param options.candidates {Array<{resourceId: string, document: unknown}>}
 * @param options.query {BlindedIndexQuery}
 * @param [options.count] {boolean}   return only the match count
 * @param [options.limit] {number}   requested page size
 * @param [options.cursor] {string}   opaque cursor from a prior page
 * @returns {{ count: number } | BlindedIndexQueryPage}
 */
export function runBlindedIndexQuery({
  candidates,
  query,
  count,
  limit,
  cursor
}: {
  candidates: Array<{ resourceId: string; document: unknown }>
  query: BlindedIndexQuery
  count?: boolean
  limit?: number
  cursor?: string
}): { count: number } | BlindedIndexQueryPage {
  return pageMatches({
    candidates,
    isMatch: candidate =>
      matchesBlindedIndexQuery({ document: candidate.document, query }),
    project: ({ document }) => document,
    count,
    limit,
    cursor
  })
}

/**
 * Collects a document's `unique: true` blinded attributes as
 * `(hmac id, name, value)` triples -- the claims the EDV unique-attribute
 * invariant protects. Malformed entries and attributes are skipped, never
 * thrown on; an attribute counts only when `unique` is exactly `true` and
 * both `name` and `value` are strings.
 *
 * @param options {object}
 * @param options.document {unknown}   the (parsed) document JSON
 * @returns {Array<{ hmacId: string, name: string, value: string }>}
 */
export function collectUniqueBlindedTerms({
  document
}: {
  document: unknown
}): Array<{ hmacId: string; name: string; value: string }> {
  if (typeof document !== 'object' || document === null) {
    return []
  }
  const { indexed } = document as { indexed?: unknown }
  if (!Array.isArray(indexed)) {
    return []
  }
  const terms: Array<{ hmacId: string; name: string; value: string }> = []
  for (const { hmacId, attributes } of indexedEntries(indexed)) {
    if (typeof hmacId !== 'string') {
      continue
    }
    for (const attribute of attributes as Array<
      IndexedAttribute & { unique?: unknown }
    >) {
      if (
        attribute?.unique === true &&
        typeof attribute.name === 'string' &&
        typeof attribute.value === 'string'
      ) {
        terms.push({
          hmacId,
          name: attribute.name,
          value: attribute.value
        })
      }
    }
  }
  return terms
}

/**
 * Enforces the EDV unique-attribute invariant on a write: a `unique: true`
 * blinded `(hmac id, name, value)` triple may be claimed by at most one live
 * document per Collection. Following the reference servers
 * (`@interop/edv-server`, bedrock-edv-storage's unique index over
 * `uniqueAttributes`), a conflict requires the attribute be marked
 * `unique: true` on BOTH sides -- an existing document carrying the same
 * triple without `unique` does not conflict -- and the triple is keyed on the
 * full `(hmac id, name, value)`, so the same blinded pair under a different
 * HMAC key is no conflict. `candidates` MUST already exclude the document
 * being written (its own resource id), so an update keeping its own unique
 * attribute never self-conflicts. Throws `UniqueAttributeConflictError`
 * (409) on a conflict; a document with no unique attributes never throws.
 *
 * The caller is responsible for making the check-and-write atomic (the
 * filesystem backend serializes unique-carrying writes per Collection; the
 * Postgres backend takes a per-Collection advisory lock in the write
 * transaction).
 *
 * @param options {object}
 * @param options.document {unknown}   the incoming (parsed) document JSON
 * @param options.candidates {Array<{resourceId: string, document: unknown}>}
 *   the Collection's other live JSON documents
 * @returns {void}
 */
export function assertNoUniqueBlindedConflict({
  document,
  candidates
}: {
  document: unknown
  candidates: Array<{ resourceId: string; document: unknown }>
}): void {
  assertNoTermOverlap({
    incoming: uniqueBlindedKeys(document),
    candidates,
    termsOf: candidate => uniqueBlindedKeys(candidate.document),
    onConflict: () => new UniqueAttributeConflictError()
  })
}

/**
 * The claim keys of a document's `unique: true` blinded triples. Each triple
 * is keyed unambiguously (hmac ids may themselves contain any delimiter, so a
 * joined string could collide across segment boundaries).
 * @param document {unknown}   the (parsed) document JSON
 * @returns {string[]}
 */
function uniqueBlindedKeys(document: unknown): string[] {
  return collectUniqueBlindedTerms({ document }).map(term =>
    JSON.stringify([term.hmacId, term.name, term.value])
  )
}

/**
 * Which unique-claim checks a Resource write needs: the EDV unique-attribute
 * one when its JSON document carries a `unique: true` blinded attribute, and
 * the plaintext equality one when its Collection declares `unique` indexes.
 * Only a JSON write can make either claim. A backend serializes a write that
 * needs either check per Collection before it scans.
 * @param options {object}
 * @param options.input {ResourceInput}   the write's representation
 * @param [options.uniqueIndexes] {NormalizedIndexDeclaration[]}   the
 *   Collection's `unique`-declared `plaintext.indexes`
 * @returns {{ blindedUnique: boolean, equalityUnique: boolean }}
 */
export function uniqueClaimsOf({
  input,
  uniqueIndexes
}: {
  input: ResourceInput
  uniqueIndexes?: NormalizedIndexDeclaration[]
}): { blindedUnique: boolean; equalityUnique: boolean } {
  return {
    blindedUnique:
      input.kind === 'json' &&
      collectUniqueBlindedTerms({ document: input.data }).length > 0,
    equalityUnique:
      input.kind === 'json' &&
      uniqueIndexes !== undefined &&
      uniqueIndexes.length > 0
  }
}

/**
 * Narrows an equality candidate set to the live, parsable JSON documents --
 * the candidate shape the blinded-index query and the unique-blinded conflict
 * scan consume. A blob or unparsable JSON Resource carries no `content` and is
 * dropped.
 * @param candidates {EqualityCandidate[]}
 * @returns {Array<{ resourceId: string, document: unknown }>}
 */
export function jsonCandidatesFrom(
  candidates: EqualityCandidate[]
): Array<{ resourceId: string; document: unknown }> {
  return candidates
    .filter(candidate => candidate.content !== undefined)
    .map(candidate => ({
      resourceId: candidate.resourceId,
      document: candidate.content
    }))
}
