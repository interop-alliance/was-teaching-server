/**
 * Plaintext equality query evaluation -- the `equality` profile of the reserved
 * Collection `POST .../query` endpoint (the `equality-query` backend feature),
 * and its anonymous-cacheable sibling, the GET `filter[attr]=value` filter on
 * the List Collection endpoint. Unlike the `blinded-index` profile (in which the
 * client computes HMAC-blinded index entries because the server cannot see
 * plaintext), here the *server* extracts and indexes the declared attributes
 * from a Resource's stored JSON content and/or its `custom` metadata object at
 * query time -- a plain Resource write with no extra ceremony is immediately
 * queryable.
 *
 * A Collection opts in by declaring `indexes` in its Collection Description (see
 * `lib/collectionDescription.ts` and the `CollectionIndexDeclaration` wire
 * type). Each declared entry names an attribute plus the `source` it is
 * extracted from (`content` = a JSON Resource's stored content, `custom` = any
 * Resource's `custom` metadata object -- the route by which blob Resources
 * become queryable) and MAY carry `unique: true`, claiming per-Collection
 * uniqueness for that attribute's `(name, value)` pairs.
 *
 * Both storage backends answer the profile through `runEqualityQuery` and
 * enforce the uniqueness invariant through `assertNoUniqueEqualityConflict` /
 * `findEqualityUniqueViolation`, so their matching, ordering, pagination, and
 * uniqueness semantics cannot drift (the same pattern as `lib/blindedIndex.ts`).
 * Matching is strict JSON equality: values compare by type and value with no
 * coercion (`"1"` does not match `1`; `true` does not match `"true"`); a
 * multi-valued (array) attribute matches when any of its elements equals the
 * queried value. Pagination reuses WAS's opaque cursor convention
 * (`lib/cursor.ts`), keyset-ordered by ascending `resourceId`.
 */
import type { CollectionIndexDeclaration } from '../types.js'
import { decodeCursor, encodeCursor } from './cursor.js'
import { clampPageSize, DEFAULT_PAGE_SIZE } from './pagination.js'
import {
  InvalidRequestBodyError,
  UniqueAttributeConflictError
} from '../errors.js'

/**
 * An indexable attribute value: a JSON string, number, or boolean. A declared
 * attribute whose value is one of these (or an array of these) is indexed;
 * anything else (`null`, an object, a nested array) contributes no entry.
 */
export type EqualityValue = string | number | boolean

/**
 * A declared `indexes` entry after normalization: the bare-string shorthand
 * expanded and the optional `source` / `unique` defaulted, so downstream code
 * reads a uniform shape. `source` defaults to `'content'`, `unique` to `false`.
 */
export interface NormalizedIndexDeclaration {
  name: string
  source: 'content' | 'custom'
  unique: boolean
}

/**
 * A validated `equality` query: exactly one of `equals` / `has`. `equals` is a
 * disjunction (OR across its elements) of conjunctions (AND within one
 * element's `{name: value}` pairs); `has` names attributes that must be present
 * with an indexable value, regardless of value. All names are declared index
 * names; all values are plain JSON string / number / boolean.
 */
export interface EqualityQuery {
  equals?: Array<Record<string, EqualityValue>>
  has?: string[]
}

/**
 * A page of matching Resources, in ascending `resourceId` order. Each document
 * carries the Resource `id`; `data` (the stored JSON content) is present for a
 * JSON Resource and absent for a blob; `custom` (the Resource's custom metadata
 * object) is present when the Resource has one. `cursor` is present if and only
 * if a further page may follow (`hasMore`); echo it back in the next query body
 * to resume.
 */
export interface EqualityQueryPage {
  documents: Array<{ id: string; data?: unknown; custom?: unknown }>
  hasMore: boolean
  cursor?: string
}

/**
 * A candidate Resource the backends hand to the evaluator: its id plus the two
 * extraction sources. `content` is the stored (parsed) JSON content, present
 * only for a live JSON Resource (a blob carries none); `custom` is the
 * Resource's custom metadata object, present when it has one (the route by
 * which blobs become queryable).
 */
export interface EqualityCandidate {
  resourceId: string
  content?: unknown
  custom?: unknown
}

/**
 * True for a plain (non-null, non-array) object -- the only shape a `content`
 * or `custom` source can be extracted from.
 * @param value {unknown}
 * @returns {boolean}
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * True when a JSON value is directly indexable -- a string, number, or boolean
 * (an array of these is handled element-by-element by the caller).
 * @param value {unknown}
 * @returns {boolean}
 */
