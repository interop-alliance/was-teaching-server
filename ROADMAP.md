# WAS Teaching Server Roadmap (spec gap analysis)

nextAvailableId: 97

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

### WAS-60: Enforce the container rule (unsafe methods at a container URL are controller-only)

- status: todo
- priority: high
- labels: security, zcap, authorization
- touches:
  - wallet-attached-storage-spec: WASS-2 in that repo's ROADMAP.md defines the
    rule (Delete Space, Update Space Description, Delete Collection, Update
    Collection Description become direct-root-invocation only, and Collection
    creation is routed through the reserved `collections` endpoint); this item
    is the enforcement half and follows the spec text, including the Space
    DELETE exception and the delegated collection PUT exception below, both of
    which WASS-2's text must state before this item enforces them
  - was-teaching-server: `src/requests/SpaceRequest.ts` (`put`, `delete`,
    `post`), `src/requests/CollectionRequest.ts` (`put`, `delete`),
    `src/routes.ts` (the `collections` create route),
    `src/lib/clientAnnexClause.ts` (the clause predicate covering the
    exception's ladder-signed case, freewallet FW-400 W3), AGENTS.md
  - was-client: its Collection-create binding moves to the `collections`
    endpoint once the spec routes it there
  - conformance-suite: negative-path assertions (a delegated capability with
    `allowedAction` covering `PUT`/`DELETE` invoked at a Space or Collection URL
    is denied with the maximum-privacy 404) and a positive assertion for
    exact-target delegated Collection creation
- acceptance:
  - [ ] `PUT /space/{id}` and `DELETE .../{collectionId}` accept only direct
        root-capability invocation by the Space controller; a delegated
        capability is refused regardless of its `allowedAction`
  - [ ] `PUT .../{collectionId}` accepts direct root-capability invocation, and
        additionally a delegated capability whose `invocationTarget` is the
        Space's items subtree (the trailing-slash Space URL, the shape a
        generation delegation carries) and whose `allowedAction` covers `PUT`. A
        delegated capability whose target is the collection container URL
        itself, or a resource URL, is refused. This second exception is
        mandatory (freewallet FW-400 W2, decided 2026-09-01 under its review
        R3); see below
  - [ ] `DELETE /space/{id}` accepts direct root-capability invocation, and
        additionally a delegated capability whose `invocationTarget` is exactly
        that Space's URL and whose `allowedAction` is exactly `['DELETE']`. This
        exception is mandatory (see below); it holds whatever DID method the
        Space's controller uses
  - [ ] Regression tests for the exception: an exactly-`['DELETE']` delegation
        on the bare Space URL stays admitted, while a two-verb delegation
        carrying `DELETE` (say `['GET', 'DELETE']`) is refused, as is a
        `['DELETE']` delegation whose target is a prefix rather than that
        Space's own URL
  - [ ] Regression tests for the collection-PUT exception: a delegated
        `PUT .../{collectionId}` under a Space-subtree delegation is admitted (a
        transient session's unlock-methods registry write, a generation
        collection create, and App Connect collection provisioning all ride this
        shape), while the same PUT under a capability targeting the collection
        container URL is refused
  - [ ] Every request freewallet's account-deletion ceremony and transient login
        send stays admitted with enforcement on: freewallet's `tests/e2e-was/`
        suite runs green against this server version before freewallet adopts it
  - [ ] Collection creation is served at the reserved `collections` endpoint and
        accepts an exact-target delegated capability (per the WASS-1 / WAS-59
        classes); the `POST /space/{id}/` create route is retired
  - [ ] The Update Space Description path keeps its body-controller consent
        check (`verifyBodyControllerConsent`) on top of the new rule
  - [ ] Server `test/` coverage for each refused and permitted case, plus the
        conformance assertions above

Split out of wallet-attached-storage-spec WASS-2 (2026-08-20), which keeps the
spec half. Today all four container unsafe handlers run capability-only
verification (`fetchSpaceAndVerify` / `handleZcapVerify`) that accepts a
delegated chain attenuating from the Space root, so a Space-scoped grant
carrying `DELETE` can delete the Space or any Collection in it; and Collection
creation is `POST /space/{id}/` (`SpaceRequest.post`), which the container rule
would make controller-only unless it moves to `collections`. Sequence after
WAS-59, since the `collections` create route relies on its exact-target class.

The Space DELETE exception is mandatory, not a convenience (freewallet FW-400
W2, decided 2026-08-31 and widened 2026-09-01 to every Space). Enforcement built
from this item's original text would break three live paths at once. FW-400 v5
deletes the account Space and the auxiliary annex Space(s) through a
ladder-VM-signed delegation invoked by the visit's annex key; it deletes each
sibling unlock Space through a ladder-signed child of the `manageCapability` the
unlock did:key already delegated to the account; and today's remembered-session
unlock-Space delete rides that same `manageCapability` child. Every one of those
is a delegated Space DELETE. Land the exception with the rule or those deletions
all start failing.

Sequencing, decided 2026-09-01: this item is NOT a precondition of freewallet
FW-403 or FW-400. Both ship against the unenforced server, where ordinary chain
verification admits every delegated Space DELETE and collection PUT they send,
and the ladder-signed ones are bounded by the clause's third predicate (shipped
in 0.24.0). This item lands separately, later, and must carry both exceptions
below when it does. Its regression bar is therefore the live wallet traffic, not
only the spec's table: the freewallet e2e suite is the check.

The second exception, the delegated collection PUT (freewallet FW-400 W2, R3). A
transient session holds no root authority by construction: every request it
makes rides the generation delegation, whose `invocationTarget` is the Space's
items subtree. Three of its writers configure or create a collection through
that delegation: the unlock-methods registry write, the generation collection
create during an annex genesis or mend, and App Connect collection provisioning.
Enforcement built from this item's original text refuses all three, which breaks
the transient login itself on any account needing a mend. Those writers have no
migration target, so the rule carves them out instead. The container rule's
hazard is a data grant whose `invocationTarget` IS the container URL; a
Space-subtree parent is not that grant, and a capability targeting the
collection container URL directly stays refused.

WASS-2's rationale is the prefix hazard: a data grant's `invocationTarget` IS
the container URL, so no attenuation rule separates deleting a resource under a
collection from deleting the collection itself. A capability whose whole action
set is `['DELETE']` is not a data grant, which is why the exception is keyed on
the exact action set rather than on the Space's kind or its controller's DID
method. The root-only rule stands unchanged for `PUT /space/{id}` and for both
collection container methods. The ladder-signed case is additionally bounded by
the client-annex clause's third predicate (FW-400 W3, target-exact against the
parent capability's own `invocationTarget`, admitting exactly `['DELETE']` and
exactly `['GET']`), which lands with WAS-67's narrowing of predicate 1.

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

---
