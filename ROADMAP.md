# WAS Teaching Server Roadmap (spec gap analysis)

nextAvailableId: 148

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

This document tracks only the **remaining** gaps; completed items move verbatim
to [archived-roadmap.md](archived-roadmap.md) as they land, so WAS-N references
keep resolving (the shipped feature set is recorded in CHANGELOG.md; items
completed before the archive existed live only in git history). The server
implements the whole core protocol surface -- CRUD at all three levels, listings
with cursor pagination, policies, linksets, quotas/backends reads, metadata,
export/import, conditional writes, key epochs, both `POST .../query` profiles,
chunk addressing, zcap revocation, and the full error-type registry.

## Item format

Each work item is a `### WAS-N: Title` heading followed by a field block and
free prose context. Ids are permanent and never reused. The `nextAvailableId`
line at the top of this file is the next id to take: filing an item takes that
number and rewrites the line to one higher, in the same edit. Never derive the
next id by scanning, since the highest id usually sits in `archived-roadmap.md`
rather than here. Statuses: `todo`, `in-progress`, `draft` (no actionable
done-state yet -- spec-blocked or a parking record); `done` items move to
[archived-roadmap.md](archived-roadmap.md) once shipped (CHANGELOG.md remains
the record of what landed). Full conventions live in [AGENTS.md](AGENTS.md)
under "Roadmap & Task Conventions".

---

## Backends: external (BYOS) + encryption feature