function isIndexableValue(value: unknown): value is EqualityValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

/**
 * Normalizes a Collection Description's declared `indexes` into the uniform
 * {@link NormalizedIndexDeclaration} shape: a bare string entry becomes
 * `{ name, source: 'content', unique: false }`, and an object entry has its
 * optional `source` / `unique` defaulted. An absent declaration normalizes to
 * an empty array. Assumes the declaration has already passed
 * {@link assertSupportedIndexes} (or was read back from storage), so it does no
 * shape validation of its own.
 *
 * @param options {object}
 * @param [options.indexes] {Array<string | CollectionIndexDeclaration>}   the
 *   Collection Description's declared `indexes`
 * @returns {NormalizedIndexDeclaration[]}
 */
export function normalizeIndexes({
  indexes
}: {
  indexes?: Array<string | CollectionIndexDeclaration>
}): NormalizedIndexDeclaration[] {
  if (indexes === undefined) {
    return []
  }
  return indexes.map(entry => {
    if (typeof entry === 'string') {
      return { name: entry, source: 'content', unique: false }
    }
    return {
      name: entry.name,
      source: entry.source ?? 'content',
      unique: entry.unique === true
    }
  })
}

/**
 * Validates a client-supplied Collection `indexes` declaration (shape only) and
 * returns the value to persist verbatim, or `undefined` when absent (an update
 * then leaves the stored declaration untouched, like `name` / `backend` /
 * `encryption`). Mirrors the validation style of `assertSupportedEncryption` /
 * `assertValidEncryptionEpochs` in `lib/encryption.ts`, rejecting a malformed
 * declaration with `invalid-request-body` (400) and a precise `pointer`. Rules:
 * - `indexes` MUST be an array (an EMPTY array is allowed -- it clears the
 *   declaration).
 * - each entry is either a non-empty string (the `content`-sourced shorthand)
 *   or an object with a non-empty string `name`, an optional `source` of
 *   exactly `'content'` or `'custom'`, and an optional boolean `unique`.
 * - declared names MUST be unique across the array regardless of source
 *   (queries refer to attributes by name alone).
 *
 * @param options {object}
 * @param [options.indexes] {unknown}   the request body's `indexes` value
 * @param [options.requestName] {string}   request name for the 400 error title
 * @returns {Array<string | CollectionIndexDeclaration> | undefined}   the
 *   declaration to store, or undefined when absent
 */
export function assertSupportedIndexes({
  indexes,
  requestName
}: {
  indexes?: unknown
  requestName?: string
}): Array<string | CollectionIndexDeclaration> | undefined {
  if (indexes === undefined) {
    return undefined
  }
  if (!Array.isArray(indexes)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'Collection "indexes" must be an array.',
      pointer: '#/indexes'
    })
  }
  const names = new Set<string>()
  indexes.forEach((entry, entryIndex) => {
    const pointer = `#/indexes/${entryIndex}`
    let name: string
    if (typeof entry === 'string') {
      if (entry.length === 0) {
        throw new InvalidRequestBodyError({
          requestName,
          detail:
            'Each "indexes" string entry must be a non-empty attribute name.',
          pointer
        })
      }
      name = entry
    } else if (isPlainObject(entry)) {
      const { name: entryName, source, unique } = entry
      if (typeof entryName !== 'string' || entryName.length === 0) {
        throw new InvalidRequestBodyError({
          requestName,
          detail: 'Each "indexes" entry must have a non-empty string "name".',
          pointer: `${pointer}/name`
        })
      }
      if (source !== undefined && source !== 'content' && source !== 'custom') {
        throw new InvalidRequestBodyError({
          requestName,
          detail:
            'An "indexes" entry "source" must be exactly "content" or "custom".',
          pointer: `${pointer}/source`
        })
      }
      if (unique !== undefined && typeof unique !== 'boolean') {
        throw new InvalidRequestBodyError({
          requestName,
          detail: 'An "indexes" entry "unique" must be a boolean.',
          pointer: `${pointer}/unique`
        })
      }
      name = entryName
    } else {
      throw new InvalidRequestBodyError({
        requestName,
        detail:
          'Each "indexes" entry must be a non-empty string or an object with a "name".',
        pointer
      })
    }
    if (names.has(name)) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: `Duplicate "indexes" attribute name "${name}".`,
        pointer: `${pointer}/name`
      })
    }
    names.add(name)
  })
  // Persist verbatim (bare strings and objects alike survive the round-trip);
  // normalization for extraction/matching happens at query/write time.
  return indexes as Array<string | CollectionIndexDeclaration>
}

