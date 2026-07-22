# WAS Teaching Server Roadmap (spec gap analysis)

Status as of 2026-07-22. Produced by comparing `spec.md` (in the
[w3c-ccg/wallet-attached-storage-spec](https://github.com/w3c-ccg/wallet-attached-storage-spec)
repo, as of commit `fa1293a`) against the `was-teaching-server` source
(`src/routes.ts`, `src/requests/*`, `src/errors.ts`, `src/policy.ts`,
`src/zcap.ts`, `src/backends/{filesystem,postgres}.ts`). The problem-type
registry and the shared WAS wire model now live in `@interop/storage-core`.

Scope: features the **spec defines that the server does not yet implement** (or
implements with deviations). A section of reverse gaps (server features the spec
does not yet describe) is at the end, since those are spec-side work. A test
coverage section (conformance-suite and `test/` gaps from the 2026-07-22
coverage analysis) sits in between.

This document tracks only the **remaining** gaps; completed items are dropped as
they land (the shipped feature set is recorded in CHANGELOG.md, and earlier
revisions of this doc carried the full inventory). The server implements the
whole core protocol surface -- CRUD at all three levels, listings with cursor
pagination, policies, linksets, quotas/backends reads, metadata, export/import,
conditional writes, key epochs, both `POST .../query` profiles, chunk
addressing, zcap revocation, and the full error-type registry.

## Item format

Each work item is a `### WAS-N: Title` heading followed by a field block and
free prose context. Ids are permanent and never reused; new items take the next
unused number regardless of section. Statuses: `todo`, `in-progress`, `draft`
(no actionable done-state yet -- spec-blocked or a parking record); `done` items
are dropped from this file once shipped (CHANGELOG.md is the record). Full
conventions live in [AGENTS.md](AGENTS.md) under "Roadmap & Task Conventions".

---

## Backends: external (BYOS) + encryption feature

Designed in detail in the Google Drive BYOS plan (a Google Drive
`managedBy: external` "Bring Your Own Storage" backend, plaintext and
EDV-encrypted, with encryption as a backend **feature**). That plan's staged
work plan is the authoritative sequencing; stages 1-3 have fully shipped (the
EDV-over-WAS client profile, registration + the per-Collection resolver, the
`features` vocabulary, and all four EDV server affordances -- `chunked-streams`
was the last token, landed 2026-07-19). Remaining, in order:

### WAS-1: Google Cloud console identity verification for interopalliance.org

- status: todo
- priority: high
- labels: gdrive-byos, policy
- acceptance:
  - [ ] interopalliance.org org/brand identity verification completed in the
        Google Cloud console
  - [ ] Consent screen can be configured under the verified org (unblocks OAuth
        client registration)

Complete Google Cloud console organization / brand identity verification for
interopalliance.org, the prerequisite for publishing an OAuth consent screen
tied to the org. Blocks all remaining Google Drive BYOS work: the OAuth client
setup, both adapter stages, and the ToS clearance conversation all presuppose a
verified org. Note: This is technically not necessary for the feature, but will
help with verification and testing.

### WAS-2: Google OAuth confidential client + consent setup (plan stage 4)

- status: todo
- priority: high
- labels: gdrive-byos, oauth
- blocked-by: WAS-1
- acceptance:
  - [ ] PKCE authorization-code exchange wired end to end (wallet obtains the
        one-time code against the server's client; server exchanges and stores
        the refresh token)
  - [ ] Consent screen on the non-sensitive tier only (`drive.file` +
        `openid email`)
  - [ ] `connection.status` lifecycle closed: registered to connected on
        exchange, `invalid_grant` on refresh flips to revoked/expired, and
        deregistration revokes the token at Google

Register the WAS server as a Google **confidential OAuth client** (server
config: `client_id` / `client_secret` / `redirect_uri`); consent screen on the
non-sensitive tier only (`drive.file` + `openid email` -- never the restricted
scopes, which force an annual CASA audit, and not `drive.appdata`); wire the
PKCE authorization-code exchange (wallet obtains the one-time code against the
server's client; server exchanges and stores the refresh token). This is also
where the **connection lifecycle** gap left open by stage 2 closes:
`connection.status` never advances past `registered` today -- the exchange moves
it to `connected`, and `invalid_grant` on refresh flips it to
`revoked`/`expired` (deregistration should revoke the token at Google, not just
forget it). Open sub-decision to settle here: **secret-at-rest custody for
refresh tokens** (server master key vs. the WebKMS substrate; rotation) --
distinct from EDV client keys, which the server never holds. Prerequisite for
the two adapter stages below.

### WAS-3: Google Drive plaintext adapter (plan stage 5)

- status: todo
- priority: high
- labels: gdrive-byos, backend
- blocked-by: WAS-1, WAS-2
- acceptance:
  - [ ] `GoogleDriveBackend implements StorageBackend` with the folder-mirror
        layout and a persisted, rebuildable path-to-id index
  - [ ] Resumable uploads, `about.get` quotas, and backoff with jitter
  - [ ] v1 scope held to personal / My Drive only

`GoogleDriveBackend implements StorageBackend`: OAuth token custody + refresh,
the folder-mirror layout, the memoized path-to-id index (persisted as an in-tree
`.index.json`; rebuildable from `files.list` + `appProperties` -- the
index-authority choice, manifest-in-Drive vs. the server's `default` backend, is
still open), resumable uploads, `about.get` quotas, backoff with jitter. v1
targets personal / My Drive only (one code path covers consumer and Workspace
personal storage).

### WAS-4: Google Drive EDV flavor (plan stage 6)

- status: todo
- priority: medium
- labels: gdrive-byos, encryption
- blocked-by: WAS-1, WAS-3
- acceptance:
  - [ ] The adapter advertises the EDV feature set: JWE documents as opaque
        files, chunk subfolders
  - [ ] Blinded attributes in `appProperties` natively serve blinded-index
        `/query`
  - [ ] Server-side `sequence` enforcement, with the single-instance mutex
        limitation (no horizontal scaling) documented

The same adapter advertising the EDV feature set: JWE documents as opaque files,
chunk subfolders, blinded attributes in `appProperties` for natively-served
blinded-index `/query`, and server-side `sequence` enforcement (Drive has no
atomic compare-and-set; the per-resource mutex is single-instance only,
horizontal scaling documented as out of scope). Which metadata-leakage
mitigations are worth their cost (size padding, keeping blinded attributes off
`appProperties` to deny Google the equality classes) is an open question to
settle here, along with what to upstream into the spec's privacy-considerations
text.

### WAS-5: Drive API ToS use-case clearance

- status: todo
- priority: low
- labels: gdrive-byos, policy
- blocked-by: WAS-1
- acceptance:
  - [ ] Written position on the "backup of app content to Drive" / "Drive as a
        CDN" prohibited-use clauses, framing WAS as primary, user-driven storage
  - [ ] Decision recorded on whether to seek Google's written consent

Before scaling past the teaching/prototype tier. The "backup of app content to
Drive" and "Drive as a CDN" prohibited-use clauses are a genuine gray area for
BYOS; frame WAS in any OAuth verification as _primary, user-driven storage_
(never a backup target), and decide whether to seek Google's written consent. A
legal/policy item, not a technical one.

## Data model gaps

### WAS-6: Resource `id` supplied on POST create

- status: draft (spec-blocked)
- priority: low
- labels: data-model, spec-blocked
- acceptance: none yet -- implement only once the spec defines a
  content-type-independent mechanism

`CollectionRequest.post` always generates a uuid and ignores any client-chosen
id. The spec's Create Resource error list (`reserved-id`, `id-conflict` for "the
supplied Resource `id`") implies a client can supply one, and its POST example
narrates "since no Resource id was specified, the server auto-generated an id"
-- but the Resource section never states the _mechanism_.

The spec defines it only for **Collections**: "When a Collection is created via
a `POST`, the client can specify the `id` of the Collection. If the `id` is not
specified, one is auto-generated." The Resource POST section leans on that
convention without restating it. A body `id` property works for a Collection
Description, whose body is a JSON object the server owns the schema of; it does
not generalize to a Resource, whose POST body **is** the stored content and may
be an opaque binary blob. There is no `Slug` header in the spec (grepped: zero
hits). So this is a spec ambiguity before it is a server gap. Implement only
once the spec nails a content-type-independent mechanism.

### WAS-7: Authenticated provenance across export/import (server DID + signed metadata)

- status: todo
- priority: medium
- labels: data-model, security
- acceptance:
  - [ ] The server has its own `did:webvh` DID (derived from `SERVER_URL`,
        `portable: true`) and signing key, distinct from any Space controller;
        the DID log is served at the corresponding well-known route
  - [ ] The identity is minted automatically on first boot (identity state
        absent AND store empty), atomically, with key material encrypted at rest
        under the KEK; identity absent but store non-empty refuses to boot
        (minting then requires the admin script; no env-flag override)
  - [ ] Boot fails loudly when `SERVER_URL` does not match the URL recorded in
        the identity state (no silent re-mint); the error names both URLs and
        points at the migration runbook
  - [ ] Export signs each metadata sidecar and Space/Collection Description over
        a canonical serialization covering the server-managed fields and the
        resource content digest, referencing the DID log `versionId`, and embeds
        a snapshot of the DID log so archives verify offline; the signature
        envelope is signing-time-agnostic (no export-specific context in the
        signed bytes); chunked resources use a composite digest over the ordered
        chunk-digest list
  - [ ] Import verifies signatures: verified archives keep `createdBy`;
        unverified archives import with `createdBy` dropped, not rejected; the
        import report distinguishes "signature invalid" from "signature valid,
        content mismatch"
  - [ ] An admin script performs `SERVER_URL` migration (appends the domain-move
        log entry, updates the recorded URL) and explicit minting over a
        non-empty store
  - [ ] `docs/admin-guide.md` gains runbooks for identity backup, `SERVER_URL`
        migration, and compromise recovery (re-mint)

Raised 2026-07-09, while implementing server-managed `createdBy`.

_The gap._ The server records a server-managed `createdBy` (the DID of whoever
created a Space, Collection, or Resource) and refuses to let a client set it:
every live write path strips a `createdBy` carried in a request body and
substitutes the verified invoker's DID. Within a running server that property
holds. It does not survive **export/import**. An exported archive is a plain tar
of the on-disk representation: `.meta.<id>.json` sidecars, `.space.<id>.json`
and `.collection.<id>.json` description documents, and resource bodies. On
import the server reads `createdBy` straight out of those files and persists it.
Nothing authenticates them. So:

- A hand-crafted archive can attribute any Resource to any DID. The importer
  only needs write access to a Space of its own.
- Round-tripping through export/import launders provenance: the value that comes
  back out is whatever the archive said, not what any server ever observed.
- The same is true of `createdAt` and the monotonic `version`. `createdBy` is
  simply the first field where the forgery is _interesting_, because it names a
  party rather than describing a byte range.

Import cannot fix this by validating harder. Import must preserve `createdBy` --
that is what makes a backup a backup -- so it necessarily trusts the archive.
Refusing to import a `createdBy` would break restore; accepting it means
accepting whatever the file says. The trust has to come from somewhere else.

_The shape of a fix._ Give the **server its own DID and signing key**, distinct
from any Space controller, and have it sign the metadata it claims authorship
of:

- On write (or at least on export), the server signs each `.meta.<id>.json`
  sidecar and each Space/Collection Description, over a canonical serialization
  that covers the server-managed fields (`createdBy`, `createdAt`, `version`,
  `metaVersion`) and the resource content digest.
- On import, the server verifies the signature. An archive whose provenance was
  signed by a server DID the importer trusts keeps its `createdBy`; one that was
  not, or that fails verification, is imported with `createdBy` **dropped**
  (absent = "not recorded", the semantics already defined) rather than rejected.
  That degrades cleanly: a hand-rolled archive still imports, it just carries no
  attribution it did not earn.
- Cross-server import then becomes meaningful: `createdBy` from server B is
  worth something to server A exactly insofar as A trusts B's DID.

This turns `createdBy` from a value the current server happens to remember into
a statement some named server actually made -- a verifiable credential about a
storage event, in effect.

_Design decisions (2026-07-22)._

- **DID method: `did:webvh`, derived from `SERVER_URL`.** The server already
  serves HTTPS at that origin, so it hosts its own DID log at the well-known
  route. `did:key` cannot express key history; `did:web` has no verifiable
  history. `did:webvh` gives both, and its log is **self-certifying**
  (SCID-bound, hash-chained, each entry signed by the previously authorized
  update key) -- so exports embed a log snapshot and importers verify provenance
  offline, against the key epoch current at export time, without the origin
  server being reachable. The signed payload references the log `versionId` so
  the importer knows which epoch to check. Mint with `portable: true` so a later
  `SERVER_URL` migration can keep the SCID.
- **The server DID is self-managed.** Its signatures are consumed only by
  importers, who resolve against a log the server itself hosts; there is no
  external registrar or ceremony, and the trust anchor is the domain plus the
  operator's reputation, not the key. So the server mints on first boot and
  rotates by appending log entries on its own schedule, no human in the loop.
- **Key custody.** The server key is NOT a WebKMS keystore entry (that facet
  models client-controlled keystores with zcap authz -- the wrong shape for the
  server's own identity, and it would invert the dependency). It is
  server-private state that merely reuses the KEK encryption-at-rest mechanism
  (`KMS_RECORD_KEK` pattern).
- **Assurance ceiling, stated honestly.** Self-management means server
  compromise = DID compromise: an attacker who owns the box owns the update key
  and any pre-committed next key. Proportionate for a reference server signing
  provenance metadata. Upgrade path (documented, not implemented): operator-held
  pre-rotation keys (`nextKeyHashes`) or `did:webvh` witnesses.
- **Rotation is hygiene; compromise recovery is operator work.** Routine
  rotation keeps old signatures valid (the log proves the old key was authorized
  at that epoch). But "distrust signatures made after date X" cannot be
  expressed by appending log entries, because archive signatures carry no
  trustworthy timestamp -- a forger with the stolen key backdates freely. On
  compromise the DID's attestations are suspect wholesale and the operator mints
  a fresh identity.
- **DID state is critical, non-restorable state.** The log and key material
  cannot be recovered from the archives they protect; losing them means the
  server can never again extend that DID. Backing them up is an operator duty
  (admin guide).
- **Sign on export, not on write.** The cost of sign-on-write is not CPU
  (Ed25519 sign is microseconds; every authenticated request already does a zcap
  signature _verification_) but complexity: canonicalization on every write path
  in both backends, and since `version`/`metaVersion` bump on every write, each
  write re-signs and discards the previous signature -- hot-path machinery that
  ends up holding exactly one signature per object, over its latest state, which
  is what a single export-time pass produces anyway. Nor does sign-on-write buy
  real tamper-evidence here: the signing key is KEK-decryptable on the same box
  as the store, and an importer cannot tell when a signature was made, so the
  exported artifact's trust semantics are identical either way. The obligation
  this choice imposes: the canonical serialization and signature envelope must
  be **signing-time-agnostic** -- a statement about the object (server-managed
  fields + content digest + DID log `versionId`) with no export-specific context
  (no export timestamp, no manifest reference) inside the signed bytes -- so
  signing the same envelope at write time can be added later as an opt-in
  producing bit-compatible signatures. Triggers for revisiting: custody
  separation (a backend where the store lives with a party the operator does not
  fully trust -- an external Postgres, or BYOS metadata on Google Drive), and
  write receipts (see _Option value_).
- **The envelope binds the content digest.** The signature is a claim that "DID
  X created content with digest D" -- leaving the content unbound would let an
  archive pair authentic metadata with substituted bytes. This chains nicely to
  the existing Request Body Integrity enforcement: the server verified a
  client-signed multihash over the content at write time, so the digest it
  attests at export traces back to something the client signed. Same multihash
  encoding (sha-256, `mh=`) as the `Digest` header, for consistency and hash
  agility. Riders:
  - _Chunked resources_ get a composite digest over the **ordered list of chunk
    digests**, not the concatenated bytes -- verification stays streaming and
    per-chunk. (Consequence for write receipts: the full-content digest exists
    only once the last chunk lands, so a receipt is mintable at completion, not
    per-chunk.)
  - _Conflated failure is intentional but must be reported distinctly._ A
    corrupted body fails verification and drops `createdBy` just like a forgery
    -- correct, since the attribution does not apply to different bytes -- but
    import must distinguish "signature invalid" from "signature valid, content
    mismatch" in its logging/report, or operators debugging bit-rot will
    conclude signatures are flaky.
  - _Content-transforming migrations invalidate provenance._ Any future tool
    that rewrites bytes (re-encryption, plaintext/EDV conversion) must either
    re-attest over the transformed content or accept the drop.
  - _Omission stays invisible_ -- every surviving envelope still verifies after
    an object is deleted from an archive. Completeness is inherently the export
    manifest's job (see _Option value_); the per-object envelope covers
    portability, not completeness. Complementary, not redundant.

_Boot and migration behavior._

- **First-boot detection** = absence of persisted identity state (DID log +
  KEK-encrypted key file, e.g. under a server-scoped `.server/identity/` area),
  not "data dir empty". Rules: identity absent + store empty = mint; identity
  absent + store non-empty = refuse to boot (this looks like a restore that lost
  the key, and silently minting would fork the server's identity); the only
  override is minting explicitly via the admin script -- no env-flag escape
  hatch, keeping the dangerous path off the env-var surface; identity present =
  load it and compare its recorded URL against `SERVER_URL`, failing loudly on
  mismatch. Minting must be atomic (temp + rename) so a crash mid-mint cannot
  leave a half-identity.
- **`SERVER_URL` migration** is a deliberate act, not a re-derivation: the SCID
  binds the initial log entry, so the DID must not silently follow the env var
  (same foot-gun class as the zcap `invocationTarget` exact-match constraint).
  Affordances: (1) the boot-time mismatch error is the discovery point; (2) an
  offline admin script (the `reencrypt-kms-records.ts` pattern) appends the
  signed domain-move log entry and updates the recorded URL; (3) the documented
  alternative is re-minting fresh, accepting provenance discontinuity -- old
  archives stay verifiable either way via their embedded log snapshots; (4) the
  admin guide notes that keeping the old domain serving (or redirecting) the log
  helps live resolution of the old DID string but is not required for archive
  verification.

_Spec status (resolved 2026-07-22)._ The spec defines `createdBy` on the Space,
Collection, and Resource Metadata data models (OPTIONAL, server-managed,
read-only) but no way to _authenticate_ that claim once the data leaves the
server, nor a server DID to anchor it. Resolution: the WAS spec itself gains
only (a) a server-DID anchor -- how a server advertises its DID, via the
well-known DID log route -- and (b) a normative reference from the Export/Import
operations to a separate reusable **container spec** (WAS-37, draft) that owns
the envelope format, manifest, and verification procedure. The Keyhive "concap"
format check moves to WAS-37's design phase. Implementation does not wait on
either: WAS-7 ships against the de facto format, and the spec text is extracted
from it (this repo's existing pattern).

_Option value._ Once the server has a DID and signing key, other uses become
cheap; recorded here so the option value is not lost (razor: TLS already
authenticates live reads, so a signature only earns its keep where the statement
outlives the connection -- stored for later, shown to a third party, or compared
between parties):

- **Write receipts** -- a signed "stored resource `id` with content digest D at
  version N at time T" returned to the writer; the live-path counterpart of the
  export signing. The signing-time-agnostic envelope (see design decisions)
  keeps this a later opt-in: mint the same envelope at write time and return it
  to the client, without storing it.
- **Signed changes-feed checkpoints** -- promoted to its own item, WAS-36.
- **Epoch anti-rollback** -- a signed current-epoch statement for
  multi-recipient collections; `epochsMac` binds epoch state but is only
  server-verifiable, a signature makes the freshness claim third-party- and
  offline-verifiable.
- **Server as zcap delegatee** -- the receiving direction: a user delegates a
  read capability to the server's DID so it can pull from a peer server
  unattended (server-to-server backup / replication / migration). Any future
  federation story needs the server DID as a prerequisite.
- **Signed export manifest** -- a whole-archive "backup receipt" over the
  manifest's content digests. The completeness complement to the per-object
  envelopes: per-object signatures cannot detect an object _omitted_ from an
  archive (see the digest-binding decision), so omission-detection is inherently
  the manifest's job.

_Related._ `createdBy` implementation: `invokerDid()` in
`src/auth-header-hooks.ts`; the strip-and-apply in `writeSpace` /
`writeCollection` / `_writeResourceLocked` (both backends). The import path that
trusts the archive: `importSpace` in `src/backends/filesystem.ts` (writes
descriptions and sidecars raw) and in `src/backends/postgres.ts` (routes through
`_upsertCollection`, still trusting the archived value).

### WAS-54: Read-side caching: 304 on `If-None-Match` and `Cache-Control`

- status: todo
- priority: low
- labels: caching
- acceptance:
  - [ ] A Resource GET/HEAD with an `If-None-Match` that matches the current
        `ETag` returns 304 Not Modified with no body (and the `ETag` header),
        per RFC 9110 conditional-read semantics; a non-matching validator
        returns the full 200 representation
  - [ ] The same conditional-read handling applies to the other ETag-emitting
        reads (chunk GET/HEAD, `/meta`, Collection Description)
  - [ ] Non-idempotent responses are marked non-cacheable
        (`Cache-Control: no-store` on POST responses), per the spec SHOULD
  - [ ] Integration tests in `test/`, plus optional-tier conformance tests in
        the `conditional-requests-api` suite (the spec keeps caching at
        SHOULD/MAY, so they stay optional-tier)

The read-side half of the caching story (discovered-from: WAS-45; recorded as
the one genuinely unimplemented area in the WAS-45 dark-section triage). The
write-side validators already exist: `formatEtag` in `src/lib/etag.ts` emits
strong version-based ETags on GET/HEAD, and `If-Match`/`If-None-Match` gate
writes via `src/lib/preconditions.ts` -- but no read path ever evaluates
`If-None-Match`, so clients re-download unchanged content. Note the spec defers
`Cache-Control` semantics in an editor's note, so keep the `no-store` marking
minimal and revisit if the spec text firms up.

## Authorization profile

### WAS-38: Conformance tests for the delegated Create Space failure shapes

- status: todo
- priority: medium
- labels: authz, conformance-suite
- acceptance:
  - [ ] Chain rooted in a different DID than the body's controller: 400,
        `controller-mismatch`, Space not created
  - [ ] Expired delegation (proof backdated via ezcap's `now` override, past the
        verifier's clock-skew tolerance): 400, `controller-mismatch`, Space not
        created
  - [ ] Tampered delegation proof: 400, `controller-mismatch`, Space not created
  - [ ] Optional-tier test: the three responses' `detail` strings are pairwise
        distinct (the differentiation SHOULD), asserting nothing about wording

Suite-side work (lands in `@interop/was-conformance-suite`, tracked here per
convention); discovered-from: WAS-8. The error registry folds all three
delegated Create Space verification failures into `controller-mismatch` as a
MUST, but the suite currently only exercises the basic signer-mismatch case -- a
server that 500s or 404-masks an expired delegation or a tampered proof would
pass today. All three shapes are black-box constructible because the suite mints
its own zcaps. The detail-differentiation SHOULD goes in the optional tier only,
as a wording-agnostic pairwise-distinctness check: `detail` is non-normative
free text, so asserting on phrasing (or requiring differentiation at all in the
normative tier) would over-constrain conforming servers. Note the distinctness
check is a signal, not proof -- per-request echo content (e.g. a request id) in
`detail` could mask an undifferentiated implementation.

---

## Test coverage gaps (conformance suite + server `test/`)

Produced by a 2026-07-22 coverage analysis: an inventory of the spec's 324
testable normative statements matched statement-by-statement against the
conformance suite's 95 tests (12 suites), plus a survey of the server's own
`test/` suite against `src/routes.ts` and `src/errors.ts`. Conformance
scoreboard: 111 covered / 50 partial / 155 uncovered / 8 not-suite-testable --
only 24% of MUST-family statements are fully covered. The suite is strong on
happy paths and read-side 404 masking, weak on _ordering_ requirements (authz
before conflict/validation checks) and request-integrity negatives. Working docs
(spec inventory, conformance inventory, full 205-item gap list with a suggested
test per gap, server test survey) are archived in `_spec/test-coverage/`.

Suite-side items land in `@interop/was-conformance-suite` (tracked here per
convention, like WAS-38); the `test/` items are in-repo.

### WAS-46: Un-skip the Postgres and flag-gated storage-contract tests

- status: todo
- priority: high
- labels: tests, backend
- acceptance:
  - [ ] The `hardQuota`/`exactUsage`-only contract tests (concurrent hard-quota,
        count-quota create serialization, count-bytes-once races) run against at
        least one backend in a default `pnpm test-node` run
  - [ ] The Postgres contract suite runs in CI (service container or equivalent)
        instead of collapsing to a single skip
  - [ ] When `WAS_TEST_DATABASE_URL` is unset the skip is loud about what was
        not run

The whole Postgres storage-contract suite is gated on `WAS_TEST_DATABASE_URL`
and silently collapses to one `it.skip` in a normal run. Worse, the contract
tests that only run when a backend advertises `hardQuota`/`exactUsage` then run
against _no_ backend at all, since the filesystem harness sets both flags false
-- the race-condition tests the flags exist for are dormant by default.

### WAS-47: Cover `start.ts` and the untested config parsers

- status: todo
- priority: medium
- labels: tests
- acceptance:
  - [ ] `parseCountLimit`/`normalizeCountLimit` and the three `MAX_*_PER_*` env
        vars tested, including invalid input; `loadConfigFromEnv` asserts those
        output fields
  - [ ] Error paths of `parseDatabaseUrl`/`parseEnabledBackends`/
        `parseOnboardingToken` covered (currently happy-path only)
  - [ ] `start.ts` behavior covered: backend selection by `DATABASE_URL`, the
        two startup warnings, and the exit-on-failure path (extracting testable
        pieces if needed)

`src/start.ts` currently has zero test coverage.

---

## Upstream Issues to Open

Two upstream issues at Digital Bazaar describing the AEAD gaps the `@interop`
forks of `minimal-cipher` and `edv-client` fixed on 2026-07-20 (extra
authenticated protected-header params, per-chunk stream AAD, authenticated
stream chunk count), so the fixes can be offered back rather than living only in
the forks. Draft issue text below, ready to paste (trim the fork references if
filing before the forks are published). The two issues reference each other as
companions.

### WAS-9: Open the upstream `minimal-cipher` AEAD-gap issue

- status: todo
- priority: medium
- labels: upstream, encryption
- acceptance:
  - [ ] Issue filed at `digitalbazaar/minimal-cipher` using the drafted text
        (fork references trimmed if filed before the forks publish)
  - [ ] Issue URL recorded back on this item

**`digitalbazaar/minimal-cipher` -- "Stream chunks share one AAD: reorder /
substitution within a stream is undetectable; support per-chunk AAD and
caller-supplied protected-header params"**

> In stream mode (`createEncryptStream`), every chunk is emitted as a JWE that
> shares the same content-encryption key and the same additional authenticated
> data -- the ASCII bytes of the one encoded protected header. Because neither
> the chunk index nor any per-chunk context is authenticated, a storage provider
> can reorder chunks within a stream, or substitute one of the stream's chunks
> for another, and `createDecryptStream` decrypts the result without error.
> (Cross-stream transplants are already blocked by the per-stream random CEK;
> truncation is a separate issue -- see the companion edv-client issue.)
>
> Proposal (implemented in the `@interop/minimal-cipher` fork; happy to send a
> PR): an opt-in `chunkedAad` option on
> `createEncryptStream`/`createEncryptTransformer` that (a) adds a version
> marker (`caad: 1`) to the protected header and (b) makes each chunk's AAD
> `encodedProtectedHeader || 0x2E || uint64-BE chunk index`. The decrypt
> transformer keeps a running index and switches AAD construction on the header
> marker, so legacy streams keep decrypting and tampered new streams fail the
> tag. This is the same move as Cryptomator's file-content scheme (AAD = chunk
> number || header nonce).
>
> Related enabler: `encrypt`/`encryptObject`/`createEncryptStream` could accept
> `additionalProtectedParams`, merged into the protected header (rejecting
> reserved members like `enc`), so callers can AEAD-bind application context --
> document id, key epoch, scheme version -- and detect ciphertext swapped
> between addresses by verifying the parsed header after decrypt.

### WAS-10: Open the upstream `edv-client` truncation issue

- status: todo
- priority: medium
- labels: upstream, encryption
- acceptance:
  - [ ] Issue filed at `digitalbazaar/edv-client` using the drafted text (fork
        references trimmed if filed before the forks publish)
  - [ ] Issue URL recorded back on this item

**`digitalbazaar/edv-client` -- "`getStream` trusts the cleartext
`doc.stream.chunks`: truncation of a chunked stream is undetectable"**

> On write, the document's `stream` state (`{ sequence, chunks }`) is sealed
> inside the JWE payload (`_encrypt` includes it in the encrypted object). But
> `decrypt()` rebuilds the returned doc as `{ ...encryptedDoc, content, meta }`,
> discarding the decrypted `stream` member and keeping the **cleartext envelope
> copy** -- and `getStream()` reads `doc.stream.chunks` from that
> unauthenticated copy to decide how many chunks to fetch. A malicious or
> compromised EDV server can lower the cleartext `chunks` (truncating the
> stream, e.g. cutting a file's tail off) and the read completes without error,
> even though an authenticated count exists inside the envelope.
>
> Fix (implemented in the `@interop/edv-client` fork; happy to send a PR): in
> `decrypt()`, when the decrypted payload carries a `stream` member, surface
> that authenticated value on the returned doc, falling back to the cleartext
> copy only for legacy documents whose payload has none. Related hardening:
> threading minimal-cipher's per-chunk AAD option (see the companion
> minimal-cipher issue) through `insert`/`update` closes within-stream chunk
> reorder/substitution as well.

---

## Someday / Maybe

Items with no current trigger: blocked on the spec, or on a deployment shape
nobody runs yet. Parked here so the active sections stay actionable.

### WAS-11: Space-level `/query`

- status: draft (spec-blocked)
- priority: low
- labels: query, spec-blocked
- acceptance: none yet -- the operation is reserved in the spec with nothing to
  implement

The _Collection_-level `POST .../query` is implemented (both the `changes` and
`blinded-index` profiles, now specified in the spec's Query Profile Registry
appendix). The Space-level `POST /space/{id}/query` remains _reserved_ in the
spec -- "Cross-collection queries (backend-specific)" -- with nothing to
implement yet.

The next three items are the deferred follow-ons from the RxDB sync plan (the
MVP -- tombstones, `changesSince`, the `changes` query profile, and the
freewallet browser adapter -- all shipped; the wire contract is normative in the
spec's Query Profile Registry appendix + Conditional Requests section).

### WAS-12: Live `pull.stream$` SSE endpoint for the changes feed

- status: todo
- priority: low
- labels: someday, sync
- acceptance:
  - [ ] An SSE endpoint emits `{ documents, checkpoint }` batches so clients
        need not poll
  - [ ] Filesystem backend implements it via poll-diffs; Postgres via
        `LISTEN/NOTIFY`

### WAS-13: Tombstone GC / retention policy

- status: todo
- priority: low
- labels: someday, sync
- acceptance:
  - [ ] A retention policy defines how long a tombstone outlives the slowest
        client
  - [ ] GC implemented per that policy (tombstones currently accumulate forever)

Interlocks with WAS-15: how long a tombstone must outlive the slowest client is
really "how far back the newest checkpoint reaches".

### WAS-14: Attachment / blob replication for sync

- status: todo
- priority: low
- labels: someday, sync
- acceptance:
  - [ ] A size/streaming design produced, tied to the chunked-streams and
        EDV-chunking work
  - [ ] Replication implemented per that design

### WAS-15: Client-produced snapshot/checkpoint entries in the changes feed

- status: todo
- priority: low
- labels: someday, sync, encryption
- acceptance:
  - [ ] A client-produced snapshot/checkpoint entry type in the changes feed
        supersedes earlier entries
  - [ ] Enables client-side compaction of encrypted Collections
  - [ ] Gives readers ciphertext rollback/freshness detection (a signed
        snapshot/manifest detects a server serving stale state)

(Keyhive item 3.) A ciphertext-only server cannot compact or snapshot an
encrypted Collection's history -- compaction must be a _client_ operation the
protocol accommodates, e.g. a client-produced snapshot/checkpoint entry type in
the changes feed that supersedes earlier entries. This is also the fix path for
ciphertext rollback/freshness (a signed snapshot/manifest lets a reader detect a
server serving stale state -- the gap Cryptomator leaves open after two audits,
per the hardening notes) and the compaction tier the linear `changesSince` feed
currently lacks. Interlocks with the tombstone-GC follow-on (WAS-13).

### WAS-36: Server-signed changes-feed checkpoints (split-view detection)

- status: todo
- priority: low
- labels: someday, sync, security
- blocked-by: WAS-7
- acceptance:
  - [ ] The server signs feed checkpoints ("as of feed version N, the head hash
        is X") with its server DID key, reusing the WAS-7 canonical
        serialization and referencing the DID log `versionId`
  - [ ] The signed checkpoint is available to sync clients (in `changesSince`
        responses and, once WAS-12 lands, SSE checkpoint batches)
  - [ ] Two clients comparing signed checkpoints for the same feed version can
        detect a split view (the server showing different histories to different
        clients); the comparison procedure is documented

Raised 2026-07-22 during the WAS-7 server-DID design discussion
(discovered-from: WAS-7). TLS authenticates what a client reads live, so a
server signature only adds value where the statement outlives the connection --
and a feed checkpoint is exactly that: a claim two clients can later _compare_.
Without signatures, a malicious or compromised server can serve different
histories to different sync clients (equivocation) undetectably; with them, any
two clients (or a client and an auditor) holding checkpoints for the same feed
version can catch the fork. Complements WAS-15, which covers the _client_-signed
direction (a reader detecting a server serving stale ciphertext); this item is
the server-attested direction. Interlocks with WAS-12 (the SSE `checkpoint`
batch is a natural carrier).

### WAS-16: Opaque/blinded Resource ids + padded sizes (opt-in)

- status: todo
- priority: low
- labels: someday, encryption, privacy
- acceptance:
  - [ ] Client-chosen opaque ids (deterministic AES-SIV name encryption as the
        lookup-preserving technique)
  - [ ] Padded / bucketed sizes
  - [ ] The remaining visible residue documented for the spec's server-knowledge
        section

(Keyhive lesson 5.) Even with EDV encryption the server sees structure: resource
ids, sizes, timestamps, access patterns. Treat further blinding as named, opt-in
work rather than an implicit property: client-chosen opaque ids (deterministic
AES-SIV name encryption -- Cryptomator's filename scheme -- is the concrete
lookup-preserving technique) and padded / bucketed sizes. The blinded-index
query profile already covers the _query_ axis; this item is the _namespace_
axis. Feeds the "server knowledge" spec section (WAS-31): whatever stays visible
should be listed there as a documented, deliberate residue.

### WAS-17: BYOS beyond My-Drive OAuth

- status: draft (parking record)
- priority: low
- labels: someday, gdrive-byos
- acceptance: none yet -- recorded so the v1 adapter doesn't foreclose these;
  revisit only on demand

Deferred alternatives from the Google Drive BYOS plan: (a) _Shared Drive
support_ -- deliberately deferred; org-owned storage undercuts the BYOS trust
model (admin can delete/transfer/lock, and org members with drive access can
read plaintext bytes directly, bypassing WAS zcaps), and the API surface changes
(`supportsAllDrives`, `corpora=drive`, per-file `capabilities`); revisit only on
demand. (b) _Service account with domain-wide delegation_ -- an admin-driven
registration flow for org rollouts, replacing per-user OAuth. (c) _Other
providers_ -- the `provider`-keyed adapter + OAuth registration generalizes to
Dropbox / OneDrive / S3-compatible; Google Drive is the first concrete
`external` provider, not a special case.

### WAS-18: Publish the StorageBackend port for npm-installable backends

- status: todo
- priority: low
- labels: someday, backend
- acceptance:
  - [ ] The port published outside the server (`StorageBackend` + supporting
        types out of `src/types.ts`, into `@interop/storage-core` or its own
        package)
  - [ ] A resolution convention (e.g. `WAS_BACKEND=@scope/backend-postgres`
        dynamically imported in `start.ts`, plugins exporting a
        `createBackend(config)` factory)
  - [ ] A port-level conformance kit plugin authors can self-certify against

The remaining plugin-seam work from the backend-considerations comparison. The
port is proven by two divergent adapters; what's missing to let a third party
ship one: (1) _publish the port_ -- `StorageBackend` and its supporting types
still live in `src/types.ts`, so an external backend cannot
`implements StorageBackend` without depending on the whole server; (2) _a
resolution convention_ -- distinct from `WAS_ENABLED_BACKENDS`, which allowlists
registered _external_ backends, not the server's own adapter; (3) _a port-level
conformance kit_ -- a reusable suite running the port contract against any
backend (the protocol-level `was-conformance-suite` tests the HTTP surface, not
the port; the in-repo `test/` suites, which already run against an injected
backend, are the seed). Open scoping question: ship the three together or
piecemeal.

### WAS-19: SQLite backend

- status: todo
- priority: low
- labels: someday, backend
- acceptance:
  - [ ] A `node:sqlite`-based backend implements the port and passes the `test/`
        and conformance suites
  - [ ] JSON1 + generated-column indexes back the equality profile

The strongest candidate for a _next_ server-managed tier per the
backend-considerations comparison: embedded-but-queryable and still inspectable
(JSON1 + generated-column indexes, FTS5, `sqlite-vec`, one file a learner can
open with the ubiquitous `sqlite3` CLI), with `node:sqlite` shipping in Node 24.
LMDB is effectively superseded (port already proven twice, misaligned with the
query roadmap, buffers blobs in RAM); FoundationDB stays a far-future hyperscale
note.

### WAS-20: Full-text / vector search query profiles

- status: todo
- priority: low
- labels: someday, query
- acceptance:
  - [ ] New `POST .../query` profiles + `features` tokens per the established
        pattern
  - [ ] Postgres implementation (`tsvector`/GIN and `pgvector`; FTS5 and
        `sqlite-vec` if the SQLite tier lands)
  - [ ] The byte-exact vs. normalized-projection interaction settled

The still-future axis of the query roadmap. Open design question: how it
interacts with the byte-exact vs. normalized-projection tension (the shipped
profiles keep stored bytes exact and index write-time projections; search would
ride the same path).

### WAS-21: Composite adapter

- status: todo
- priority: low
- labels: someday, backend
- acceptance:
  - [ ] One `StorageBackend` satisfied by several specialized stores, keeping
        the port single while the implementation spans stores
  - [ ] The behind-the-port vs. above-the-port composition decision recorded

One `StorageBackend` satisfied by several specialized stores (e.g. Postgres for
metadata + `jsonb` query, S3-style object storage as the streaming blob tier,
Redis as cache / vector index / live-notification layer). Open: whether the
composition lives behind the port or above it. (Different axis from BYOS
`managedBy: external`, which selects _whose_ storage a Collection lives on, not
how the server's own backend is composed.)

### WAS-22: External KEK custody behind `recordKekLoader`

- status: todo
- priority: low
- labels: someday, kms
- acceptance:
  - [ ] `recordKekLoader`'s return type widened to
        `RecordKek | Promise<RecordKek>` (the cheap first step)
  - [ ] An external custodian adapter (HSM / cloud KMS) with caching and a
        negative-cache policy for retired KEKs

Behind the existing `recordKekLoader()` seam. The KEK is process-resident today,
so at-rest encryption defends against a disk dump and nothing more; an external
custodian narrows that -- the process holds a handle rather than the key, and
unwrap operations become auditable and revocable at the custodian. First cheap
step, worth doing before any adapter exists: widen the loader's return type,
since an external custodian needs an async loader (network fetch, with caching
and a negative-cache policy for retired KEKs).

### WAS-23: Sub-path-mounted `SERVER_URL` drops its base path in built URLs

- status: todo
- priority: low
- labels: someday, bug
- acceptance:
  - [ ] A `serverUrl`-rooted join helper preserves the base path at all join
        sites (`Location` headers and ZCap target derivation)
  - [ ] A sub-path `SERVER_URL` test fixture passes

Every absolute-URL join goes through `new URL(<leading-slash path>, serverUrl)`,
and `new URL('/space/x', 'https://host/was')` resolves to `https://host/space/x`
-- the `/was` base path is dropped. This affects both the `Location` response
headers (`CollectionRequest.post`, `SpaceRequest`, `BackendRequest`,
`SpacesRepositoryRequest`) **and** the ZCap target derivation (`spaceContext.ts`
`allowedTarget`, `zcap.ts` `fullRequestUrl`), so a server deployed under a path
prefix would emit wrong `Location`s and reject every delegated write (the
client's `invocationTarget` includes the base path, so it would no longer match
-> 404). Origin-root deployments (the default) are unaffected, so this is low
priority. The path _builders_ in `src/lib/paths.ts` are correct (they return
relative paths); the fix belongs at the join sites -- a `serverUrl`-rooted join
helper that preserves the base path -- plus a sub-path `SERVER_URL` test
fixture. Because it touches the ZCap match path, treat it as its own change.
This is the server side of the same defect `was-client` fixed in its 2026-07
refactor (its finding #12).

### WAS-24: Server-enforced JSON Schema per Collection

- status: todo
- priority: low
- labels: someday, data-model
- acceptance:
  - [ ] An optional `schema` Collection property (a JSON Schema the server
        validates content writes against, rejecting non-conforming bodies)
  - [ ] Applied in the post-authorization write path; plaintext-JSON-only;
        mutually exclusive with `encryption`
  - [ ] Spec section (registry or Collection-property) drafted

The `equality` profile established the precedent and the code path for the
server parsing JSON Resource content at write time, as an explicit
per-Collection opt-in. A future optional `schema` Collection property would ride
the same hook: declared on the Collection Description, applied in the same
post-authorization write path, plaintext-JSON-only, mutually exclusive with
`encryption` for the same reason. Worth speccing as its own registry or
Collection-property section.

### WAS-25: Equality-index extensions

- status: todo
- priority: low
- labels: someday, query
- acceptance:
  - [ ] Compound indexes (e.g.
        `{ "names": ["parentId", "author"],     "unique": true }`) with zero
        changes to the query wire shape
  - [ ] `custom`-only indexes permitted on `encryption`-marked Collections, with
        a pointed privacy warning
  - [ ] Path-valued index names (JSON Pointer) for nested attributes

Follow-ons deliberately deferred from the v1 `equality` profile: (a) _compound
indexes_ -- a declaration form for efficient conjunction lookup and composite
uniqueness claims (an `equals` element with multiple pairs is already a compound
query); (b) _custom-sourced indexes on encrypted Collections_ -- tags on
encrypted photos, since `custom` metadata is server-visible plaintext
regardless; (c) _path-valued index names_ -- extending the `name` grammar to
JSON Pointer for nested attributes.

---

## Reverse gaps (server features the spec does not yet describe)

Spec-side follow-ups noticed during the comparison; tracked here so the two
documents converge. All of these are edits to `spec.md` in the
[w3c-ccg/wallet-attached-storage-spec](https://github.com/w3c-ccg/wallet-attached-storage-spec)
repo, not server code.

### WAS-26: Spec the Import operation

- status: todo
- priority: medium
- labels: spec-side
- acceptance:
  - [ ] An Import operation is defined in the spec
  - [ ] `import` added to the Reserved Path Segment Registry
  - [ ] The `invalid-import` error type is no longer orphaned

`POST /space/{id}/import` is implemented (tar merge with FEP-6fcd manifest,
`ImportStats` summary, `invalid-import` errors) but the spec defines no Import
operation, and `import` is not in the Reserved Path Segment Registry (the
`invalid-import` error type is registered, orphaned).

If WAS-37 proceeds, this operation thins out to profile-plus-reference: the
accepted container format moves to the container spec, and the WAS spec keeps
the HTTP operation, the WAS profile, and the import-specific semantics (merge
behavior, `ImportStats`, provenance verification outcomes).

### WAS-27: Spec the zcap revocation operation

- status: todo
- priority: medium
- labels: spec-side
- acceptance:
  - [ ] The spec adopts (or replaces) the `/zcaps/revocations/` convention as a
        defined revocation operation

ZCap revocation is presupposed but never specified: the spec calls the
authorization profile "delegatable, revocable, secure, flexible" and its
`controller-mismatch` privacy note names "capability revocation status" as
provider-defined state, yet defines no revocation operation. The server follows
the ezcap-express `/zcaps/revocations/` convention
(`POST /space/{space_id}/zcaps/revocations/{revocation_id}`), which the spec
should either adopt or replace.

### WAS-28: Spec the Export operation

- status: todo
- priority: medium
- labels: spec-side
- acceptance:
  - [ ] Export format, manifest, and response shape documented (the server's
        tar + manifest format is the de facto definition)
  - [ ] Chunk entries described backend-neutrally in the export manifest
        (index/contentType/version)

Export has no detailed spec section (format, manifest, response shape) -- the
API summary and the Reserved Path Segment Registry both still mark
`POST /space/{space_id}/export` "Reserved / not yet specified". When specifying
it, also describe chunk entries neutrally in the export manifest: today the
archive chunk layout is the filesystem backend's on-disk encoding
(`chunkDirName` + `fileNameFor` + `.meta.<n>.json` sidecars), which the Postgres
export synthesizes and any non-filesystem backend must emulate to interoperate.

If WAS-37 proceeds, this operation thins out to profile-plus-reference: the
container format (layout, manifest, provenance envelope) moves to the container
spec, and the WAS spec keeps the HTTP operation plus the WAS profile
(space/collection structure, reserved sidecar names, chunk layout). The
chunk-neutrality acceptance item above is really a container-spec requirement.

### WAS-37: Reusable signed-container spec for exports (WAS + wallet backups)

- status: draft
- priority: low
- labels: spec-side

Raised 2026-07-22, while resolving WAS-7's spec-status question
(discovered-from: WAS-7). Draft because the actionable scope depends on two
decisions not yet made: whether to raise it as a CCG work item, and whether
wallet implementations (Freewallet, DCW) commit to consuming it -- without that
buy-in, a WAS-spec appendix delivers everything except the reuse.

_The idea._ The artifact WAS-7 defines is a container, not protocol: "a set of
items + metadata sidecars + a completeness manifest + signed provenance by the
exporting party." Nothing in it requires WAS -- and it is exactly the shape of a
wallet backup. A separate spec would own the archive layout conventions, the
FEP-6fcd-style manifest, the metadata sidecar model, and the provenance
envelope + verification procedure (verified / unverified / content-mismatch
semantics). The attester is just "a DID": a WAS server's `did:webvh` for WAS
exports, the wallet's own DID for a wallet export -- WAS-7's
signing-time-agnostic envelope (no export- or WAS-specific context in the signed
bytes) is precisely what makes that generalization possible. The
embedded-DID-log-snapshot offline-verification feature becomes an optional
capability for DID methods with logs (`did:webvh`), plain DID resolution the
fallback (a wallet on `did:key` simply gets no key history).

_Layering._ (1) Core container spec, as above. (2) WAS profile: space/collection
structure, reserved names, chunk layout, and the Export/Import HTTP operations
(WAS-26/WAS-28 thin out to profile-plus-reference). (3) Wallet profile(s),
later, mapping Freewallet/DCW items.

_Scope discipline._ Container encryption is OUT of scope for the core: wallet
backups need at-rest passphrase protection, WAS exports do not (their contents
may already be EDV ciphertext), and a wrapping layer (e.g. JWE around the whole
archive) is orthogonal. Say so early or the wallet use case will drag it in.

_Sequencing._ Implementation-first: WAS-7 ships against the de facto server
format and this spec is extracted from it -- WAS-7 must NOT acquire a dependency
on a CCG work-item lifecycle. Design-phase checks: the Keyhive "concap" envelope
comparison (moved here from WAS-7), and a WAS-neutral name (something in the
vein of "verifiable content archive" -- "space contents export" undersells the
reuse).

Promotion to `todo` requires: the CCG-work-item decision, at least one wallet
consumer signal, and acceptance criteria for the core spec's section list.

### WAS-29: Spec the key-epochs surface (`epoch` feed member, marker/stamp rails)

- status: todo
- priority: medium
- labels: spec-side, encryption
- acceptance:
  - [ ] The optional `epoch` member added to the `changes` profile registry
        entry (or `key-epochs` documented as an extension)
  - [ ] The marker/stamp surface (`encryption.epochs` / `currentEpoch` rails,
        `WAS-Key-Epoch` Resource stamp) covered

The `changes` profile's registry entry omits the `epoch` member the server emits
on feed documents (the `key-epochs` stamp, carried so a replicating reader picks
the right epoch key without a `/meta` fetch per Resource) -- and more broadly
the served key-epochs surface is unspecified: the EDV-over-WAS appendix
currently declares epoch bookkeeping deliberately client-side.

### WAS-30: Layered-revocation security-considerations text

- status: todo
- priority: low
- labels: spec-side
- acceptance:
  - [ ] The two-layer revocation model stated explicitly (authorization
        revocation vs. cryptographic revocation via epoch rotation)
  - [ ] The trust model owned: the server is the revocation checkpoint; offline
        / pure-P2P operation out of scope, Keyhive cited as contrast

(Keyhive item 4.) The spec should state the two-layer revocation model
explicitly: revoking a delegated zcap is _authorization_ revocation -- immediate
and total at the server checkpoint -- while _cryptographic_ revocation for
encrypted Collections additionally requires rotating the key epoch, because a
revoked reader still holds the old epoch key and can decrypt anything already
pulled (the server ships both halves: zcap revocation and key epochs). The same
section should own the trust model: WAS deliberately verifies against one
authoritative chain at request time, so the server _is_ the revocation
checkpoint and offline / pure-P2P operation is out of scope -- an architectural
advantage over coordination-free designs (cite Keyhive as the contrast). Pairs
with the epochsMac item (WAS-34).

### WAS-31: Server-knowledge section for encrypted Collections

- status: todo
- priority: low
- labels: spec-side, encryption
- acceptance:
  - [ ] Plaintext residue enumerated (resource ids, sizes, timestamps,
        `createdBy`, epoch ids and recipient `kid`s, changes-feed metadata,
        access patterns)
  - [ ] Tamper-detectable vs. explicitly-accepted risks split out, Cryptomator
        security-target style

(Keyhive item 1.) The planned "server knowledge" section for encrypted
Collections should follow the Cryptomator threat-model documentation style:
plainly enumerate what stays plaintext, what tampering is client-detectable
(per-object AEAD), and what is an explicitly accepted risk (ciphertext rollback,
listing truncation, plaintext-metadata forgery). Their security-target page is
the template.

### WAS-32: Spec the `was` envelope-binding protected-header parameter

- status: todo
- priority: medium
- labels: spec-side, encryption
- acceptance:
  - [ ] The private JWE protected-header member `was: { v, resource?, epoch? }`
        specified in the EDV-over-WAS appendix
  - [ ] The rules carried into the text: `resource` omitted for content-derived
        ids, pre-binding vintage accepted, `v` greater than supported is a
        refusal
  - [ ] The metadata (`custom`) envelope's `{ v, resource }` binding covered

Shipped in the client stack, 2026-07-20. Writers now emit and readers verify
this member -- the scheme version, the resource id the envelope was written
under, and the key-epoch id, all AEAD-covered by the JWE, so a server-side
envelope swap between ids, an epoch relabel, or a per-envelope scheme downgrade
fails on decrypt.

### WAS-33: Spec the `encryption.version` marker member

- status: todo
- priority: medium
- labels: spec-side, encryption
- acceptance:
  - [ ] The Encryption Scheme Registry gains a scheme-version column
  - [ ] Migration guidance written: only key-wrap material is rewritten, never
        ciphertext bodies (the rewrap path), with the cached-CEK caveat
  - [ ] The never-backwards rail documented (once set, never decreases, never
        removed)

The server now validates an optional positive-integer `version` on the
`encryption` marker and enforces that, once set, it never decreases and is never
removed (the same never-backwards rail as `currentEpoch`); clients stamp
`version: 1` when declaring epochs. The per-resource-CEK-under-epoch-key layout
means moving a Resource to a new epoch only rewraps the JWE `recipients` --
which suggests a future client-driven bulk **rewrap** operation as a cheap
post-removal migration (honest caveat: rewrapping does not help against a reader
that cached the CEKs themselves).

### WAS-51: Reconcile the `encryption.version` marker text with the implementation

- status: todo
- priority: medium
- labels: spec-side, encryption
- acceptance:
  - [ ] The Collection Data Model marker definition and the implementation agree
        on `version`'s type and optionality (spec today: a required string, e.g.
        `"0.1"`; server: an optional positive integer)
  - [ ] The error surface for a version transition is reconciled: the spec today
        folds any `version` change or removal into 409 `encryption-immutable`,
        while the server allows increases (a future scheme migration) and
        rejects decreases/removals with 400 `invalid-request-body`
        (`#/encryption/version`) -- amend one side and update the error-registry
        row to match
  - [ ] Conformance coverage for the reconciled version-transition behavior
        added (deliberately left out of WAS-43 because of this divergence)

Discovered while implementing WAS-43 (discovered-from: WAS-43). Touches the same
marker text WAS-33 extends (the scheme-version registry column and the
never-backwards rail), so the two should land as one spec edit.

### WAS-53: Reconcile chunk-capability exact-match text with target attenuation

- status: draft
- priority: medium
- labels: spec-side, authorization

Discovered while writing the chunked-resources conformance suite
(discovered-from: WAS-45). The spec's Chunk Authorization text says a
chunk-write capability's `invocationTarget` MUST be the chunk's own full URL
under "the same exact-match target rule that governs every WAS URL" -- but the
server deliberately verifies chunk (and other descendant) writes with
space-rooted RESTful target attenuation (`attenuatedRootTarget`), so a
capability scoped to the Space, Collection, or parent Resource authorizes a
descendant chunk write. One side has to move: either the spec's authorization
profile describes attenuation (an ancestor-scoped capability covers descendant
paths) and the chunk text inherits it, or the server enforces exact-match on
chunk URLs and breaks ancestor-cap workflows. Draft until the spec decision is
made; the conformance suite meanwhile covers the URL-binding MUST with a
non-ancestor (sibling-chunk) probe, which both readings reject.

### WAS-34: Spec the `epochsMac` authenticated epoch configuration

- status: todo
- priority: medium
- labels: spec-side, encryption
- acceptance:
  - [ ] The marker member `epochsMac: { v: 1, alg: "HS256", mac }` and its
        MAC/HKDF construction defined
  - [ ] The whole-config replay limitation owned in the text

Shipped in the client stack, 2026-07-20; the server stores it opaquely. The spec
should define: an HMAC-SHA256 over
`"was-epoch-config/v1." + JSON.stringify({ scheme, version, currentEpoch, epochs })`
(epoch ids in marker order, `version` null when absent), keyed via HKDF-SHA256
from the current epoch's 32-byte secret with info `"was-epoch-config-mac/v1"` --
a key the server never holds. Writers verify it before encrypting, so a server
that points `currentEpoch` back at an epoch a revoked reader still holds fails
to authenticate. The text must also own the limitation: a replay of an _entire_
old consistent configuration (old list plus its old MAC) is only detectable with
client-side monotonic state, out of scope for the marker itself. Pairs with the
layered-revocation item (WAS-30).

### WAS-35: Spec the chunked-stream encryption profile (`caad`)

- status: todo
- priority: medium
- labels: spec-side, encryption
- acceptance:
  - [ ] The `caad: 1` AAD construction adopted in the EDV-over-WAS chunked
        profile (encoded header || `0x2E` || uint64-BE chunk index)
  - [ ] Sealed stream state (`{ sequence, chunks }`) inside the document
        envelope, so truncation is detected from authenticated state
  - [ ] Legacy streams stay readable; readers-before-writers deployment note
        included

Shipped in the client stack, 2026-07-20; chunks stay opaque to the server. The
profile should adopt what stream writes now produce by default: per-chunk AAD
defeating within-Resource chunk reordering and substitution (the per-stream
random CEK already blocks cross-Resource transplants), and the stream state
sealed inside the document envelope so readers take the chunk count from
authenticated state. Legacy streams without the `caad` member remain readable;
readers must be upgraded before writers when deploying.