Designed in detail in the Google Drive BYOS plan (a Google Drive
`managedBy: external` "Bring Your Own Storage" backend, plaintext and
EDV-encrypted, with encryption as a backend **feature**). That plan's staged
work plan is the authoritative sequencing; stages 1-3 have fully shipped (the
EDV-over-WAS client profile, registration + the per-Collection resolver, and all
four EDV server affordances). The spec has since removed the `features`
vocabulary that plan advertised those affordances through, and so has this
server (WAS-111); the affordances themselves are unchanged. Remaining, in order:

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
operations to a separate reusable **container spec** (WASS-25 in the spec
roadmap, draft) that owns the envelope format, manifest, and verification
procedure. The Keyhive "concap" format check moves to WASS-25's design phase.
Implementation does not wait on either: WAS-7 ships against the de facto format,
and the spec text is extracted from it (this repo's existing pattern).

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
  multi-recipient collections; with `epochsMac` retired (client 0.32.0), epoch
  configuration is bound by log-chain verification, and a server signature would
  additionally make the freshness claim third-party- and offline-verifiable.
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

### WAS-59: Enforce the reserved-path authorization classes (bounded target attenuation)

- status: todo
- priority: high
- labels: security, zcap, authorization
- touches:
  - wallet-attached-storage-spec: WASS-1 in that repo's ROADMAP.md defines the
    classes (the "Target Attenuation and Contained Data" subsection and the
    `Authorization` column on the Reserved Path Segment Registry); this item is
    the enforcement half and follows the spec text
  - was-teaching-server: `src/requests/spaceContext.ts` (the
    `attenuatedRootTarget` it hands every space-family route), `src/zcap.ts`,
    `src/authorize.ts`, AGENTS.md
  - conformance-suite: negative-path assertions per class (a Space- or
    Collection-scoped capability invoked at an exact-target or controller-only
    reserved endpoint beneath it is denied with the maximum-privacy 404)
- acceptance:
  - [ ] A capability whose `invocationTarget` is a Space or Collection URL
        authorizes requests at contained data paths beneath it and at reserved
        endpoints classed "inherits prefix authority" (`query`, `linkset` GET,
        `quota`/`quotas` GET, resource-level `meta`), and nothing else beneath
        it
  - [ ] "Exact-target required" endpoints (`policy` at all levels, `collections`
        for create) accept only a capability whose `invocationTarget` is that
        endpoint's own URL; a chain attenuating from an ancestor is refused
  - [ ] "Controller-only" endpoints (`import`, unsafe methods on `backends`, and
        `export` once WASS-1 decides it) accept only direct root-capability
        invocation by the Space controller
  - [ ] Delegation-time attenuation is unchanged: this bounds only which request
        URLs a given `invocationTarget` covers at invocation time
  - [ ] Server `test/` coverage per class, plus the conformance assertions above

Split out of wallet-attached-storage-spec WASS-1 (2026-08-20), which keeps the
spec half; freewallet FW-39 carries the full rationale (the zcap core spec makes
invocation-time prefix attenuation conditional on the target API supplying a
permission statement, which WASS-1 supplies). Today every space-family route
passes `attenuatedRootTarget: context.spaceRootTarget` into the verifier, so a
Space-scoped delegated capability reaches every reserved endpoint beneath the
Space, `policy` included, exactly as it reaches data paths. The "inherits" class
is load-bearing and must keep working: freewallet's replication invokes
`<collection>/query` and resource `meta` under a collection-scoped grant.

### WAS-108: Container rule for the policy and backend-registration writes

- status: todo
- priority: medium
- labels: authz, zcap
- touches:
  - was-teaching-server: ARCHITECTURE.md's container-rule paragraph
  - wallet-attached-storage-spec: whether the access-control section needs text
    here -- to be assessed
- acceptance:
  - [ ] `PUT /space/:spaceId/policy` (Update Policy,
        `src/requests/PolicyRequest.ts`) and
        `POST`/`PUT`/`DELETE /space/:spaceId/backends[/:backendId]` (backend
        registration, `src/requests/BackendRequest.ts`) carry a container rule
        (decide which: `controller-only` is the natural one)
  - [ ] Tests in `test/` assert a delegated capability targeting the
        trailing-slash Space URL with the full WAS verb set is refused at each,
        and a direct root invocation still succeeds
  - [ ] ARCHITECTURE.md's container-rule paragraph lists them

Today these handlers call `fetchSpaceAndVerify` with no `containerRule`, so a
wallet's generation delegation on `/space/<S>/` reaches them by the same
`/`-boundary prefix attenuation the container rule was added to bound: it can
rewrite the Space's access-control policy, or register or replace a backend
record carrying secrets. Discovered during code review of the container rule
(discovered-from: WAS-60). Not changed in that work because it widens the rule
to operations outside the container URLs the spec discusses; it needs a decision
on whether a Space-subtree grant should ever manage policy or backends.

Note 2026-09-17: the whole-codebase review confirmed both exposures against a
live server (a Collection data grant wrote `PublicCanRead` at `.../policy`, 201;
a Space-subtree grant reached `PUT` and `DELETE` on `/backends/:id`). The same
prefix hazard reaches the Space revocation endpoint (WAS-129) and Update
Keystore (WAS-115).

### WAS-61: Separate `/policy` control from data writes (exposure test + enforcement)

- status: todo
- priority: high
- labels: security, consent, zcap, authorization
- touches:
  - wallet-attached-storage-spec: WASS-3 in that repo's ROADMAP.md specifies the
    `/policy` CRUD operations and assigns them the exact-target-required class
    from WASS-1; this item is the enforcement half and follows the spec text
  - was-teaching-server: `src/requests/PolicyRequest.ts` (all three levels),
    `src/requests/spaceContext.ts`, `test/policy.test.ts`, AGENTS.md
  - conformance-suite: negative-path assertions (a Space- or Collection-scoped
    delegated capability carrying `PUT`/`DELETE` invoked at a `/policy` endpoint
    beneath it is denied with the maximum-privacy 404) and a positive assertion
    for an exact-target `/policy` delegation
- acceptance:
  - [ ] Confirm-first exposure test in `test/policy.test.ts`: a delegated zcap
        on `<collection>` carrying `PUT`, invoked at `<collection>/policy`,
        currently verifies (by code reading it does: `PolicyRequest` goes
        through `fetchSpaceAndVerify`, which accepts a chain attenuating from
        the Space root). The test lands first, red, and documents the exposure
  - [ ] `/policy` at all three levels accepts only a capability whose
        `invocationTarget` is that `/policy` URL itself, or direct root
        invocation by the controller; a container-prefix grant never reaches it
        (the exact-target class of WAS-59)
  - [ ] The exposure test flips green; server `test/` covers the refused and
        permitted cases at each level, plus the conformance assertions above
  - [ ] `RESERVED_COLLECTION_IDS` / `RESERVED_RESOURCE_IDS` in
        `src/lib/validateId.ts` already reserve `policy`; the drift-guard test
        keeps them aligned with the spec's naming rule once WASS-3 states it

Split out of wallet-attached-storage-spec WASS-3 (2026-08-20), which keeps the
spec half; freewallet FW-41 carries the consent rationale ("make this collection
publicly readable" must appear on a consent screen in those words, and must not
be implied by a verb list). Without this item every collection write grant
silently includes the power to flip that collection public. Sequence after
WAS-59, whose exact-target class this rides on.

Note 2026-09-17: the exposure test's premise is confirmed (a delegated data
grant on the Collection wrote `PublicCanRead` and an anonymous read of the
Collection's Resource then answered 200). The other half of policy hygiene, a
Resource-level policy surviving the Resource's deletion, is WAS-127.

### WAS-58: Aggregate quota reporting across an account's auxiliary Spaces

- status: todo
- priority: medium
- labels: server, quotas, webvh
- acceptance:
  - [ ] Decide the aggregation payload shape and direction with Dmitri
        (wire-level)
  - [ ] Implement the decided shape, with server `test/` coverage and
        conformance tests where the payload is spec-facing

Typed auxiliary Spaces (see the wallet-attached-storage-spec decision record
`decisions/0001-typed-auxiliary-spaces.md`) split an account's data across the
account Space and its auxiliary annex Space. `GET /space/{spaceId}/quotas`
reports per-Space only, so neither number is the account's usage on its own.

Two questions are deliberately open. The direction: does a query on the account
Space fold in its auxiliary Spaces, or does a client sum the Spaces it knows
about? The payload: fold the auxiliary usage into `usageBytes`, or report a
per-Space breakdown in a new member (which would need an addition to
`@interop/storage-core`'s quota types). Both are permanent wire choices and need
deciding with Dmitri before implementation.

### WAS-66: Accept ids beyond the unreserved charset (percent-encoding on disk, real webvh round-trip)

- status: todo
- priority: medium
- labels: data-model, backend, webvh
- touches:
  - was-teaching-server: `src/lib/validateId.ts` (the charset gate),
    `src/backends/*` (on-disk segment encoding, glob escaping, sidecar and
    archive entry names), `src/lib/validateDid.ts` (`parseSelfHostedWebvh`
    round-trip), `src/lib/importTar.ts`, ARCHITECTURE.md Glossary (the
    self-hosted `did:webvh` entry leans on the identity shortcut)
  - was-client: stop pre-rejecting (or mirroring) the unreserved-only rule;
    confirm every path builder `encodeURIComponent`s segments consistently
  - was-conformance-suite: create/read/list/delete cases for ids containing
    reserved and non-ASCII characters, plus export/import round-trip
- acceptance:
  - [ ] The id validators accept any single decoded path segment: non-empty, not
        `.` or `..`, containing no `/` (the spec's only syntax rule) and no `\`;
        the unreserved-only pattern is gone from the accept path
  - [ ] The filesystem backend maps ids to on-disk names through an injective,
        path- and glob-safe segment encoding; the encoding choice (and any
        change to export tar entry names, which are a wire artifact) gets
        maintainer sign-off before coding
  - [ ] Derived on-disk names (`.meta.<id>.json` sidecars, `.space.` /
        `.collection.` description files, chunk directories) and every glob the
        backend builds use the encoded form; a hostile id can no longer reach a
        glob metacharacter or path separator
  - [ ] Export/import round-trips such ids; `importTar.ts` validates the decoded
        id, and the reserved-path-segment registry is compared against the
        decoded id
  - [ ] `parseSelfHostedWebvh` replaces the identity shortcut with a real
        encode/decode round-trip check: a Collection id that survives the DID
        path encoding hosts a resolvable log; one that cannot round-trip (e.g.
        it decodes ambiguously) is refused as a log host without affecting its
        validity as a Collection
  - [ ] Server `test/` coverage for hostile ids (traversal, glob, `%`-tricks,
        non-ASCII) on both accept and storage paths, plus the conformance cases
        above

Raised 2026-08-21 by a was-client integration failure: the client
`encodeURIComponent`s each path segment, but this server validates the decoded
id against the unreserved-only pattern and 400s anything else. The spec puts no
syntax requirement on ids beyond "no `/`", so the restriction is this server's
own: ids flow into filesystem paths and glob patterns, and constraining the
charset was cheaper than encoding on disk. The restriction has since become
load-bearing for self-hosted `did:webvh` controllers -- `parseSelfHostedWebvh`
relies on "unreserved characters are never percent-encoded" to collapse the DID
path round-trip rule to the same check. Relaxing the charset therefore means two
coupled changes: an on-disk segment encoding in the storage layer, and a genuine
round-trip check in the webvh parser. Watch the platform edge cases the old
charset ruled out for free: case-insensitive filesystems (two ids differing only
by case), Windows reserved names, and Unicode normalization (two byte sequences
rendering identically) may each need an explicit stance.

### WAS-68: Import trusts the tarball's Collection Description `id`

- status: todo
- priority: medium
- labels: data-model, import, validation
- acceptance:
  - [ ] An imported Collection Description whose `id` is absent, or names a
        collection other than the one its tar path places it in, is either
        rejected or normalized to the path-derived id
  - [ ] Whichever is chosen, it matches what the three write handlers already do
        (they set `id` from the URL segment unconditionally)
  - [ ] A test imports a hand-crafted tar carrying both shapes

Every other write path to a Collection Description sets `id` from the URL
segment, so a client can neither omit it nor choose it: `CollectionRequest` does
it on create and update (`src/requests/CollectionRequest.ts:357`, `:373`), and
the POST-to-space handler does the same
(`src/requests/SpaceRequest.ts:442-443`). A body whose `id` disagrees with the
URL is refused as `invalid-request-body`.

Import is the exception. It parses the Collection Description out of the tarball
verbatim -- `JSON.parse(metaEntry.body.toString('utf8'))` at
`src/lib/importTar.ts:376-380` -- and synthesizes
`{ id: collectionId, type, name }` only when the tar carries no description
entry at all. So a hand-crafted tar can plant a Collection Description whose
`id` is missing, or whose `id` names a different collection than the tar path it
is stored under. Neither shape is reachable through any other route, and nothing
downstream re-derives the id.

Space Descriptions are not affected: import merges into a pre-existing Space and
never rewrites its description.

Discovered 2026-08-28 while confirming, for a was-client change, that `id` is
guaranteed present in a served Description. It is -- through the handlers.
Import is the one path that does not enforce it, which makes the guarantee
weaker than the handlers suggest. The consumer side now depends on it:
was-client 0.45.0's `ensureSpaceAndCollection` refuses a caller-supplied Space
description whose `id` does not name the Space being provisioned.

## Public collection serving (agent storage demo next steps, 2026-08-21)

Context: freewallet's agent storage demo (FW-227) has a CLI agent publish
`index.html` into a `PublicCanRead` collection. Nothing here is required for the
MVP: the server already stores and streams a resource under its own content type
(`ResourceRequest.ts`, `reply.type(storedResourceType)`), so
`GET /space/{s}/web/index.html` renders in a browser. The demo's write grant
also reaches `<collection>/policy` today; WAS-59, WAS-60, and WAS-61 are the
hardening items the demo depends on and stay where they are.

### WAS-64: Default document for public collections (`index.html`)

- status: todo
- priority: medium
- labels: spec-side, policy, serving
- touches:
  - wallet-attached-storage-spec -- which URL serves the default document and
    how it interacts with the JSON listing is a spec decision; the server
    implements the decided text
- acceptance:
  - [ ] Decide, in the spec, the URL and precedence: whether the collection URL
        (`.../{collectionId}` and/or `.../{collectionId}/`) serves a resource
        named `index.html` when present and the collection is `PublicCanRead`,
        and how a client still reaches the JSON item listing (content
        negotiation, a query parameter, or the listing staying on the bare URL
        with the trailing-slash form serving the document)
  - [ ] Server implements the decided rule for public collections only; an
        authenticated listing keeps working unchanged
  - [ ] Conformance or server tests cover: document present, absent, collection
        not public, and the listing path

Relative links inside the page already resolve to sibling single-segment
resource ids in the same collection (no path nesting), which is enough for a
flat site; nested directories are out of scope here.

### WAS-65: Response hardening on public resource serving (helmet, CSP, nosniff)

- status: todo
- priority: medium
- labels: security, serving
- acceptance:
  - [ ] `fastify-helmet` (the `TODO` in `src/server.ts`) or an equivalent header
        set on resource responses: `X-Content-Type-Options: nosniff` at minimum
  - [ ] A decided `Content-Security-Policy` for world-readable resources: a
        public HTML resource is same-origin script on the WAS host and CORS is
        `*`, so the policy must bound what such a page can do against the host
        while still letting a plain page with inline styles render (the demo
        page must keep working; document the tradeoff)
  - [ ] Tests assert the headers on a public `text/html` GET and that the
        existing JSON API responses are unaffected

Note 2026-09-17: the CORS proxy relays an upstream `text/html` on the same
origin with none of these headers either; that half is WAS-124.

### WAS-69: Drop `Ed25519Signature2020` from the delegation-proof verify side

- status: draft
- priority: low
- labels: zcap, authorization, cleanup
- discovered-from: the 2026-08-29 move of delegation proofs to `eddsa-jcs-2022`
  (freewallet FW-395), whose server half accepts both suites
- touches:
  - `src/zcap.ts` -- `delegationProofSuites()` and its header comment
  - `test/delegation-suite-api.test.ts` -- the old-suite and mixed-chain cases
  - `ARCHITECTURE.md` -- the "ZCap Structure" signing paragraph
  - the conformance suite, whose helpers assert both suites are accepted

Draft rather than todo: the done-state is a condition on the deployed world, not
on this repo, so there is nothing to accept yet. Two things must both hold
before this becomes actionable. No client still signs delegation proofs with
`Ed25519Signature2020` -- which covers wallet-core, was-client and the apps on
them, dcw, and did-cli-typescript's `di was request-grant` agent path. And no
stored grant signed under the old suite is still submitted for re-verification:
a wallet records the full capability, proof included, on each login activity,
and revoking an app or an agent POSTs that recorded capability back. Dropping
the suite while such a grant is on file reads to the user as a broken revoke
button rather than as a migration.

Promote this to `todo` when both hold, with acceptance criteria naming how each
was confirmed. Until then the cost of carrying the old suite is one extra suite
instance per verification, which only ever matches proofs of its own type.

### WAS-70: Keystore deletion (route, backend method, orphan GC)

- status: todo
- priority: medium
- labels: kms, backend, cleanup
- discovered-from: freewallet FW-400 design pass (2026-08-31), open question 3
- touches:
  - `src/routes.ts:423-466` -- `initKmsRoutes`, which has no `DELETE` route
    under `/kms`
  - `src/backends/postgres.ts:895-905` and `src/backends/filesystem.ts:889-900`
    -- `deleteSpace` deliberately leaves keystores untouched
  - `src/types.ts:1088-1124` -- the `StorageBackend` contract's keystore section
    states the protocol defines no keystore delete
  - `src/lib/webvhController.ts:213-237` -- why an orphaned keystore is
    permanently unauthenticatable, not merely undeleted
  - webkms-client -- a paired `KmsClient.deleteKeystore` method (in-house,
    tracked in that repo, blocked-by this route)
  - a later freewallet ceremony stage (out of scope here; lands as its own item
    once this route exists)
- acceptance:
  - [ ] `DELETE /kms/keystores/:keystoreId`, verified with
        `fetchKeystoreAndVerify({ allowedAction: 'write' })` against the stored
        config's `controller`
  - [ ] `StorageBackend.deleteKeystore` implemented on both backends, idempotent
        to match `deleteSpace`'s contract (absent keystore resolves rather than
        rejects)
  - [ ] A decision recorded on orphan-keystore GC, keyed on "the config's
        `controller` did:webvh no longer resolves" -- this also covers a torn
        account deletion and an account Space deleted before this route existed,
        not only the new route's own callers. The sweep that acts on that
        decision is WAS-73
  - [ ] webkms-client's `KmsClient.deleteKeystore` (tracked there)

Note 2026-08-31 (freewallet FW-400 v3): freewallet's deletion ceremony calls
this route in its keystore slot, ordered before the account-Space delete. Until
the route exists that slot is skipped and reported, so the ceremony ships
without it and gains it here.

A Space delete deliberately leaves its keystores alone (a sibling tree,
`postgres.ts:895-905`, `filesystem.ts:889-900`), there is no delete route under
`/kms` (`routes.ts:423-466`), and the `StorageBackend` contract states the
WebKMS protocol defines no keystore delete (`types.ts:1088-1124`). Once an
account Space is deleted, a keystore whose controller was promoted to that
account's did:webvh can never again resolve its controller
(`webvhController.ts:213-237` reads the controller document out of the account
Space's own `did.jsonl`), so the keystore is not merely leaked but permanently
unauthenticatable: no request can reach it. With no orphan GC, these accumulate
unboundedly -- plaintext at rest unless `KMS_RECORD_KEK` is set.

### WAS-73: Periodic sweep of Spaces and keystores whose did:webvh controller no longer resolves

- status: todo
- priority: medium
- labels: cleanup, backend, kms
- discovered-from: freewallet FW-400 design pass v3 (2026-08-31), the eventual
  mender of its accepted (b4)-(b5) residue; also the sweep WAS-70's orphan-GC
  decision calls for
- touches:
  - `src/backends/postgres.ts` and `src/backends/filesystem.ts` --
    `listSpaces()` exists (`src/types.ts:553`); a by-controller scan or an index
    is the open shape
  - the keystore store, for the keystore half
  - a scheduler or CLI entry point for the sweep itself
  - `ARCHITECTURE.md`
- acceptance:
  - [ ] A Space whose stored controller is a did:webvh that no longer resolves,
        because the Space holding its log is gone, is deleted after a grace
        period
  - [ ] The same rule applies to keystores
  - [ ] Resolution failure and resolution absence are distinguished: a did:webvh
        that fails to resolve for a transient reason, such as a backend outage,
        is not swept
  - [ ] A dry-run mode reports what would be deleted without deleting it
  - [ ] Tests on both backends

Context: no wallet depends on this sweep. Freewallet's deletion ceremony walks
every Space of the account itself, so a clean run leaves nothing behind. What
the sweep reaps is what a torn run leaves. An account Space whose unlock Spaces
are all deleted is unreachable to every client, since nothing can locate it and
nothing can authorize against it, so the server is the only party that can
remove it.

## Performance (signup request-pattern review, 2026-09-03)

A review of a freewallet signup ceremony's request log against the server (730
requests to the production host across three runs) found the hot paths already
memoized where it matters most (Space Descriptions, the base JSON-LD loader, the
did:key driver) and shipped the two cheap wins directly: preflight
`Access-Control-Max-Age`, and a per-Space live Resource count cache on the
filesystem create path. The remaining items from that review (webvh controller
revalidation, policy memoization) have since shipped and are recorded in
archived-roadmap.md.

### WAS-77: Per-Collection filename cache on the filesystem backend

- status: todo
- priority: low
- labels: performance, filesystem-backend
- acceptance:
  - [ ] `#findFile` / `#resourceFilesFor` resolve a `resourceId` to its
        representation filename through a per-Collection in-memory map (in the
        shape of `lib/spaceDescriptionCache.ts` and `lib/policyCache.ts`, one
        entry per Collection directory, bounded and short-TTL), populated from
        the directory listing on a miss
  - [ ] Every write that adds, renames, or removes a representation file
        (Resource and chunk create/update/delete, metadata writes that rename,
        Delete Collection, Delete Space, import, prune) drops or updates the
        affected Collection's entry
  - [ ] Callers that already hold a listing (the locked `writeResource` path)
        keep passing `entries` and do not populate the cache from a stale scan
  - [ ] Tests in `test/`: a Resource written then read on the same server hits
        without a second listing (observable through a spy or counter on the
        directory read); a delete is not served from the cache afterward; two
        Resources whose ids share a prefix resolve to their own files
  - [ ] The on-disk layout (`r.<id>.<type>.<ext>`) is unchanged

Context: a Resource's content-type lives only in its filename, so every single
representation lookup with no listing in hand (`#readRepresentation`,
`#statRepresentation`, the metadata write path) issues a full `readdir` of the
Collection directory: an O(n) scan, n being the files in the Collection, for a
point lookup, on each GET, HEAD, and PUT of a Resource or chunk. The locked
`writeResource` path already avoids the repeated cost by reusing one listing
across its steps; the read paths cannot, since each is a single call. The cache
is the same shape as the Space Description and policy caches, with one more
invalidation surface (any file write under the Collection). Surfaced by the
2026-09-05 codebase simplification review; the Postgres backend has no
equivalent cost (a primary-key lookup).

### WAS-86: Backend-evaluated `If-None-Match` on Resource and chunk reads

- status: todo
- priority: low
- labels: caching, performance, postgres-backend
- acceptance:
  - [ ] `getResource` and `getChunk` on `StorageBackend` accept an optional
        held-validator set (the `HeldValidators` value `parseIfNoneMatch`
        already produces, rather than the raw header) and resolve a not-modified
        result, carrying the current validator and no stream, when it covers the
        stored one
  - [ ] The Postgres backend answers a covered read without selecting the
        `content` column; the filesystem backend compares the sidecar validator
        it already reads and skips opening the file
  - [ ] Get Resource and Get Chunk pass the parsed set down and drop their
        metadata-first read; the 304 wire behavior and every existing
        conditional-read test in `test/` and the conformance suite are unchanged
  - [ ] Storage-contract tests cover the covered and uncovered paths on both
        backends; the webvh controller's unconditional `getResource` call is
        unaffected

Context: the conditional-read check (archived WAS-54) lives in the handlers. A
conditional Resource or chunk GET reads the metadata first and opens the byte
stream only on a miss, so on the filesystem backend a 304 costs a sidecar read.
On Postgres that first read is a separate query, and a miss then runs the
content query as well. Moving the comparison into the backend makes a
conditional hit one query with no content transfer and a miss the single query
an unconditional read costs. The header parsing stays in the request layer; the
backend only answers whether the stored version is in the set. Only worth doing
once Postgres is a deployment target for the wallet log workloads that motivated
the 304 path. discovered-from: WAS-54.

## Code review follow-ups (2026-09-05)

Findings from a review of the 2026-09-05 working tree (request-body helpers, KMS
record cipher migration, parallel chunk reads, filesystem candidate reader
consolidation). Each item is small and self-contained.

### WAS-92: Filesystem GET can observe a Resource with no validator mid-write

- status: todo
- priority: medium
- labels: filesystem-backend, consistency
- acceptance:
  - [ ] A Resource GET or HEAD on the filesystem backend never returns a
        representation without its `ETag` / version once a prior write has
        completed, and never returns the new bytes with the old sidecar
  - [ ] A test in `test/` drives a concurrent PUT and GET on one Resource (a
        slowed sidecar write is enough to widen the window) and asserts the read
        sees either the prior state or the fully committed new one
  - [ ] ARCHITECTURE.md's filesystem backend section states the read/write
        atomicity guarantee for a single Resource

Context: `writeResource` in `src/backends/filesystem.ts` writes the content file
(`#writeRepresentationBytes`, line 2734) and then the metadata sidecar
(`#writeMetaSidecar`, line 3217), under the per-resource `#writeMutex`.
`getResource` (line 3046) takes no lock: it locates the content file, then reads
the sidecar. A read that lands between the two writes returns the new bytes with
no `generation`, `version`, or `createdBy`, so the client sees no `ETag` and a
`version` of 0 on a Resource that a completed PUT then reports at version 1. On
a fast local disk the window is rarely hit; on GitHub Actions it surfaced as two
flaky `@interop/was-sync` integration tests, which now wait for an `ETag` before
reading back. The Postgres backend reads content and validator from one row and
is not affected. Candidate fixes: have reads take the resource mutex, or write
the sidecar first and make the content file visible last (a rename), so the
sidecar is present whenever the bytes are.

### WAS-83: Anonymous Get Policy with a malformed id now returns 401

- status: todo
- priority: low
- labels: policy, wire-contract
- acceptance:
  - [ ] Decide whether an anonymous policy GET with a malformed id answers 400
        `invalid-id` (id check before auth) or 401 (current behavior after the
        hook move); document the choice in CHANGELOG.md
  - [ ] A test in `test/` pins the chosen status for the Space, Collection, and
        Resource policy routes (GET and HEAD)

Context: moving the Get Policy auth check from the handler into a route-level
`onRequest` hook runs `requireAuthHeaders` before `assertValidIds`, so the
status changed from 400 to 401. Consistent with PUT and DELETE, which already
behaved this way, but wire-observable and uncovered by any test.

## Code review follow-ups (2026-09-11)

Findings from a high-effort review of `src/backends/` and the `src/lib/` modules
it imports. The correctness defects found in that pass were fixed in the working
tree; WAS-93 is the one finding whose fix changes a wire artifact, so it is
recorded here rather than coded. WAS-94 and WAS-95 came out of following that
finding into the sidecar-less Resource paths it depends on.

### WAS-93: Changes-feed keyset is not a total order

- status: todo
- priority: high
- labels: changes-feed, wire-contract, replication, filesystem-backend,
  postgres-backend
- touches:
  - wallet-attached-storage-spec: the Query Profile Registry's `changes`
    profile. Its "Ordering and resumption" paragraph states the feed is ordered
    by an ascending `(updatedAt, id)` keyset and that the checkpoint is an
    `{ id, updatedAt }` object; both statements change (the new text is
    described below)
  - storage-core: `ChangesCheckpoint` (`src/was.ts`), today
    `{ id: string, updatedAt: string }`, becomes the opaque checkpoint type, and
    the wire `ChangeDocument` gains the feed-position member
  - was-teaching-server: `src/backends/filesystem.ts` (`changesSince` and the
    Resource write paths that stamp the sidecar), `src/backends/postgres.ts`
    (`changesSince`, the `resources` table, and its write statements),
    `src/requests/CollectionRequest.ts` (`#queryChanges`, the checkpoint parse
    and the wire projection), `src/types.ts` (the `StorageBackend.changesSince`
    contract)
  - was-client: `Collection.changes()` passes the checkpoint through unchanged
    and needs only the new type; the loop guard in `Collection.documents()` that
    detects a non-advancing checkpoint concatenates `updatedAt` and `id` and
    must compare the opaque value instead
  - was-sync: `createPullHandler` (`src/changesQuery.ts`) already treats the
    checkpoint as opaque; only its `SyncCheckpoint` alias follows the type
  - conformance-suite: a case that writes two Resources into one Collection
    within a single millisecond, pages the feed with a checkpoint between them,
    and asserts neither is skipped; and a case asserting that a checkpoint from
    before a write, echoed back after it, surfaces the write
- acceptance:
  - [ ] Each write to a Collection takes a per-Collection feed position, a
        sequence number assigned inside the same per-Collection critical section
        that makes the write visible, so no write can ever land at or before a
        position already handed to a client
  - [ ] Both backends order and seek on that position, and a page's returned
        checkpoint resumes exactly after the last document
  - [ ] The checkpoint is opaque on the wire: a client stores it, compares it by
        equality only, and echoes it back verbatim. The server rejects a
        checkpoint it did not issue (including the retired `{ id, updatedAt }`
        shape) with `invalid-request-body` (400), and a replica then restarts
        its pull from the beginning
  - [ ] Each feed document carries its feed position, so a client can build a
        checkpoint from any prefix of a page
  - [ ] `updatedAt` stays a plain wall-clock stamp with no ordering role; the
        spec's "Ordering and resumption" paragraph says the feed is ordered by
        the issuing server's feed position, that the checkpoint is opaque and
        scoped to the server URL that issued it, and that `updatedAt` carries no
        ordering guarantee
  - [ ] A test in `test/` (and a conformance case) covers both skips described
        below, with the backend clock injected or frozen so the same-millisecond
        condition is asserted rather than raced
  - [ ] The checkpoint's exact encoding is agreed before it is coded, and the
        Query Profile Registry states it

Context: both backends key the feed on `(updatedAt, resourceId)` and seek
strictly past the checkpoint, and both stamp `updatedAt` from
`new Date().toISOString()` -- millisecond granularity. Two writes in a
Collection can therefore share an `updatedAt`, and the keyset stops being a
total order. Two skips follow. A client checkpoints on Resource `x` at time `T`
and a writer rewrites `x` within that same millisecond: `x` keeps its position,
every later pull skips it, and the replica serves the stale body until some
unrelated write moves `x`'s timestamp. And a Resource whose id sorts below the
checkpoint's id, written in the checkpoint's millisecond, sorts before the
checkpoint and is skipped the same way. A per-Resource tiebreak such as the
monotonic `version` the record already carries closes only the first skip. The
defect is not that two documents share a key; it is that a write can be assigned
a key behind a checkpoint already handed out. Only a per-Collection quantity
that only grows closes both.

A third gap hides behind the first two and constrains where the position is
assigned. A write that takes its key early and becomes visible late can still
land behind a checkpoint: writer A takes key `T`, is preempted, and finishes
after writer B took `T+1`, wrote, and was served to a reader who checkpointed
there. Both backends already serialize writes per Collection (a keyed lock in
the filesystem backend, an advisory lock in Postgres), so the position must be
taken inside that critical section, at the point the write becomes visible. This
is the same rule that makes a WAL log sequence number safe where a plain
database sequence (`nextval`, which is not commit-ordered) is not.

Two fixes were weighed. Stamping `updatedAt` as
`max(now, collectionWatermark + 1ms)` keeps the wire checkpoint unchanged and
makes the existing key a total order, at the cost of an `updatedAt` that runs
ahead of the wall clock during a burst. It was rejected for a structural reason
rather than that one: it makes `updatedAt` serve as the feed key, so the
receiving server must mint it, so it cannot be a fact about the write that
replicates verbatim between servers. The multi-primary direction recorded in
WAS-96 needs exactly that separation: a write's metadata (`updatedAt`,
`version`, `generation`) is owned by the server that accepted it and travels
with the write, while a feed position is a property of one server's feed and is
never replicated. The per-Collection sequence number is the design replication
feeds normally use (CouchDB's per-database update sequence, Postgres's WAL
position, Kafka's partition offset) and is the one to implement.

The checkpoint is opaque by decision, not merely by convention. CouchDB moved
its update sequence from an integer to an opaque string between 1.x and 2.x,
when a clustered feed needed one counter per shard, and broke every client that
had done arithmetic on it. Declaring the checkpoint opaque and scoped to the
issuing server now means the per-source or vector checkpoint that multi-primary
needs (WAS-96) can arrive without a second wire break. The client side is
already there: the RxDB pull handler in was-sync echoes the checkpoint verbatim
and RxDB persists it without inspection, so the only client code that reads
inside the checkpoint is the loop guard named under `touches`.

No compatibility path is offered for a persisted `{ id, updatedAt }` checkpoint.
The server refuses it as malformed, the replica restarts its pull from the
beginning, and the apply path, keyed by Resource id, makes that safe.

### WAS-94: Drop the filesystem backend's legacy stat-based fallbacks

- status: todo
- priority: medium
- labels: filesystem-backend, cleanup, greenfield
- acceptance:
  - [ ] `getResourceMetadata` reports no `createdAt` / `updatedAt` when the
        Resource has no sidecar, rather than substituting `birthtime` / `mtime`
        (both members are already optional on `ResourceMetadata`)
  - [ ] `changesSince` drops the mtime fallback: a sidecar-less Resource has no
        feed position and is left out of the feed
  - [ ] The `ETag` path stays as it is -- a Resource with no validator already
        carries no `ETag` -- and the three sites read consistently
  - [ ] A test in `test/` writes a representation file into a Collection dir
        with no sidecar and asserts the metadata read omits the timestamps and
        the feed omits the Resource
  - [ ] CHANGELOG.md records the behavior change

Context: three places in `src/backends/filesystem.ts` accommodate a Resource
written before the `.meta.` sidecar existed. `getResourceMetadata` (line 3506)
falls back to `stats.birthtime` / `stats.mtime` for `createdAt` / `updatedAt`;
`changesSince` (line 4341) falls back to the file's mtime for the feed's
ordering key; the ETag path (line 3620) leaves such a Resource without a content
`ETag`. The first two are data-migration accommodations for a `data/` tree
written by an older build, which this project does not carry. They are also
inconsistent with the neighbouring `createdBy`, which has no stat-based fallback
and is simply absent ("there is no stat-based fallback for it, as there is for
the timestamps"). Dropping them is type-clean: both timestamp members are
optional. The mtime fallback is worse than absence for the feed in particular --
a stat time bears no relation to the server's write order, so `cp` without `-p`,
a restore, or a `touch` silently moves a Resource's feed position, and can move
it below a checkpoint a client already holds (the same skip WAS-93 describes,
from a different cause). Once WAS-95 lands, the only way to reach these paths is
writing into `data/` behind the server's back.

### WAS-95: Import writes a Resource with no sidecar, so it has no feed position

- status: todo
- priority: high
- labels: import-export, changes-feed, filesystem-backend, postgres-backend
- blocked-by: WAS-93
- touches:
  - was-teaching-server: `src/backends/filesystem.ts` (`importSpace`),
    `src/backends/postgres.ts` (`importSpace`), and whatever allocates the feed
    ordering key once WAS-93 settles it
  - conformance-suite: an import case whose archive carries a Resource with no
    metadata entry, asserting the imported Resource appears in the changes feed
- acceptance:
  - [ ] `importSpace` never creates a Resource without the record that carries
        its feed ordering key: an archive entry with no metadata gets a
        synthesized one, stamped by the same allocation path an ordinary write
        uses, under the same per-Resource lock
  - [ ] The archive's `createdAt`, `createdBy`, and `custom` are preserved when
        present; only the ordering key is minted
  - [ ] A test in `test/` imports an archive carrying a Resource with no
        metadata entry and asserts the Resource appears in the changes feed at a
        position after every pre-existing document
  - [ ] Both backends behave identically, and the storage-backend contract test
        covers it

Context: discovered-from WAS-93. `importSpace` in `src/backends/filesystem.ts`
(line 1730) writes the representation unconditionally and the sidecar only if
the archive carried one: "A metadata sidecar travels with a newly-created
resource ...; an absent one leaves `getResourceMetadata` to fall back to the
file's stat times." An archive this server exported always carries the sidecars,
since export packs the Collection dir verbatim, so the gap is reachable through
a hand-built or foreign archive -- on a fresh server with no history at all. The
Postgres backend differs in degree, not in kind: `#insertImportedResource`
(line 4825) falls back to `sidecar?.updatedAt ?? now`, so an imported Resource
always has a feed position, but that `now` is stamped outside whatever
allocation WAS-93 introduces. Whichever ordering key WAS-93 settles on, import
has to participate in allocating it: a watermarked `updatedAt` is computed on
the write path an import bypasses, and a per-Collection sequence has no value at
all for an imported Resource. Blocked on WAS-93 because the key's shape decides
what import mints.

## Simplify pass follow-ups (2026-09-12)

Findings from a cleanup review of the v0.5 route-table change that were too
large to apply in that pass.

### WAS-102: Stop re-parsing a governed Collection's history log on every Metadata read

- status: todo
- priority: low
- labels: governed-history-logs, performance, filesystem-backend,
  postgres-backend
- acceptance:
  - [ ] A `PUT /space/:spaceId/:collectionId/meta` on a log-governed Collection
        parses the log at most once per request, while the recheck under the
        backend's lock still sees the log state as of the lock
  - [ ] `getCollectionOrThrow` no longer parses the whole log on each call:
        either the derived `encryption` is cached per Collection (invalidated by
        every `writeCollectionLog` and by Delete Collection / Delete Space /
        import), or the derivation reads only the head line it needs
  - [ ] The Postgres `writeCollection` recheck reads the log columns from the
        row it already holds `FOR UPDATE` instead of issuing a second `SELECT`
  - [ ] Existing governed-log tests stay green, plus a test that a log append is
        visible to the very next Metadata read and write

Context: `CollectionRequest.putMeta` calls `governedEncryptionOf`
(`src/requests/collectionContext.ts`) twice per write, once for the early
rejection and again inside `assertTransition` under the per-Collection lock.
Each call reads the whole log body and `deriveGovernedEncryption`
(`src/lib/governedLog.ts`) runs `parseGoverningLog` over every line, though only
the last line's `state` and the genesis line's `parameters.method` are used. The
log is append-only and grows without bound, so the cost is O(log size), twice.
Before v0.5 an annotation-only write (a rename, a `custom` or `epoch` edit) went
through a narrower endpoint that never touched the log; the merged full-replace
`PUT /meta` now pays it on every write. `getCollectionOrThrow`, which nearly
every Collection- and Resource-level handler calls, pays it once per request
too. A cache would follow the per-backend `LruCache` pattern of
`src/lib/spaceMetadataCache.ts` and `src/lib/policyCache.ts`. On Postgres the
recheck's log read is a second query against the `collections` row whose
`FOR UPDATE` lock `writeCollection` already holds, so the lock is held across an
extra round trip.

### WAS-103: Make `spacePath` / `collectionPath` return the canonical container URL by default

- status: todo
- priority: low
- labels: cleanup, paths
- acceptance:
  - [ ] `spacePath` and `collectionPath` in `src/lib/paths.ts` return the
        trailing-slash container form with no option
  - [ ] The no-slash base the sub-resource builders extend (`spaceMetaPath`,
        `collectionMetaPath`, `policyPath`, `exportPath`, and so on) comes from
        a separately named internal builder, not from a flag on the public one
  - [ ] No call site in `src/` or `test/` passes `trailingSlash` any more
  - [ ] Every `url`, `Location`, `targetPath` and root-capability target is
        byte-identical before and after (the full `test/` run and the
        conformance suite stay green)

Context: v0.5 made the trailing-slash form the canonical address of a Space and
a Collection, used for their `url` members, the `Location` of a create, the
authorization `targetPath` of container operations, and the root capability's
`invocationTarget`. The builders kept their v0.4 default of the no-slash form,
so about 33 call sites outside `paths.ts` pass `trailingSlash: true`. Dropping
the flag at any of them is not a type error and yields a URL that is wrong only
by its last character, in exactly the members that need to be canonical. The
no-slash form is wanted mostly inside `paths.ts` itself, as the prefix the
sub-resource builders extend; about 9 external call sites use it, and each
should move to the named base builder or a sub-resource builder.

## Whole-codebase review follow-ups (2026-09-17)

Findings from an adversarial review of every module in `src/*.ts` and
`src/requests/*.ts`, each read with the `src/lib/` modules it imports, against
the invariants ARCHITECTURE.md states. Findings marked "verified" were
reproduced against a live in-process server. Items are ordered by how silent and
permanent the bad state is. Findings already tracked elsewhere are noted on
those items (WAS-61, WAS-65, WAS-70, WAS-73, WAS-92, WAS-108) rather than
re-filed.

### WAS-114: Protect a promoted Space's `did.jsonl` from overwrite, rollback, and delete

- status: todo
- priority: high
- labels: security, webvh, authorization, log-continuity
- discovered-from: whole-codebase review (2026-09-17)
- touches:
  - `src/requests/ResourceRequest.ts` (`put`, `delete`),
    `src/lib/governedLog.ts` (the fast-forward rule to reuse),
    `src/lib/webvhController.ts` (`resolveVerifiedDocument`, `reviseEntry`)
  - ARCHITECTURE.md's self-hosted `did:webvh` section
  - wallet-attached-storage-spec: whether the authz profile should state the
    rule -- to be assessed
- acceptance:
  - [ ] A `PUT` of `did.jsonl` in any Collection is accepted only when the
        stored bytes are a prefix of the incoming bytes (the same fast-forward
        rule `governedLog.ts` applies to `meta/log`); a body that shortens or
        rewrites the log is refused 412
  - [ ] A `DELETE` of `did.jsonl` is refused while any stored Space or keystore
        controller names a DID anchored at that location, or unconditionally
        (decide which; the second is simpler and matches "the log is a Resource
        like any other" only for reads)
  - [ ] The resolver records the last-resolved head (entry count or version id)
        per log location and refuses a log that does not extend it
  - [ ] Tests: a retired client's subtree grant cannot roll the log back to a
        version that still lists its key; a subtree grant cannot delete the log;
        a legitimate append still resolves
  - [ ] ARCHITECTURE.md states that deleting the Collection holding a
        controller's log deadlocks the Space with no break-glass

Today `did.jsonl` is an ordinary Resource. `ResourceRequest.put` and `delete`
carry no container rule and no continuity rule, and their only log-specific step
is dropping the resolver cache, so the damage takes effect on the next request.
Two consequences. A `PUT` of unrelated bytes or a `DELETE` leaves the Space's
stored controller unresolvable, and every invocation, including the controller's
own, is a 404; the only repair (`PUT /space/S/meta` back to a `did:key`, or
restoring the log) authorizes against the broken controller.
`SpaceRequest.putMeta` guards this at promotion time only. And every prefix of a
valid webvh log is itself a valid log with the same SCID, so
`resolveVerifiedDocument` accepts a truncated log: a client whose key was
retired in entry 10, still holding the ordinary generation delegation on the
Space subtree, PUTs entries 1..9 over 1..10, its key is back under
`capabilityInvocation`, and it root-invokes `PUT /meta` to take the Space. The
governed history log has a fast-forward rule precisely so a write grant can add
history but not erase it; the DID log, which is the Space's authorization root,
has none.

### WAS-115: Container rule for Update Keystore

- status: todo
- priority: high
- labels: security, kms, zcap, authorization
- discovered-from: whole-codebase review (2026-09-17), verified
- touches:
  - `src/requests/KeystoreRequest.ts` (`update`),
    `src/requests/keystoreContext.ts` (`fetchKeystoreAndVerify`), `src/zcap.ts`
    (the `controller-only` header short-circuit)
  - ARCHITECTURE.md's container-rule paragraph
- acceptance:
  - [ ] `POST /kms/keystores/:keystoreId` refuses every delegated invocation off
        the `Capability-Invocation` header, the way `PUT /space/<S>/meta` does;
        a direct root invocation by the stored controller still succeeds
  - [ ] Tests: a delegated capability on the keystore URL with
        `allowedAction: ['write']`, and one with no `allowedAction`, are both
        refused with the masked 404; key operations under the same grants still
        work

`fetchKeystoreAndVerify({ allowedAction: 'write' })` passes no `containerRule`,
so a delegated write grant, or the action-less "full keystore" delegation, POSTs
a new `controller`. The original controller's invocations become 404s, and
revocation is impossible since the root capability's controller is now the
attacker. Every custodial key in the keystore is permanently the attacker's.
This is the hazard the WAS container rule closes for `PUT /space/<S>/meta`, with
no `/kms` analogue.

### WAS-116: Resolve a proposed `did:webvh` keystore controller before storing it

- status: todo
- priority: high
- labels: kms, webvh, ceremony
- discovered-from: whole-codebase review (2026-09-17), verified
- acceptance:
  - [ ] `KeystoreRequest.update` runs the same pre-store resolvability check
        `SpaceRequest.putMeta` runs (`resolveWebvhController`, refused with
        `UnresolvableControllerError`) when the proposed controller is a
        self-hosted `did:webvh`
  - [ ] Tests: promotion to a DID whose log is absent is refused and the
        keystore stays under its `did:key`; promotion to a published log
        succeeds
  - [ ] `validateDid.ts`'s comment on `assertValidSpaceController` names the
        keystore path as covered

`assertValidSpaceController` is syntactic only. A typo in the seven-segment DID
or a torn promotion ceremony (log not yet published) stores an unresolvable
controller, after which no request can authorize on the keystore and every key
record in it is inaccessible. There is no delete route (WAS-70) and no rotation
path that does not verify against the dead controller. With WAS-115 open, a
delegate can inflict this on the controller.

### WAS-117: Guarded create on the `PUT /space/:spaceId/meta` create branch

- status: todo
- priority: high
- labels: security, consent, consistency
- discovered-from: whole-codebase review (2026-09-17), verified (28 of 30
  concurrent create pairs ended with the second writer's controller)
- acceptance:
  - [ ] The create branch of `SpaceRequest.putMeta` passes `ifNoneMatch: '*'` to
        `writeSpace` unconditionally, as `SpacesRepositoryRequest.post` already
        does, and maps the 412 the same way
  - [ ] The `type` immutability check runs against the record the write actually
        observed, not the pre-verification read
  - [ ] A test drives a `POST /spaces/ {id: X}` and a self-signed
        `PUT /space/X/meta` concurrently and asserts the stored controller is
        the winner's, whichever wins
  - [ ] The comment claiming a concurrent create "surfaces here as 412" holds
        without a client-supplied header

The branch decision (authorize against the stored controller, or against the
body's own controller via `verifyBodyControllerConsent`) is made on an unlocked
read, and the write carries a precondition only when the client sent one. An
attacker PUTs `controller: attacker` for an id the victim is creating; the
victim's guarded create lands first; the attacker's unconditional write replaces
it. The victim got a 201 and now owns nothing. The same path bypasses the `type`
immutability check.

### WAS-118: Onboarding-token gate covers Space creation by `PUT /meta`

- status: todo
- priority: high
- labels: provisioning, security
- discovered-from: whole-codebase review (2026-09-17), verified
- touches:
  - `src/provisioning.ts`, `src/routes.ts` (the `provisioningRoutes` list),
    `src/requests/SpaceRequest.ts` (create branch), README's provisioning
    section
- acceptance:
  - [ ] With an onboarding token or `authorizeProvisioning` configured, the
        create branch of `PUT /space/:spaceId/meta` is gated exactly like
        `POST /spaces/` (either honor `request.provisioningAuthorized` there, or
        refuse create-by-PUT while a provisioning policy is configured; decide
        which)
  - [ ] Tests: with a token configured, a self-signed create-by-PUT without the
        token is refused; with the token it succeeds
  - [ ] `authorizeProvisioning` returning anything other than `'grant'`,
        `'deny'`, or `'verify'` fails closed (500 or deny), not open
  - [ ] An empty or whitespace `WAS_ONBOARDING_TOKEN` is a startup error or a
        logged warning, not silently open provisioning

The gate lists `/spaces` and `/spaces/` only. `PUT /space/<new>/meta` creates a
Space when absent and authorizes the create against the body's own controller,
so a fresh `did:key` provisions freely with no token, defeating both the token
and the per-controller cap (one `did:key` per Space costs nothing). README
promises the gate covers Space creation.

### WAS-119: Digest stream: handle the transform's error and drain it on early rejection

- status: todo
- priority: high
- labels: security, availability, digest
- discovered-from: whole-codebase review (2026-09-17), verified
- acceptance:
  - [ ] `captureRawBody` attaches an `error` listener to `DigestVerifyStream`
        (or destroys the wrapped payload) so a digest mismatch on a body the
        handler never consumed cannot become an uncaught exception
  - [ ] A test sends a streamed body with a mismatching `Digest` and well-formed
        but unverifiable auth headers, and asserts the server answers 404 and
        stays up
  - [ ] `start.ts` installs an `uncaughtException` / `unhandledRejection`
        handler that logs through pino and exits non-zero, so the next such
        defect is loud in the log rather than a silent restart

When the handler rejects before reading `request.body` (bad signature, masked
404, 405, a container-rule refusal), the transform's readable side is never
drained and has no error listener. `_flush` throws on mismatch, `pipe`'s
dest-error shim re-emits on a listener-less stream, and the process dies. One
unauthenticated request per crash.

### WAS-120: Digest transform breaks multipart uploads

- status: todo
- priority: high
- labels: digest, multipart, correctness
- discovered-from: whole-codebase review (2026-09-17), verified with a signed
  client
- acceptance:
  - [ ] A signed `multipart/form-data` Resource write with a correct `Digest`
        succeeds (today every one answers 400 "missing a file part")
  - [ ] The multipart body is still digest-bound: either the transform is
        bypassed for multipart and busboy's consumed bytes are hashed, or
        `@fastify/multipart` is fed the transform's output instead of
        `request.raw`
  - [ ] `test/` gains a multipart create and update case (none exists today)

`captureRawBody` pipes `request.raw` into the transform at `preParsing`, which
puts it into flowing mode. `@fastify/multipart` reads `request.raw` directly
when the handler calls `request.parts()`, by which time the leading boundary and
part headers are gone. Since unsigned writes are 401, every multipart write
carries a `Digest` and hits this.

### WAS-121: Gate Request Body Integrity on body presence, not `Content-Type`

- status: todo
- priority: high
- labels: security, digest
- discovered-from: whole-codebase review (2026-09-17), verified
- acceptance:
  - [ ] `verifyBodyDigest` and `captureRawBody` treat a request as bodied when
        it carries `content-length` or `transfer-encoding`, whatever its
        `Content-Type`; a bodied request whose signature does not cover `digest`
        is refused 400
  - [ ] Tests: `POST /space/S/import` and `PUT .../meta/log` with a body and no
        `Content-Type`, signed without `digest`, are refused
  - [ ] Decide whether the catch-all `'*'` parser should keep accepting a body
        with no `Content-Type` at all

The gate is `if (!contentType) return`. The plugin's `'*'` parser routes a
bodied request with no `Content-Type` to the handler as a raw stream, so no
`Digest` is demanded and nothing is hashed. Import Space untars `request.body`
directly and the governed-log `PUT` reads it as text, so both accept a body the
signature never covered; a captured signature is replayable with a different
body inside its `(created)`/`(expires)` window. Resource writes are protected
only by `resolveResourceInput` refusing a missing `Content-Type`, a handler
accident rather than a hook guarantee.

### WAS-123: CORS proxy: decide the SSRF check on the numeric address

- status: todo
- priority: high
- labels: security, cors-proxy
- discovered-from: whole-codebase review (2026-09-17), verified against a
  loopback service
- acceptance:
  - [ ] `isBlockedIp` expands an IPv6 literal to 16 bytes and tests the embedded
        IPv4 of `::ffff:0:0/96`, `::/96`, `64:ff9b::/96` (NAT64) and `2002::/16`
        (6to4) with `isBlockedIpv4`; the dotted-quad regex stays as the
        DNS-result path
  - [ ] Tests: `http://[::ffff:127.0.0.1]/`, `http://[::ffff:7f00:1]/`,
        `http://[::ffff:169.254.169.254]/` and `http://[64:ff9b::7f00:1]/` are
        refused 403

`isBlockedIpv6` matches an IPv4-mapped address only in dotted form, but the
WHATWG parser normalizes `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, which no
prefix in the list matches. `dns.lookup` echoes the literal, the DNS pin is
built from it, and undici dials loopback. The endpoint is unauthenticated.

### WAS-124: CORS proxy: response hardening and cache-key hygiene

- status: todo
- priority: medium
- labels: security, cors-proxy, caching
- discovered-from: whole-codebase review (2026-09-17), verified
- touches:
  - `src/corsProxy.ts`; WAS-65 covers the same headers on served Resources
- acceptance:
  - [ ] Every proxy reply carries `X-Content-Type-Options: nosniff`,
        `Content-Security-Policy: sandbox` (or `default-src 'none'`) and
        `Content-Disposition: attachment`, or the relayed `content-type` is
        restricted to a non-active allowlist; `Refresh` is dropped
  - [ ] The response-cache and single-flight key is the fetched identity
        (origin + path + search, fragment stripped) with `Accept` normalized or
        omitted
  - [ ] Replies vary on whatever request header still participates in the key
        (`Vary: Accept`), or `cache-control` from upstream is not relayed as
        `public`
  - [ ] A test that an upstream `text/html` body is not executable on the proxy
        origin, and that two fragment variants of one URL share one upstream
        fetch

An upstream answering `text/html` with script is relayed verbatim on the WAS
origin, where the welcome page, static assets and any wallet frontend also live.
`url.href` keeps the fragment, so fragment variants of one URL each get their
own cache entry, their own in-flight slot and their own upstream fetch, each
buffering up to 10 MiB.

### WAS-125: Re-check container existence inside the write lock

- status: todo
- priority: high
- labels: filesystem-backend, consistency, security
- discovered-from: whole-codebase review (2026-09-17), verified
- acceptance:
  - [ ] `writeResource`, `writeChunk`, `writeCollection`, `writePolicy` and the
        import path refuse (404) when the Space, and where applicable the
        Collection, has no Metadata object at the moment of the write, checked
        under the same gate the write holds; `mkdir -p` never recreates a
        container directory
  - [ ] A test issues a write whose prelude passed, then a Delete Space, then
        lets the write proceed, and asserts no directory is left behind
  - [ ] `writePolicy` on a Collection with no Metadata object is refused rather
        than materializing a phantom directory that `listCollections` then
        reports as a public Collection

The Space gate prevents a write interleaving with a removal, not a write whose
shared acquisition comes after the removal released the exclusive side. The
request layer's existence check is a TOCTOU. The result is `spaces/S/C/` holding
live Resources and no `.space.S.json`: invisible to every route and listing,
charged to quota forever, and adopted by the next Space created under id `S`,
whose controller then lists the previous owner's data. Postgres foreign keys
refuse the same insert, so the two backends diverge.

### WAS-126: Import Space validates what it installs

- status: todo
- priority: high
- labels: import, security, consistency
- discovered-from: whole-codebase review (2026-09-17)
- touches:
  - `src/lib/importTar.ts`, `src/backends/filesystem.ts` (`importSpace`,
    `#persistCollection`), `src/backends/postgres.ts`,
    `src/lib/metadataWrite.ts`, `src/requests/SpaceRequest.ts` (`import`)
  - WAS-68 covers the archived Collection `id`; this item covers the rest
- acceptance:
  - [ ] Validators (`_generation` / `_version`) from the archive are never
        stored; the import path mints a fresh generation (and starts the version
        at 1, or keeps the archived version if a reason to is found)
  - [ ] Revocation records are installed only after `verifyRevocationChain`
        passes for each, or the archive's revocations are ignored with a
        documented reason; today a Space-subtree POST grant installs arbitrary
        `(delegator, capabilityId)` records and there is no un-revoke
  - [ ] The effective `encryption` for the encrypted-write check is derived the
        way `getCollectionOrThrow` derives it (log head first), so a
        log-governed Collection's Resources are checked on import
  - [ ] An archive carrying both an `encryption` member and a governing log for
        one Collection, or `plaintext` plus a log, is refused
  - [ ] `plaintext.indexes`, each policy document, and the history log bytes
        pass the same validation the live write paths apply
        (`assertSupportedPlaintext`, `PolicyRequest.put`'s shape check, JSON
        parse) before anything is written
  - [ ] Tests for each refusal on both backends

Each of these lets a tarball put a Collection into a state no live write can
reach and no live write can repair. A `_version` of 2^53 freezes the Collection
Metadata `ETag` (every `+1` returns the same number), so conditional reads are
304 forever and every `If-Match` compare-and-swap succeeds. A re-imported
hard-deleted Collection resurrects its old generation, so a client's cached
validator matches different bytes. A `null` index entry makes `normalizeIndexes`
throw on every Resource write and on the repair `PUT /meta`. A non-JSON log
makes every Metadata load 500. A falsy policy document falls through the `||`
chain in `policy.ts` to the broader level.

### WAS-127: A Resource's access-control policy dies with the Resource

- status: todo
- priority: high
- labels: policy, security, consistency
- discovered-from: whole-codebase review (2026-09-17), verified on both backends
- touches:
  - `src/backends/filesystem.ts` and `src/backends/postgres.ts`
    (`deleteResource`), `src/backends/postgresSchema.ts` (no FK from `policies`
    to `resources`), `src/requests/ResourceRequest.ts` (`delete`),
    `src/lib/policyCache.ts`
  - ARCHITECTURE.md's soft-delete sentence, which lists what a delete drops
- acceptance:
  - [ ] `deleteResource` removes the Resource-level policy on both backends and
        the handler invalidates its cache entry
  - [ ] A test publishes `r1` with `PublicCanRead`, deletes it, re-creates `r1`,
        and asserts an anonymous GET is refused
  - [ ] `PolicyRequest.put` at the Resource level refuses when the Resource does
        not exist (no pre-seeding of a future id), or the pre-seeding behavior
        is documented as intended
  - [ ] The Collection listing's `public` flag reflects the effective policy (a
        Space-level `PublicCanRead` shows every Collection as public), or its
        doc states it reports the Collection level only

Delete Resource drops content, chunks, and the `/meta` object but never the
policy, so a `PublicCanRead` written to publish one record silently publishes
whatever next occupies that id (client-chosen ids such as `keyring` or `index`
collide routinely). No listing shows a Resource-level policy. Delete Collection
and Delete Space do clean policies up; the Resource level is the lone gap. The
container-rule half of policy control is WAS-61 / WAS-108.

### WAS-128: Refuse a governing log on a Collection that declares `plaintext`

- status: todo
- priority: high
- labels: governed-history-logs, encryption, consistency
- discovered-from: whole-codebase review (2026-09-17), verified
- acceptance:
  - [ ] The guarded create in `CollectionRequest.putLog`'s `assertTransition`
        refuses when the stored Metadata object carries `plaintext`, on the same
        terms as a stored `encryption`
  - [ ] A test declares `plaintext.indexes`, attempts the log create, and
        asserts the refusal and that a later `PUT /meta` rename still works
  - [ ] `test/governed-log-api.test.ts` covers both orders (it covers only "add
        `plaintext` to a governed Collection" today)

The declaration check reads `collectionMetadata.encryption` only. After the log
lands, the served object carries both `plaintext` and the derived `encryption`,
and every later `PUT /meta`, including a bare rename or a `custom` write, is
refused 400 by the exclusion rule. `plaintext` has no removal path and the log
is append-only, so the Collection's Metadata object is permanently unwritable;
the only remedy is Delete Collection. `POST .../query` answers 501 on such a
Collection while `GET ?filter[...]` still runs the equality machinery.

### WAS-129: Container rule for the Space revocation endpoint

- status: todo
- priority: medium
- labels: security, zcap, authorization
- discovered-from: whole-codebase review (2026-09-17)
- blocked-by: WAS-108
- touches:
  - `src/requests/RevocationRequest.ts`, `src/zcap.ts`
    (`handleRevocationInvocationVerify` has no `containerRule` option),
    ARCHITECTURE.md's container-rule paragraph
- acceptance:
  - [ ] Decide whether a Space-subtree data grant may submit revocations at
        `/space/<S>/zcaps/revocations/<id>`; if not, the route carries a
        container rule (the dual-root rule's delegee arm stays)
  - [ ] Tests: a transient annex key holding the generation delegation cannot
        revoke the wallet's management capability; the controller and the
        delegee still can

The revocation URL sits under the canonical Space URL with
`allowTargetAttenuation: true`, so the generation delegation (full verb set,
admitted by the client-annex clause's first shape) reaches it by prefix. A
per-visit key can revoke the durable client's grant; there is no un-revoke
endpoint. Same hazard class as WAS-108, applied to authorization state instead
of data.

### WAS-130: Signal handling, graceful shutdown, and temp-file cleanup

- status: todo
- priority: high
- labels: operations, filesystem-backend, availability
- discovered-from: whole-codebase review (2026-09-17)
- touches:
  - `src/start.ts`, `package.json` (`start` pipes through `pino-pretty`, so a
    supervisor's signal reaches the shell), `src/lib/atomicFile.ts`
    (`tempPathFor` has one call site and no sweeper), `src/backends/*.ts`
    (`close`), `src/corsProxy.ts` (`onClose`)
  - WAS-47 covers `start.ts` test coverage
- acceptance:
  - [ ] `start.ts` handles `SIGTERM` and `SIGINT` by calling `fastify.close()`
        with a drain timeout, so `onClose` hooks (Postgres `pool.end`, undici
        agents) actually run in production
  - [ ] Orphan `.tmp-*` files left by a killed in-flight write are swept at
        backend `init()` or excluded from the `du`-based quota, and the streamed
        write path removes its temp file on `close`/`aborted`
  - [ ] Startup failure writes its message before exiting on a piped stderr
        (`process.exitCode = 1` and let the process drain, rather than
        `process.exit(1)` after `console.error`)
  - [ ] `PORT` and `SERVER_URL` are cross-checked at startup: a loopback
        `SERVER_URL` whose effective port differs from `PORT` is a startup error
        or warning (the reverse-proxy case with a public host stays allowed)
  - [ ] The listen host is configurable (`HOST`, defaulting to Fastify's
        dual-stack `localhost` or documented as `0.0.0.0`), and README's dev
        invocation binds loopback
  - [ ] `parsePort` and `parseLimit` accept decimal integers only

Nothing registers a signal handler; Node's default disposition terminates
immediately. A kill mid-upload leaves `.tmp-<uuid>` in the Collection directory,
invisible to every listing but charged against `STORAGE_LIMIT_PER_SPACE`
forever. `console.error` then `process.exit(1)` can drop the carefully worded
config error on a pipe, so a container that failed on a bad `KMS_RECORD_KEKS`
exits 1 with empty logs. The `PORT`/`SERVER_URL` mismatch is the one
misconfiguration that breaks every ZCap match and is the only one not checked.

### WAS-131: Engage the `did:webvh` resolver on every verification path

- status: todo
- priority: medium
- labels: webvh, zcap, revocation, authorization
- discovered-from: whole-codebase review (2026-09-17), verified for List Spaces
- touches:
  - `src/zcap.ts` (`verifyRevocationChain`, `handleRevocationInvocationVerify`,
    `activeWebvhContext`), `src/requests/controllerConsent.ts`,
    `src/requests/SpacesRepositoryRequest.ts` (`list`),
    `src/requests/SpaceRequest.ts` (create-branch validator)
  - ARCHITECTURE.md's revocation and client-annex paragraphs (the annex GC
    "tolerates a refused revocation" note describes this defect)
- acceptance:
  - [ ] Both revocation functions pass the caller's `webvh` context through
        unconditionally, as `verifyZcap` does; `activeWebvhContext` is removed
        or its remaining use justified
  - [ ] `verifyRevocationChain`'s `expectedRootCapability` accepts the same
        roots `verifyZcap` synthesizes for the Space family (the Space URL and a
        Resource or Collection URL under it), so a grant that verifies on
        invocation can be revoked
  - [ ] `verifyBodyControllerConsent` threads `webvh`, so a delegated
        provisioning chain with a `did:webvh` link verifies; the `PUT /meta`
        create branch validates the body controller with `assertValidController`
        (creation stays `did:key`-only, as ARCHITECTURE states) rather than the
        update-only validator
  - [ ] List Spaces goes through `handleZcapVerify` with `webvh` and the chain
        inspectors, so a promoted Space appears in its own controller's listing
        and a delegated `GET /spaces/` is revocation-checked; decide whether a
        `/spaces/` revocation scope is needed, and cap the per-controller
        verification loop for an unauthorized delegated caller
  - [ ] Tests: revoke a child grant signed by a `did:webvh` method on a
        `did:key` Space; a `did:webvh` delegee self-revokes; List Spaces for a
        promoted controller returns the Space

The revocation path narrows the resolver to the scope's controller, so on a
`did:key` Space (the unlock-Space shape) a chain with any `did:webvh`-signed
link verifies on every route but answers 400 at revocation, and a `did:webvh`
delegee cannot self-revoke under the dual-root rule. Such grants stay live until
their own `expires`. `verifyZcap`'s own comment names this case as the reason it
engages the resolver unconditionally. The same missing option makes consent
verification refuse a `did:webvh` controller the create branch's validator
admits, and makes a promoted Space vanish from List Spaces (`totalItems: 0`).

### WAS-132: A present but unparseable `If-None-Match` on a write is a 400

- status: todo
- priority: medium
- labels: conditional-requests, consistency
- discovered-from: whole-codebase review (2026-09-17), verified
- acceptance:
  - [ ] `parseWritePreconditions` distinguishes header-absent from
        header-present-but-unrecognized and refuses the latter 400
        (`invalid-request` or a named type; wire-level, so decide the type
        first); `*` is recognized as a list member and in quoted form, or those
        forms are refused explicitly
  - [ ] `If-None-Match` on `DELETE` (Resource and chunk) is evaluated or
        refused, not silently dropped
  - [ ] `If-Match` against an absent chunk answers 412, matching the Resource
        path
  - [ ] Tests for `"*"`, `bogus`, the Node-joined duplicate `*, *`, and a list
        containing `*`, on Space and Collection Metadata and Resource writes

`parseIfNoneMatch` is the read-side parser, where skipping a non-quoted member
is deliberate. Reused for writes it turns a guarded create into an unconditional
replace: the loser of a provisioning race rewrites the winner's `controller` or
`type`, with a 204 to both. Node joins duplicate `If-None-Match` headers with
`, `, so a client library plus a wrapper that both set `*` produce `*, *`.

### WAS-133: The Resource `/meta` validator covers every member it serves

- status: todo
- priority: medium
- labels: conditional-requests, etag, consistency
- discovered-from: whole-codebase review (2026-09-17), verified
- acceptance:
  - [ ] A content write bumps `metaVersion` (or mints a fresh `metaGeneration`)
        whenever it changes `contentType`, `size`, `updatedAt` or `epoch`, or
        those members leave the `/meta` representation; decide which
  - [ ] `getCollectionOrThrow` reads the Collection Metadata object before the
        log, or both under the `cmeta:` lock, so a served `ETag` never pairs
        with an older log head
  - [ ] Tests: a conditional `GET /meta` after a content-type change is 200; a
        conditional Collection Metadata read racing a log append never returns
        304 for a body the server would not serve

The `/meta` `ETag` is `metaGeneration.metaVersion`, which a content write
deliberately leaves alone, while the representation includes content-derived
members. A cached `/meta` can keep naming a key epoch the Resource no longer
carries, with every revalidation affirming it. Separately, the parallel
metadata/log read pairs the post-append validator with the pre-append
descriptor, so a 304 pins a stale recipient set.

### WAS-134: Compose Update Collection under the lock

- status: todo
- priority: medium
- labels: consistency, plaintext-indexes, backend
- discovered-from: whole-codebase review (2026-09-17), verified (19 of 20
  trials)
- acceptance:
  - [ ] The carry-forward of `plaintext`, `backend` and the other preserved
        members is computed from the record read under the `cmeta:` lock, not
        from the pre-verification read (move composition into the
        `assertTransition` callback, or have it return the object to persist)
  - [ ] The unique-index declaration scan and the Resource write that reads the
        declaration serialize on one lock, so a Resource write in flight during
        a `unique: true` declaration cannot land a duplicate
  - [ ] A test drives an unconditional rename concurrently with a `plaintext`
        add and asserts the declaration survives

The under-lock re-check re-runs assertions against the fresh record but the
object being written was composed against the stale one, and assertions catch
violations, not lost carry-forwards. A `unique: true` declaration disappears
with a 204 to both writers, or a `backend` selection silently reverts to the
default. The comment at the re-check claims the opposite.

### WAS-135: Torn-run ordering in the filesystem backend's delete and update paths

- status: todo
- priority: medium
- labels: filesystem-backend, consistency
- discovered-from: whole-codebase review (2026-09-17)
- touches:
  - `src/backends/filesystem.ts` (`deleteResource`, `writeResource`,
    `writeCollectionLog`, `insertRevocation`, `#collectionIds`); WAS-92 covers
    the read-side window of the content/validator split
- acceptance:
  - [ ] Soft delete removes the chunk directory and writes the tombstone sidecar
        before removing the content file, so a crash leaves a state a re-issued
        `DELETE` completes rather than orphan chunks a re-created Resource
        inherits, or an orphan sidecar the changes feed never reports
  - [ ] `writeResource` clears any leftover chunk directory on a create
  - [ ] A content-type change prunes the old representation before the new one
        is visible, or `#findFile` prefers the sidecar's recorded type, so a
        torn run cannot serve the pre-write bytes under the post-write validator
  - [ ] `insertRevocation` takes the Space gate, so a revocation racing Delete
        Space is not stranded for the next Space at that id; Delete Space plus
        re-create under the same id and controller does not resurrect unexpired
        revoked grants (decide: keep the revocation directory, or document the
        reset)
  - [ ] `#collectionIds` and the count-quota branch go through
        `#readDirEntries`, so a listing racing Delete Space is a 404, not a raw
        `ENOENT` 500
  - [ ] The `writeCollectionLog` two-commit window (log then Metadata version)
        is closed or documented

### WAS-136: Backend registry lifecycle: cache, immutability, in-use checks, data-plane delete

- status: todo
- priority: medium
- labels: gdrive-byos, backend, consistency
- discovered-from: whole-codebase review (2026-09-17)
- touches:
  - `src/lib/backendRegistry.ts`, `src/lib/backends.ts`,
    `src/requests/BackendRequest.ts`, `src/requests/collectionInput.ts`,
    `src/requests/CollectionRequest.ts` (`delete`),
    `src/requests/SpaceRequest.ts` (`delete`); WAS-108 covers the container rule
- acceptance:
  - [ ] The resolved-adapter cache is invalidated by Delete Space and by
        `POST /backends`, and invalidated before as well as after a record write
        (or keyed on a record fingerprint), so a memoize racing a
        re-registration cannot pin a superseded adapter
  - [ ] `PUT /backends/:id` refuses a `provider` change; `DELETE` refuses while
        any Collection selects the record, or the response lists the affected
        Collections
  - [ ] A Collection's `backend` selection is immutable once set (spec: "set
        during its creation"); a `PUT /meta` naming a different backend is
        refused
  - [ ] `resolveBackendDescriptor` raises `unsupported-backend` on a miss
        instead of reporting the default backend
  - [ ] Delete Collection and Delete Space delete the Collection's Resources
        through its data-plane backend before removing the control-plane record,
        or record the orphan for a sweep
  - [ ] Body parsing and the allowlist check in `BackendRequest` run after
        `fetchSpaceAndVerify`; the duplicate-id check is under the write lock

Latent while the production provider registry is empty, but each is a silent
divergence between the record on disk and the adapter serving traffic, or data
stranded on an external account with no server-side pointer to it.

### WAS-137: Bind the KMS record envelope to its record

- status: todo
- priority: medium
- labels: kms, security, wire-contract
- discovered-from: whole-codebase review (2026-09-17), verified with a spliced
  record
- touches:
  - `src/lib/kmsRecordCipher.ts`, `src/requests/KeyRequest.ts` (`runOperation`),
    `scripts/reencrypt-kms-records.ts`, admin guide
  - a permanent at-rest format change; the protected-header layout needs
    sign-off before it is coded
- acceptance:
  - [ ] The envelope's protected header (and so the GCM AAD) carries
        `keystoreId`, `localId`, `key.id`, `type`, `maxCapabilityChainLength`
        and `kekId`; decrypt compares them to the record it was read from and
        refuses a mismatch
  - [ ] `fetchKeyRecord` compares `record.key.id` to the invoked URL
  - [ ] Decrypt selects the recipient by `kid` / `kekId` rather than
        `recipients[0]`
  - [ ] The re-encryption tool migrates existing envelopes
  - [ ] A test splices key A's `encrypted` object into key B's record and
        asserts the operation is refused

The AAD is the constant `{"enc":"A256GCM"}`, and `type`, the alias fields and
`maxCapabilityChainLength` sit beside it as unauthenticated plaintext. An
attacker with data-directory or backup access and no KEK moves a controller-only
signing key's envelope into a record it holds a `sign` grant for, strips the
chain bound, and signs with the victim's key under its own keystore.
Confidentiality holds; usage control and integrity do not.

### WAS-138: Fail closed on empty or dangling security configuration

- status: todo
- priority: medium
- labels: config, security
- discovered-from: whole-codebase review (2026-09-17)
- touches:
  - `src/config.default.ts`, `src/lib/kmsRecordCipher.ts`,
    `scripts/reencrypt-kms-records.ts`, `src/lib/backends.ts`
- acceptance:
  - [ ] A non-empty `KMS_RECORD_KEK` / `KMS_RECORD_KEKS` that parses to zero
        KEKs is a startup error
  - [ ] `currentRecordKek` throws when `currentKekId` is non-null but absent
        from the registry (today indistinguishable from the deliberate
        decrypt-only posture; the rotation tool would rewrite the whole keystore
        tree to plaintext with a success banner)
  - [ ] `WAS_ENABLED_BACKENDS=""` (or an all-empty list) means deny-all, not
        permissive; `undefined` keeps meaning permissive
  - [ ] A `dist/build-info.json` that parses but lacks `version` fails the
        freshness guard rather than disabling it

### WAS-139: Keystore config validation and listing completeness

- status: todo
- priority: medium
- labels: kms, wire-contract
- discovered-from: whole-codebase review (2026-09-17), verified
- acceptance:
  - [ ] Create Keystore refuses any `kmsModule` other than `DEFAULT_KMS_MODULE`
        (today free text, immutable, never consulted, so a keystore can
        permanently advertise a custody module the server does not implement)
  - [ ] List Keystores paginates with a cursor like List Keys, or reports
        `totalItems` and a `next` link when it truncates at
        `KEYSTORE_LIST_LIMIT`; `listKeystoresByController` no longer parses
        every keystore config on the server per request
  - [ ] `fetchKeystoreAndVerify` re-reads the config after verification (or
        holds the keystore mutex across verify and operate), so a controller
        rotation is not honored for the outgoing controller's in-flight requests
  - [ ] `dereferencedChainLength` defaults closed when the verifier returns no
        chain; `KeyRequest.get` / `list` honor the per-key chain bound, or the
        bound is documented as operation-only
  - [ ] `decodeBase64url` in `src/lib/kmsModule.ts` rejects input outside the
        alphabet rather than signing over silently dropped bytes
  - [ ] Decide whether Create Keystore takes a client idempotence key (a re-run
        mints a second keystore today; wire-level, ask first)

### WAS-140: Exchanges facet hardening

- status: todo
- priority: medium
- labels: exchanges, security
- discovered-from: whole-codebase review (2026-09-17), verified
- acceptance:
  - [ ] The response half is first-write-wins: a second `POST` with a response
        body after `state: 'complete'` is refused (409), and the begin step is
        not replayable after completion
  - [ ] Every exchange response carries `Cache-Control: no-store`
  - [ ] The exchange id is redacted from the request log (pino `redact` on
        `req.url` for this route family, or a custom request serializer)
  - [ ] A completed exchange is deleted on first read of its response, or the
        TTL after completion is short
  - [ ] Begin and respond are discriminated explicitly (a query flag or a typed
        body), not by `{}` versus non-empty, and `text/plain` is not accepted as
        a response
  - [ ] The facet installs `handleError`, so a Fastify-level failure is a
        problem document
  - [ ] Decide whether the global live-exchange cap needs a per-IP share or rate
        limit (one unauthenticated client can hold it full indefinitely)

The exchange URL is the only credential and it is written to the info log on
every request. Possession lets a third party overwrite the posted response, and
the desktop learns nothing.

### WAS-142: Problem documents on every route, and Fastify's own errors typed

- status: todo
- priority: medium
- labels: errors, wire-contract
- discovered-from: whole-codebase review (2026-09-17), verified
- acceptance:
  - [ ] `handleError` is installed at the root (the groups' own registration
        still wins where present), so the welcome page, `/health`, static, the
        proxy, the service description and the exchanges facet never leak
        `err.message` through Fastify's default handler
  - [ ] A `setNotFoundHandler` answers unmatched routes with a problem document
        instead of echoing method and path
  - [ ] Fastify errors carrying a 4xx `statusCode` (`FST_ERR_CTP_*`, multipart
        limits, malformed JSON) map to a client-error `type` with a `detail`,
        never `internal-error` with `errors: [{}]`
  - [ ] An error thrown inside a chain inspector (a corrupt revocation file, a
        storage fault) is logged at `warn` with the cause and is a 500, not
        laundered into the masked 404; a plain refusal is logged at `debug` with
        its reason
  - [ ] Decide whether 401s carry a `WWW-Authenticate` challenge, and with what
        value (wire-level)

### WAS-143: Method refusals answer before the auth hook, and every container has them

- status: todo
- priority: medium
- labels: routing, spec-conformance
- discovered-from: whole-codebase review (2026-09-17), verified
- acceptance:
  - [ ] An anonymous unsafe method at a reserved endpoint or container URL
        answers 405 with `Allow`, not 401 (register the refusal routes outside
        the auth hook, or give them a route-level `onRequest` that
        short-circuits it)
  - [ ] `/space/:spaceId/backends/:backendId` and
        `/space/:spaceId/:collectionId/:resourceId/chunks/:chunkIndex` are in
        their group's refusal list, so `GET /space/S/backends/x` is a 405 rather
        than backtracking to the Resource route's 409 `reserved-id`;
        `GET /space/S/meta/log` likewise
  - [ ] The `/spaces/` group ends with `refuseUnimplementedMethods` and the bare
        `/spaces` redirects for the whole `CONTAINER_REDIRECT_METHODS` set
  - [ ] The strip-slash 308 on Resource and chunk URLs applies to every method,
        or to none (today `PUT` only)
  - [ ] Tests per case

### WAS-144: Ignore a non-`Signature` `Authorization` header on an anonymous read

- status: todo
- priority: medium
- labels: authorization, public-read
- discovered-from: whole-codebase review (2026-09-17), verified
- acceptance:
  - [ ] `parseAuthHeaders` parses only when the scheme is `Signature` (or only
        when `Capability-Invocation` is also present) and otherwise leaves
        `request.zcap` unset on a safe method, so a `Bearer` injected by a
        gateway or cached `Basic` credentials do not 400 a read the policy
        grants
  - [ ] `ParsedZcap.invocation` is typed optional and the `as ParsedZcap` cast
        dropped, surfacing the guards the compiler cannot see today
  - [ ] `authorize()` derives read versus write from the route's `config.safe`,
        not the HTTP method, so `POST .../query`'s documented policy fallback is
        reachable (and `requireAuthHeadersOrPublicRead` admits it anonymously),
        or the handler's doc says capability-only
  - [ ] Tests for `Bearer` and `Basic` on a `PublicCanRead` Resource, and an
        anonymous equality query on a public Collection

### WAS-145: Media-type edge cases in `resolveResourceInput`

- status: todo
- priority: medium
- labels: correctness, content-types
- discovered-from: whole-codebase review (2026-09-17), verified
- acceptance:
  - [ ] The `+json` parser regex is anchored so `application/ld+jsonl` and
        `application/ld+json-seq` take the binary path `isJson()` promises,
        instead of handing a parsed object to `pipeline` (500)
  - [ ] The multipart branch matches case-insensitively and only
        `multipart/form-data`; `multipart/mixed` and other multipart types are
        stored as blobs or refused with a typed 415
  - [ ] A chunk `PUT` declaring a JSON media type is stored byte-verbatim
        (chunks are ranges of a stream, not documents)
  - [ ] The multipart 413 names the limit that was enforced (the server
        backend's), and `maxUploadBytes!` is not asserted on an optional field
  - [ ] A multipart create's 201 echoes the stored `content-type`, not the
        request envelope's
  - [ ] `test/` covers each case

### WAS-146: Startup and composition hardening in `plugin.ts` and `server.ts`

- status: todo
- priority: low
- labels: library-surface, config
- discovered-from: whole-codebase review (2026-09-17)
- acceptance:
  - [ ] `createApp` / `fastifyWas` refuse `serverUrl: undefined` at registration
        (the documented library example passes `process.env.SERVER_URL`
        unguarded); `assertValidServerUrl` rejects userinfo
  - [ ] The plugin sets `logger`, calls `init()` and `close()` only on a backend
        it built itself, or takes an explicit `ownsBackend` option
  - [ ] CORS is an option (origin, methods without `PATCH`), or the docs state
        that a hardened composition inherits `origin: '*'` and the `'*'` parser
        on its own routes
  - [ ] `src/requests/collectionContext.ts` builds the log URL with `new URL`,
        so a trailing-slash `SERVER_URL` does not yield `//space/...` in
        `encryption.history.resource`; `exchanges.ts` likewise

### WAS-147: Small wire and doc corrections from the review

- status: todo
- priority: low
- labels: cleanup, wire-contract, docs
- discovered-from: whole-codebase review (2026-09-17)
- acceptance:
  - [ ] `zcapCryptosuites` in the service description lists cryptosuite names
        only; `Ed25519Signature2020` is a proof `type` and either moves to a
        separate member or is dropped (WAS-69)
  - [ ] `notModifiedReply` sends no `Content-Length: 0` on a 304 for an
        implicit-HEAD route
  - [ ] `deriveGovernedEncryption` always stamps `history.resource` with the
        log's own URL and drops a client-written `history` when the genesis
        carries no `parameters.method`, or the doc says `history` is not
        server-guaranteed
  - [ ] An identical-body governed-log `PUT` (zero new lines, stored bytes
        unchanged) is a no-op 204, not `invalid-request-body`
  - [ ] `PUT /space/:spaceId/meta` on an existing Space is the full replacement
        its contract states (an omitted `name` is removed), or the contract says
        merge
  - [ ] The 201 of a token-provisioned Create Space echoes what was persisted
        (no client-supplied `createdBy`); unknown body members are not stored
  - [ ] `filter[__proto__]=v` on the equality query answers the documented 400,
        not an empty 200
  - [ ] `StorageBackend`'s contract text matches `getResource` (throws),
        `getChunk` (rejects) and `deleteChunk` (resolves `false`); the
        `filesystem.ts` comment claiming `ifNoneMatch` takes precedence is
        corrected; `generator.ts`'s header matches clear-on-omit; `types.ts`'s
        `declaredBytes` note matches the multipart branch
  - [ ] ARCHITECTURE.md states the single-instance assumption the 10 s
        `spaceMetadataCache` and `policyCache` TTLs rest on (a retired
        controller keeps authority on another instance for one TTL), and that
        `allowTargetQuery` bounds the accepted root set only (the query-bearing
        request URL is always an accepted target)
  - [ ] `putMeta`'s uniqueness scan runs after the Resource-existence check, so
        a claim on an absent Resource is 404, not 409
  - [ ] The chunk listing documents `count` as cardinality, or reports the
        extent alongside it; chunk writes are documented as outside the
        Resource-count quota
  - [ ] Auxiliary Spaces count toward `maxSpacesPerController` but are excluded
        from List Spaces; document or expose them

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
axis. Feeds the "server knowledge" spec section (ECS-4 in the Encrypted
Collections spec roadmap): whatever stays visible should be listed there as a
documented, deliberate residue.

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
        a pointed privacy warning (superseded as written, see WAS-63: the spec's
        `plaintext`/`encryption` exclusion is presence-based and an encrypted
        Collection's `custom` metadata is itself an envelope)
  - [ ] Path-valued index names (JSON Pointer) for nested attributes

Follow-ons deliberately deferred from the v1 `equality` profile: (a) _compound
indexes_ -- a declaration form for efficient conjunction lookup and composite
uniqueness claims (an `equals` element with multiple pairs is already a compound
query); (b) _custom-sourced indexes on encrypted Collections_ -- tags on
encrypted photos, since `custom` metadata is server-visible plaintext
regardless; (c) _path-valued index names_ -- extending the `name` grammar to
JSON Pointer for nested attributes.

### WAS-96: Multi-primary Spaces (replicated write identity and conflict model)

- status: draft
- priority: medium
- labels: data-model, replication, changes-feed, etag, spec-blocked
- discovered-from: WAS-93
- touches:
  - wallet-attached-storage-spec: the Resource data model (a replicated origin
    identity and the validators), the `changes` profile (per-source or vector
    checkpoints), and a new section on server-to-server sync
  - storage-core: `ChangeDocument`, `ChangesCheckpoint`, and the Resource
    metadata model
  - was-teaching-server: the `ETag` derivation in `src/lib/etag.ts`, the sidecar
    and `resources` row layouts, both `changesSince` implementations, and a sync
    facet that pulls a peer's feed under a delegated capability
  - was-client and was-sync: one checkpoint per server a replica pulls from, and
    idempotent apply across sources

Draft rather than todo: the done-state depends on a Resource-model decision the
spec has not made (how two concurrent versions of one Resource are represented
and resolved), so there are no acceptance criteria yet. This item records what
multi-primary forces, so that the single-server items filed in the meantime
(WAS-93 first) do not close the door. Promote it to `todo` once the conflict
model is decided, with acceptance criteria per bullet below.

The goal: a Space lives on more than one server, each accepts writes to the same
Collection, and the servers sync with each other. Today a Space lives on one
server, because every capability's `invocationTarget` embeds that server's URL,
and the only multi-writer case is many clients pushing to one server that
serializes them. With two primaries there is no total order over a Collection's
writes, only each server's local commit order. Everything below follows from
that.

Feed position is local. A client's checkpoint is a position in one server's feed
and means nothing on the other. Either a replica keeps one checkpoint per server
it pulls from (CouchDB's per source-target checkpoint), or the checkpoint
becomes a vector with one entry per source (CouchDB's clustered sequence).
WAS-93 makes the checkpoint opaque and server-scoped so either extension fits
inside it.

A write needs a replicated identity. When server B receives a write that
originated on A, B assigns it a position in B's own feed, but the write keeps an
origin stamp: the accepting server's identifier plus a stamp from that server.
Without it a client pulling both feeds sees the write twice and cannot tell, and
A cannot recognize its own write returning from B and stop the loop. A hybrid
logical clock (physical time plus a logical counter, as in CockroachDB and
MongoDB's cluster time) is the natural stamp: it stays close to wall time and is
comparable across servers, which a last-writer-wins rule needs, and it lets
`updatedAt` remain the origin's honest clock rather than the receiving server's.
The exact members, their encoding, and where they live (sidecar, row, feed
document, `/meta`) are wire decisions to be made when the item is promoted.

Record metadata must be origin-owned and replicated verbatim. This is the `ETag`
consideration. Today the validator is `"<generation>.<version>"`, the generation
a random marker minted by this server when the record's counter starts, and the
version a per-server counter. If B re-mints either on receive, a client holding
an `ETag` from A cannot send `If-Match` to B, and the same logical write carries
different validators on each replica. So `generation`, `version`, `updatedAt`,
and the `/meta` pair (`metaGeneration`, `metaVersion`) become facts about the
write, minted once at its origin and stored unchanged by every replica. The
quoted byte layout of the validator can stay; what changes is who mints it and
that it travels with the write. The generation could remain random-at-origin or
be derived from the origin identity; either way it can no longer be a per-server
marker. The hard-delete rule ("a new record under the same id mints a new
generation") also needs a multi-server reading, since two servers could
re-create the same id independently.

Concurrent versions need a merge rule. Two primaries can each accept a write to
`x` while partitioned, and a single counter cannot express that. The known
choices are a version vector or revision tree that surfaces the conflict to the
client (CouchDB, Riak), or last-writer-wins on the origin clock. The `If-Match`
precondition model assumes one authority per Resource, and multi-primary
replaces that with the merge rule. This is the spec-level decision the item is
blocked on. Encrypted Collections constrain it further: the server cannot merge
opaque envelopes, so any resolution beyond last-writer-wins must be a
client-side merge of surfaced conflicts.

Server-to-server sync itself. A server can act as a client of its peer: the
Space controller delegates a capability to the peer server's DID, and the peer
pulls the changes feed under it, keeping one checkpoint per peer. Received
writes take a local feed position and keep their origin stamp; a write whose
origin is the receiving server itself is a loop and is dropped. The capability's
`invocationTarget` embeds the peer's URL, so a Space on two hosts has two URL
identities under one controller; how a client discovers the replica set (a
service entry on the controller document, or the Space Description) is open.

Out of scope until promoted: the reader-safety watermark (closed timestamps)
that would be needed if per-Collection write serialization were ever relaxed;
blob and chunk replication (WAS-14); and server-signed checkpoints (WAS-36),
which interact with per-source checkpoints and should be designed together.

---