/**
 * Validates and normalizes the `equality` profile's query body fields
 * (everything besides `profile`), throwing `invalid-request-body` (400) on a
 * malformed query. Exactly one of `equals` / `has` is required. Every attribute
 * name appearing in `equals` or `has` MUST be among the declared index names
 * (`indexes`, already normalized) -- a query naming an undeclared attribute is
 * rejected fail-closed (a typo or missing declaration surfaces loudly rather
 * than as a silently-empty page). `limit` is coerced leniently as in
 * `parseBlindedIndexQueryBody` (a non-numeric or `< 1` value falls back to the
 * default; the backend clamps an oversized one), and the opaque `cursor` is
 * validated by the backend's cursor decode (`invalid-cursor` 400).
 *
 * @param options {object}
 * @param options.body {object}   the parsed query POST body
 * @param options.indexes {NormalizedIndexDeclaration[]}   the Collection's
 *   normalized declared indexes (the allowed attribute names)
 * @param [options.requestName] {string}
 * @returns {{ query: EqualityQuery, count: boolean, limit?: number, cursor?: string }}
 */
export function parseEqualityQueryBody({
  body,
  indexes,
  requestName
}: {
  body: {
    equals?: unknown
    has?: unknown
    count?: unknown
    limit?: unknown
    cursor?: unknown
  }
  indexes: NormalizedIndexDeclaration[]
  requestName?: string
}): {
  query: EqualityQuery
  count: boolean
  limit?: number
  cursor?: string
} {
  const { equals, has, count, limit, cursor } = body
  const declared = new Set(indexes.map(entry => entry.name))

  // Exactly one of `equals` / `has`: supplying neither, or both, is a 400.
  if ((equals === undefined) === (has === undefined)) {
    throw new InvalidRequestBodyError({
      requestName,
      detail: 'An equality query requires exactly one of "equals" or "has".'
    })
  }

  const query: EqualityQuery = {}
  if (equals !== undefined) {
    if (!Array.isArray(equals) || equals.length === 0) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: '"equals" must be a non-empty array of objects.',
        pointer: '#/equals'
      })
    }
    equals.forEach((element, elementIndex) => {
      const pointer = `#/equals/${elementIndex}`
      if (!isPlainObject(element)) {
        throw new InvalidRequestBodyError({
          requestName,
          detail:
            '"equals" elements must be objects mapping declared attribute names to string, number, or boolean values.',
          pointer
        })
      }
      for (const [name, value] of Object.entries(element)) {
        if (!isIndexableValue(value)) {
          throw new InvalidRequestBodyError({
            requestName,
            detail:
              'An "equals" attribute value must be a string, number, or boolean.',
            pointer: `${pointer}/${name}`
          })
        }
        if (!declared.has(name)) {
          throw new InvalidRequestBodyError({
            requestName,
            detail: `Attribute "${name}" is not declared in the Collection's indexes.`,
            pointer: `${pointer}/${name}`
          })
        }
      }
    })
    query.equals = equals as Array<Record<string, EqualityValue>>
  }
  if (has !== undefined) {
    if (
      !Array.isArray(has) ||
      has.length === 0 ||
      has.some(name => typeof name !== 'string')
    ) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: '"has" must be a non-empty array of declared attribute names.',
        pointer: '#/has'
      })
    }
    for (const name of has as string[]) {
      if (!declared.has(name)) {
        throw new InvalidRequestBodyError({
          requestName,
          detail: `Attribute "${name}" is not declared in the Collection's indexes.`,
          pointer: '#/has'
        })
      }
    }
    query.has = has as string[]
  }

  if (count !== undefined && typeof count !== 'boolean') {
    throw new InvalidRequestBodyError({
      requestName,
      detail: '"count" must be a boolean.',
      pointer: '#/count'
    })
  }

  if (cursor !== undefined && typeof cursor !== 'string') {
    throw new InvalidRequestBodyError({
      requestName,
      detail: '"cursor" must be a string.',
      pointer: '#/cursor'
    })
  }

  // Lenient `limit` coercion, same as the `changes` / `blinded-index` profiles:
  // a non-numeric or `< 1` value is ignored so the backend applies its own
  // default/clamp.
  const parsedLimit = Number(limit)
  const resolvedLimit =
    Number.isFinite(parsedLimit) && parsedLimit >= 1 ? parsedLimit : undefined

  return {
    query,
    count: count === true,
    ...(resolvedLimit !== undefined && { limit: resolvedLimit }),
    ...(cursor !== undefined && { cursor })
  }
}

/**
 * Extracts a Resource's indexable attribute values per its Collection's
 * declared indexes, keyed by declared name. For each declared entry the
 * top-level member is read from its `source` -- `content` from the stored JSON
 * content, `custom` from the custom metadata object -- each only when that
 * source is a plain object. A member is indexable when it is a string, number,
 * or boolean, or an array of those (an array indexes the Resource under EACH
 * element; a `null`, object, or nested-array element contributes nothing);
 * anything else, an absent member, or a non-object source contributes no entry
 * for that attribute. Strict typing, no coercion: `1`, `"1"`, and `true` stay
 * distinct.
 *
 * @param options {object}
 * @param options.indexes {NormalizedIndexDeclaration[]}   the normalized indexes
 * @param [options.content] {unknown}   the stored JSON content (a JSON Resource)
 * @param [options.custom] {unknown}   the custom metadata object
 * @returns {Map<string, EqualityValue[]>}   declared name to its indexable values
 */
export function extractEqualityAttributes({
  indexes,
  content,
  custom
}: {
  indexes: NormalizedIndexDeclaration[]
  content?: unknown
  custom?: unknown
}): Map<string, EqualityValue[]> {
  const extracted = new Map<string, EqualityValue[]>()
  for (const declaration of indexes) {
    const source = declaration.source === 'custom' ? custom : content
    if (!isPlainObject(source)) {
      continue
    }
    const member = source[declaration.name]
    const values: EqualityValue[] = []
    if (Array.isArray(member)) {
      for (const element of member) {
        if (isIndexableValue(element)) {
          values.push(element)
        }
      }
    } else if (isIndexableValue(member)) {
      values.push(member)
    }
    if (values.length > 0) {
      // A name may be declared once (unique across the array), so no merge is
      // needed; the last declaration for a name wins if that ever changes.
      extracted.set(declaration.name, values)
    }
  }
  return extracted
}

/**
 * True when a candidate Resource matches an equality query. `equals` matches
 * when SOME element has ALL its `{name: value}` pairs present among the
 * candidate's extracted attributes (an empty element matches nothing); `has`
 * matches when EVERY named attribute is present with an indexable value. Strict
 * value equality (`===`), so `1`, `"1"`, and `true` never cross-match; a
 * multi-valued attribute matches when any of its values equals the queried one.
 *
 * @param options {object}
 * @param options.candidate {EqualityCandidate}
 * @param options.query {EqualityQuery}
 * @param options.indexes {NormalizedIndexDeclaration[]}
 * @returns {boolean}
 */
export function matchesEqualityQuery({
  candidate,
  query,
  indexes
}: {
  candidate: EqualityCandidate
  query: EqualityQuery
  indexes: NormalizedIndexDeclaration[]
}): boolean {
  const attributes = extractEqualityAttributes({
    indexes,
    content: candidate.content,
    custom: candidate.custom
  })
  if (query.equals !== undefined) {
    return query.equals.some(element => {
      const pairs = Object.entries(element)
      return (
        pairs.length > 0 &&
        pairs.every(([name, value]) =>
          (attributes.get(name) ?? []).some(held => held === value)
        )
      )
    })
  }
  return (query.has ?? []).every(name => attributes.has(name))
}

/**
 * Evaluates an equality query over a Collection's candidate Resources and
 * shapes the result: a bare `{count}` for a count query, else a page of
 * matching documents in ascending `resourceId` (code-unit) order with the
 * standard opaque-cursor pagination (`limit` clamped to `[1, MAX_PAGE_SIZE]`,
 * default `DEFAULT_PAGE_SIZE`; `cursor` resumes strictly after its anchor id,
 * so paging stays correct if the anchor was deleted between pages). A malformed
 * `cursor` rejects with `invalid-cursor` (400).
 *
 * Backends call this with every live Resource of the Collection (JSON Resources
 * carrying `content`, blobs carrying only `custom`) -- an O(n) full scan,
 * deliberate for these teaching backends (a materialized backend would answer
 * from a JSONB expression index or attribute side-table).
 *
 * @param options {object}
 * @param options.candidates {EqualityCandidate[]}
 * @param options.query {EqualityQuery}
 * @param options.indexes {NormalizedIndexDeclaration[]}
 * @param [options.count] {boolean}   return only the match count
 * @param [options.limit] {number}   requested page size
 * @param [options.cursor] {string}   opaque cursor from a prior page
 * @returns {{ count: number } | EqualityQueryPage}
 */
export function runEqualityQuery({
  candidates,
  query,
  indexes,
  count,
  limit,
  cursor
}: {
  candidates: EqualityCandidate[]
  query: EqualityQuery
  indexes: NormalizedIndexDeclaration[]
  count?: boolean
  limit?: number
  cursor?: string
}): { count: number } | EqualityQueryPage {
  const matches = candidates
    .filter(candidate => matchesEqualityQuery({ candidate, query, indexes }))
    // Ascending `resourceId` in code-unit order -- the SAME ordering the cursor
    // seek (`resourceId > after`) uses, so the keyset is stable.
    .sort((left, right) =>
      left.resourceId < right.resourceId
        ? -1
        : left.resourceId > right.resourceId
          ? 1
          : 0
    )

  if (count === true) {
    return { count: matches.length }
  }

  // Seek strictly past the cursor's anchor id.
  let startIndex = 0
  if (cursor !== undefined) {
    const { after } = decodeCursor(cursor)
    const found = matches.findIndex(({ resourceId }) => resourceId > after)
    startIndex = found === -1 ? matches.length : found
  }

  const pageSize =
    limit === undefined ? DEFAULT_PAGE_SIZE : clampPageSize(limit)

  // Take `pageSize + 1` to detect a further page without a second pass.
  const window = matches.slice(startIndex, startIndex + pageSize + 1)
  const hasMore = window.length > pageSize
  const page = hasMore ? window.slice(0, pageSize) : window

  return {
    documents: page.map(candidate => ({
      id: candidate.resourceId,
      // `data` present iff the Resource has JSON content (absent for a blob);
      // `custom` present when the Resource carries a custom metadata object.
      ...(candidate.content !== undefined && { data: candidate.content }),
      ...(isPlainObject(candidate.custom) && { custom: candidate.custom })
    })),
    hasMore,
    ...(hasMore && {
      cursor: encodeCursor(page[page.length - 1]!.resourceId)
    })
  }
}

/**
 * Collects a Resource's `unique: true` attribute claims as `(name, value)`
 * pairs -- the claims the per-Collection uniqueness invariant protects. Only
 * declared entries carrying `unique: true` are considered; each indexable value
 * (an array value claims EACH element) becomes one claim. A Resource whose
 * unique attribute is absent or non-indexable makes no claim.
 *
 * @param options {object}
 * @param options.indexes {NormalizedIndexDeclaration[]}
 * @param [options.content] {unknown}   the stored JSON content
 * @param [options.custom] {unknown}   the custom metadata object
 * @returns {Array<{ name: string, value: EqualityValue }>}
 */
export function collectUniqueEqualityTerms({
  indexes,
  content,
  custom
}: {
  indexes: NormalizedIndexDeclaration[]
  content?: unknown
  custom?: unknown
}): Array<{ name: string; value: EqualityValue }> {
  const uniqueDeclarations = indexes.filter(declaration => declaration.unique)
  if (uniqueDeclarations.length === 0) {
    return []
  }
  const extracted = extractEqualityAttributes({
    indexes: uniqueDeclarations,
    content,
    custom
  })
  const terms: Array<{ name: string; value: EqualityValue }> = []
  for (const [name, values] of extracted) {
    for (const value of values) {
      terms.push({ name, value })
    }
  }
  return terms
}

/**
 * Enforces the per-Collection unique-attribute invariant on a write: a
 * `unique: true` declared attribute's `(name, value)` claim may be held by at
 * most one live Resource in the Collection. Because the declaration is
 * Collection-level, a conflict does NOT require the other side to opt in -- ANY
 * other live Resource whose extracted value for that attribute equals the claim
 * conflicts. `candidates` MUST already exclude the Resource being written, so a
 * Resource re-asserting its own existing value never self-conflicts. Throws
 * `UniqueAttributeConflictError` (409) on a conflict; a Resource with no unique
 * claim never throws.
 *
 * The caller is responsible for making the check-and-write atomic (the
 * filesystem backend serializes claim-carrying writes per Collection; the
 * Postgres backend takes a per-Collection advisory lock in the write
 * transaction), the same pattern as `assertNoUniqueBlindedConflict`.
 *
 * @param options {object}
 * @param options.indexes {NormalizedIndexDeclaration[]}
 * @param [options.content] {unknown}   the incoming Resource's content
 * @param [options.custom] {unknown}   the incoming Resource's custom metadata
 * @param options.candidates {EqualityCandidate[]}   the Collection's OTHER live
 *   Resources (the one being written already excluded)
 * @returns {void}
 */
export function assertNoUniqueEqualityConflict({
  indexes,
  content,
  custom,
  candidates
}: {
  indexes: NormalizedIndexDeclaration[]
  content?: unknown
  custom?: unknown
  candidates: EqualityCandidate[]
}): void {
  const incoming = collectUniqueEqualityTerms({ indexes, content, custom })
  if (incoming.length === 0) {
    return
  }
  // Key the claims unambiguously (a name or a string value may itself contain
  // any delimiter, and the value's JSON type must stay distinct -- `1` vs `"1"`
  // -- so a joined string could collide).
  const claimed = new Set(
    incoming.map(term => JSON.stringify([term.name, term.value]))
  )
  for (const candidate of candidates) {
    const held = collectUniqueEqualityTerms({
      indexes,
      content: candidate.content,
      custom: candidate.custom
    })
    for (const term of held) {
      if (claimed.has(JSON.stringify([term.name, term.value]))) {
        throw new UniqueAttributeConflictError({ variant: 'equality' })
      }
    }
  }
}

/**
 * Scans a Collection's candidates for an existing violation of a unique claim:
 * two DIFFERENT Resources holding the same `(name, value)` under the
 * `unique`-declared entries. Returns the first such `{ name, value }`, or
 * `undefined` when none exists. Used when a Collection update ADDS a unique
 * claim over already-stored Resources (the declare-time conflict scan); the
 * request layer rejects a found violation with `id-conflict` (409).
 *
 * @param options {object}
 * @param options.indexes {NormalizedIndexDeclaration[]}
 * @param options.candidates {EqualityCandidate[]}   the Collection's live
 *   Resources
 * @returns {{ name: string, value: EqualityValue } | undefined}
 */
export function findEqualityUniqueViolation({
  indexes,
  candidates
}: {
  indexes: NormalizedIndexDeclaration[]
  candidates: EqualityCandidate[]
}): { name: string; value: EqualityValue } | undefined {
  const uniqueDeclarations = indexes.filter(declaration => declaration.unique)
  if (uniqueDeclarations.length === 0) {
    return undefined
  }
  // Map each seen claim key to the resourceId holding it; a second, different
  // holder is the violation.
  const holders = new Map<string, string>()
  for (const candidate of candidates) {
    const held = collectUniqueEqualityTerms({
      indexes: uniqueDeclarations,
      content: candidate.content,
      custom: candidate.custom
    })
    for (const term of held) {
      const key = JSON.stringify([term.name, term.value])
      const existing = holders.get(key)
      if (existing !== undefined && existing !== candidate.resourceId) {
        return { name: term.name, value: term.value }
      }
      holders.set(key, candidate.resourceId)
    }
  }
  return undefined
}

/**
 * Collects the GET List Collection `filter[<name>]=<value>` equality filters
 * from a Fastify parsed querystring object -- the anonymous-cacheable entry
 * point over the same equality machinery as the POST profile. Fastify's default
 * querystring parser leaves bracket keys literal and percent-decodes them, so a
 * `filter[parentId]=first-post` query arrives as the key `filter[parentId]`.
 * Returns a `{ <name>: <value> }` map, or `undefined` when no `filter[...]` key
 * is present (the ordinary listing path). A repeated same attribute (the parser
 * yields an array value) is rejected with `invalid-request-body` (400) -- v1
 * admits only a single value per attribute. Attribute names are NOT validated
 * against the Collection's declarations here; the handler does that once it has
 * fetched the description.
 *
 * @param options {object}
 * @param options.query {Record<string, string | string[] | undefined>}   the
 *   Fastify-parsed querystring object
 * @param [options.requestName] {string}
 * @returns {Record<string, string> | undefined}
 */
export function parseListFilter({
  query,
  requestName
}: {
  query: Record<string, string | string[] | undefined>
  requestName?: string
}): Record<string, string> | undefined {
  const filters: Record<string, string> = {}
  let found = false
  for (const [key, value] of Object.entries(query)) {
    const match = /^filter\[(.+)\]$/.exec(key)
    if (!match) {
      continue
    }
    const name = match[1]!
    found = true
    if (Array.isArray(value)) {
      throw new InvalidRequestBodyError({
        requestName,
        detail: `Filter attribute "${name}" may not be repeated.`,
        pointer: `#/filter/${name}`
      })
    }
    if (value === undefined) {
      continue
    }
    filters[name] = value
  }
  return found ? filters : undefined
}
