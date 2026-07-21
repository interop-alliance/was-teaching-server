# WAS Teaching Server Roadmap (spec gap analysis)

Status as of 2026-07-20. Produced by comparing `spec.md` (in the
[w3c-ccg/wallet-attached-storage-spec](https://github.com/w3c-ccg/wallet-attached-storage-spec)
repo, as of commit `fa1293a`) against the `was-teaching-server` source
(`src/routes.ts`, `src/requests/*`, `src/errors.ts`, `src/policy.ts`,
`src/zcap.ts`, `src/backends/{filesystem,postgres}.ts`). The problem-type
registry and the shared WAS wire model now live in `@interop/storage-core`.

Scope: features the **spec defines that the server does not yet implement** (or
implements with deviations). A short reverse list (server features the spec does
not yet describe) is at the end, since those are spec-side work.

This document tracks only the **remaining** gaps; completed items are dropped as
they land (the shipped feature set is recorded in CHANGELOG.md, and earlier
revisions of this doc carried the full inventory). The server implements the
whole core protocol surface -- CRUD at all three levels, listings with cursor
pagination, policies, linksets, quotas/backends reads, metadata, export/import,
conditional writes, key epochs, both `POST .../query` profiles, chunk
addressing, zcap revocation, and the full error-type registry.

Legend: `[ ]` not implemented, `[~]` partially implemented / deviates.

---

## Backends: external (BYOS) + encryption feature

Designed in detail in the Google Drive BYOS plan (a Google Drive
`managedBy: external` "Bring Your Own Storage" backend, plaintext and
EDV-encrypted, with encryption as a backend **feature**). That plan's staged
work plan is the authoritative sequencing; stages 1-3 have fully shipped (the
EDV-over-WAS client profile, registration + the per-Collection resolver, the
`features` vocabulary, and all four EDV server affordances -- `chunked-streams`
was the last token, landed 2026-07-19). Remaining, in order:

- [ ] **Google OAuth client + consent setup** (plan stage 4). Register the WAS
      server as a Google **confidential OAuth client** (server config:
      `client_id` / `client_secret` / `redirect_uri`); consent screen on the
      non-sensitive tier only (`drive.file` + `openid email` -- never the
      restricted scopes, which force an annual CASA audit, and not
      `drive.appdata`); wire the PKCE authorization-code exchange (wallet
      obtains the one-time code against the server's client; server exchanges
      and stores the refresh token). This is also where the **connection
      lifecycle** gap left open by stage 2 closes: `connection.status` never
      advances past `registered` today -- the exchange moves it to `connected`,
      and `invalid_grant` on refresh flips it to `revoked`/`expired`
      (deregistration should revoke the token at Google, not just forget it).
      Open sub-decision to settle here: **secret-at-rest custody for refresh
      tokens** (server master key vs. the WebKMS substrate; rotation) --
      distinct from EDV client keys, which the server never holds. Prerequisite
      for the two adapter stages below.

- [ ] **Google Drive plaintext adapter** (plan stage 5) --
      `GoogleDriveBackend implements StorageBackend`: OAuth token custody +
      refresh, the folder-mirror layout, the memoized path→id index (persisted
      as an in-tree `.index.json`; rebuildable from `files.list` +
      `appProperties` -- the index-authority choice, manifest-in-Drive vs. the
      server's `default` backend, is still open), resumable uploads, `about.get`
      quotas, backoff with jitter. v1 targets personal / My Drive only (one code
      path covers consumer and Workspace personal storage).

- [ ] **Google Drive EDV flavor** (plan stage 6) -- the same adapter advertising
      the EDV feature set: JWE documents as opaque files, chunk subfolders,
      blinded attributes in `appProperties` for natively-served blinded-index
      `/query`, and server-side `sequence` enforcement (Drive has no atomic
      compare-and-set; the per-resource mutex is single-instance only,
      horizontal scaling documented as out of scope). Which metadata-leakage
      mitigations are worth their cost (size padding, keeping blinded attributes
      off `appProperties` to deny Google the equality classes) is an open
      question to settle here, along with what to upstream into the spec's
      privacy-considerations text.

- [ ] **Drive API ToS use-case clearance** (before scaling past the
      teaching/prototype tier). The "backup of app content to Drive" and "Drive
      as a CDN" prohibited-use clauses are a genuine gray area for BYOS; frame
      WAS in any OAuth verification as _primary, user-driven storage_ (never a
      backup target), and decide whether to seek Google's written consent. A
      legal/policy item, not a technical one.

## Data model gaps

- [ ] **Resource `id` supplied on POST create**. `CollectionRequest.post` always
      generates a uuid and ignores any client-chosen id. The spec's Create
      Resource error list (`reserved-id`, `id-conflict` for "the supplied
      Resource `id`") implies a client can supply one, and its POST example
      narrates "since no Resource id was specified, the server auto-generated an
      id" -- but the Resource section never states the _mechanism_.

  The spec defines it only for **Collections**: "When a Collection is created
  via a `POST`, the client can specify the `id` of the Collection. If the `id`
  is not specified, one is auto-generated." The Resource POST section leans on
  that convention without restating it. A body `id` property works for a
  Collection Description, whose body is a JSON object the server owns the schema
  of; it does not generalize to a Resource, whose POST body **is** the stored
  content and may be an opaque binary blob. There is no `Slug` header in the
  spec (grepped: zero hits). So this is a spec ambiguity before it is a server
  gap. Implement only once the spec nails a content-type-independent mechanism.

- [ ] **Provenance is unauthenticated across export/import** (server DID +
      signed provenance; raised 2026-07-09, while implementing server-managed
      `createdBy`).

  _The gap._ The server records a server-managed `createdBy` (the DID of whoever
  created a Space, Collection, or Resource) and refuses to let a client set it:
  every live write path strips a `createdBy` carried in a request body and
  substitutes the verified invoker's DID. Within a running server that property
  holds. It does not survive **export/import**. An exported archive is a plain
  tar of the on-disk representation: `.meta.<id>.json` sidecars,
  `.space.<id>.json` and `.collection.<id>.json` description documents, and
  resource bodies. On import the server reads `createdBy` straight out of those
  files and persists it. Nothing authenticates them. So:

  - A hand-crafted archive can attribute any Resource to any DID. The importer
    only needs write access to a Space of its own.
  - Round-tripping through export/import launders provenance: the value that
    comes back out is whatever the archive said, not what any server ever
    observed.
  - The same is true of `createdAt` and the monotonic `version`. `createdBy` is
    simply the first field where the forgery is _interesting_, because it names
    a party rather than describing a byte range.

  Import cannot fix this by validating harder. Import must preserve `createdBy`
  -- that is what makes a backup a backup -- so it necessarily trusts the
  archive. Refusing to import a `createdBy` would break restore; accepting it
  means accepting whatever the file says. The trust has to come from somewhere
  else.

  _The shape of a fix._ Give the **server its own DID and signing key**,
  distinct from any Space controller, and have it sign the metadata it claims
  authorship of:

  - On write (or at least on export), the server signs each `.meta.<id>.json`
    sidecar and each Space/Collection Description, over a canonical
    serialization that covers the server-managed fields (`createdBy`,
    `createdAt`, `version`, `metaVersion`) and the resource content digest.
  - On import, the server verifies the signature. An archive whose provenance
    was signed by a server DID the importer trusts keeps its `createdBy`; one
    that was not, or that fails verification, is imported with `createdBy`
    **dropped** (absent = "not recorded", the semantics already defined) rather
    than rejected. That degrades cleanly: a hand-rolled archive still imports,
    it just carries no attribution it did not earn.
  - Cross-server import then becomes meaningful: `createdBy` from server B is
    worth something to server A exactly insofar as A trusts B's DID.

  This turns `createdBy` from a value the current server happens to remember
  into a statement some named server actually made -- a verifiable credential
  about a storage event, in effect.

  _Open questions._

  - **Key custody and rotation.** Where does the server key live? The `/kms`
    facet already exists (WebKMS keystores, key records encrypted at rest under
    a KEK). Is the server's own signing key just another keystore entry, or does
    that invert a dependency (the KMS is a facet _of_ the server)?
  - **Rotation vs. old archives.** An archive signed under a retired key must
    stay verifiable, so the server DID needs a DID document with key history,
    which `did:key` cannot express. That argues for `did:web` or `did:tdw` for
    the _server_, even though `did:key` remains right for controllers.
  - **Sign on write, or only on export?** Signing every sidecar write puts an
    Ed25519 signature on the hot path of every resource write. Signing only at
    export is cheap but means the server is attesting at export time to facts it
    recorded earlier and did not itself authenticate -- which is fine if the
    store is trusted, and is exactly the assumption an operator already makes.
  - **What is signed?** Sidecars alone leave the content unbound; binding the
    content digest makes the signature an integrity check on the Resource too,
    which starts to overlap with the export manifest's role.
  - **Spec status.** The spec now defines `createdBy` on the Space, Collection,
    and Resource Metadata data models (OPTIONAL, server-managed, read-only: "a
    server MUST ignore a `createdBy` supplied in a request body"). What it does
    NOT define is any way to _authenticate_ that claim once the data leaves the
    server, nor a server DID to anchor it -- which is exactly this gap. Worth
    checking against the Keyhive research notes -- a signed-provenance envelope
    is close to what "concap" ops carry, and there may be no reason to invent a
    bespoke format.

  _Related._ `createdBy` implementation: `invokerDid()` in
  `src/auth-header-hooks.ts`; the strip-and-apply in `writeSpace` /
  `writeCollection` / `_writeResourceLocked` (both backends). The import path
  that trusts the archive: `importSpace` in `src/backends/filesystem.ts` (writes
  descriptions and sidecars raw) and in `src/backends/postgres.ts` (routes
  through `_upsertCollection`, still trusting the archived value).

## Authorization profile

- [ ] Minor follow-up (SHOULD): the spec explicitly folds _all_ delegated
      verification failures (chain rooted elsewhere, expired delegation, failed
      proof) into `controller-mismatch` -- which is what the server does -- but
      adds a SHOULD, stated both in Create Space Errors and again in the error
      registry, to differentiate the cause in the non-normative `detail` string
      where the server can tell, "in a delegated provisioning flow, the cause
      determines who must act". The server returns a fixed catch-all detail on
      both failure paths (`UnauthorizedError`'s 404 mask, and
      `AuthVerificationError`'s "Error verifying authorization headers." -- the
      cause is attached but never surfaced), because the chain verifier reports
      failure opaquely. Differentiating would take static pre-triage of the
      submitted chain (check the base delegation proof's signer against
      `body.controller`, and the zcap's `expires`) before full verification.

---

## Upstream Issues to Open

- [ ] **Open two upstream issues at Digital Bazaar** describing the AEAD gaps
      the `@interop` forks of `minimal-cipher` and `edv-client` fixed on
      2026-07-20 (extra authenticated protected-header params, per-chunk stream
      AAD, authenticated stream chunk count), so the fixes can be offered back
      rather than living only in the forks. Draft issue text below, ready to
      paste (trim the fork references if filing before the forks are published).

  **`digitalbazaar/minimal-cipher` -- "Stream chunks share one AAD: reorder /
  substitution within a stream is undetectable; support per-chunk AAD and
  caller-supplied protected-header params"**

  > In stream mode (`createEncryptStream`), every chunk is emitted as a JWE that
  > shares the same content-encryption key and the same additional authenticated
  > data -- the ASCII bytes of the one encoded protected header. Because neither
  > the chunk index nor any per-chunk context is authenticated, a storage
  > provider can reorder chunks within a stream, or substitute one of the
  > stream's chunks for another, and `createDecryptStream` decrypts the result
  > without error. (Cross-stream transplants are already blocked by the
  > per-stream random CEK; truncation is a separate issue -- see the companion
  > edv-client issue.)
  >
  > Proposal (implemented in the `@interop/minimal-cipher` fork; happy to send a
  > PR): an opt-in `chunkedAad` option on
  > `createEncryptStream`/`createEncryptTransformer` that (a) adds a version
  > marker (`caad: 1`) to the protected header and (b) makes each chunk's AAD
  > `encodedProtectedHeader || 0x2E || uint64-BE chunk index`. The decrypt
  > transformer keeps a running index and switches AAD construction on the
  > header marker, so legacy streams keep decrypting and tampered new streams
  > fail the tag. This is the same move as Cryptomator's file-content scheme
  > (AAD = chunk number || header nonce).
  >
  > Related enabler: `encrypt`/`encryptObject`/`createEncryptStream` could
  > accept `additionalProtectedParams`, merged into the protected header
  > (rejecting reserved members like `enc`), so callers can AEAD-bind
  > application context -- document id, key epoch, scheme version -- and detect
  > ciphertext swapped between addresses by verifying the parsed header after
  > decrypt.

  **`digitalbazaar/edv-client` -- "`getStream` trusts the cleartext
  `doc.stream.chunks`: truncation of a chunked stream is undetectable"**

  > On write, the document's `stream` state (`{ sequence, chunks }`) is sealed
  > inside the JWE payload (`_encrypt` includes it in the encrypted object). But
  > `decrypt()` rebuilds the returned doc as
  > `{ ...encryptedDoc, content, meta }`, discarding the decrypted `stream`
  > member and keeping the **cleartext envelope copy** -- and `getStream()`
  > reads `doc.stream.chunks` from that unauthenticated copy to decide how many
  > chunks to fetch. A malicious or compromised EDV server can lower the
  > cleartext `chunks` (truncating the stream, e.g. cutting a file's tail off)
  > and the read completes without error, even though an authenticated count
  > exists inside the envelope.
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

- [~] **Space-level `/query`** -- the _Collection_-level `POST .../query` is
  implemented (both the `changes` and `blinded-index` profiles, now specified in
  the spec's Query Profile Registry appendix). The Space-level
  `POST /space/{id}/query` remains _reserved_ in the spec -- "Cross-collection
  queries (backend-specific)" -- with nothing to implement yet.

- [ ] **RxDB sync follow-ons** (the MVP -- tombstones, `changesSince`, the
      `changes` query profile, and the freewallet browser adapter -- all
      shipped; the wire contract is normative in the spec's Query Profile
      Registry appendix
  - Conditional Requests section). Deferred from that plan: (a) _live
    `pull.stream$`_ -- an SSE endpoint emitting `{ documents, checkpoint }`
    batches so clients need not poll (filesystem backend poll-diffs; Postgres
    uses `LISTEN/NOTIFY`); (b) _tombstone GC / retention policy_ -- tombstones
    currently accumulate forever; policy must say how long one outlives the
    slowest client; (c) _attachment / blob replication_ -- its own
    size/streaming design, tied to the chunked-streams and EDV-chunking work.

- [ ] **Client-produced snapshot/checkpoint entries in the changes feed**
      (keyhive item 3). A ciphertext-only server cannot compact or snapshot an
      encrypted Collection's history -- compaction must be a _client_ operation
      the protocol accommodates, e.g. a client-produced snapshot/checkpoint
      entry type in the changes feed that supersedes earlier entries. This is
      also the fix path for ciphertext rollback/freshness (a signed
      snapshot/manifest lets a reader detect a server serving stale state -- the
      gap Cryptomator leaves open after two audits, per the hardening notes
      above), and the compaction tier the linear `changesSince` feed currently
      lacks. Interlocks with the RxDB tombstone-GC follow-on: how long a
      tombstone must outlive the slowest client is really "how far back the
      newest checkpoint reaches".

- [ ] **Opaque/blinded Resource ids + padded sizes** (keyhive lesson 5). Even
      with EDV encryption the server sees structure: resource ids, sizes,
      timestamps, access patterns. Treat further blinding as named, opt-in work
      rather than an implicit property: client-chosen opaque ids (deterministic
      AES-SIV name encryption -- Cryptomator's filename scheme -- is the
      concrete lookup-preserving technique, per the hardening notes above) and
      padded / bucketed sizes. The blinded-index query profile already covers
      the _query_ axis; this item is the _namespace_ axis. Feeds the "server
      knowledge" spec section (reverse gaps): whatever stays visible should be
      listed there as a documented, deliberate residue.

- [ ] **BYOS beyond My-Drive OAuth** (deferred alternatives from the Google
      Drive BYOS plan, recorded so the v1 adapter doesn't foreclose them): (a)
      _Shared Drive support_ -- deliberately deferred; org-owned storage
      undercuts the BYOS trust model (admin can delete/transfer/lock, and org
      members with drive access can read plaintext bytes directly, bypassing WAS
      zcaps), and the API surface changes (`supportsAllDrives`, `corpora=drive`,
      per-file `capabilities`); revisit only on demand. (b) _Service account
      with domain-wide delegation_ -- an admin-driven registration flow for org
      rollouts, replacing per-user OAuth. (c) _Other providers_ -- the
      `provider`-keyed adapter + OAuth registration generalizes to Dropbox /
      OneDrive / S3-compatible; Google Drive is the first concrete `external`
      provider, not a special case.

- [ ] **npm-installable backends** (the remaining plugin-seam work from the
      backend-considerations comparison). The port is proven by two divergent
      adapters; what's missing to let a third party ship one: (1) _publish the
      port_ -- `StorageBackend` and its supporting types still live in
      `src/types.ts`, so an external backend cannot `implements StorageBackend`
      without depending on the whole server (move it into
      `@interop/storage-core`, or its own small package); (2) _a resolution
      convention_ -- e.g. `WAS_BACKEND=@scope/backend-postgres` dynamically
      imported in `start.ts`, each plugin exporting a `createBackend(config)`
      factory (distinct from `WAS_ENABLED_BACKENDS`, which allowlists registered
      _external_ backends, not the server's own adapter); (3) _a port-level
      conformance kit_ -- a reusable suite running the port contract against any
      backend so plugin authors can self-certify (the protocol-level
      `was-conformance-suite` tests the HTTP surface, not the port; the in-repo
      `test/` suites, which already run against an injected backend, are the
      seed). Open scoping question: ship the three together or piecemeal.

- [ ] **SQLite backend** -- the strongest candidate for a _next_ server-managed
      tier per the backend-considerations comparison: embedded-but-queryable and
      still inspectable (JSON1 + generated-column indexes, FTS5, `sqlite-vec`,
      one file a learner can open with the ubiquitous `sqlite3` CLI), with
      `node:sqlite` shipping in Node 24. LMDB is effectively superseded (port
      already proven twice, misaligned with the query roadmap, buffers blobs in
      RAM); FoundationDB stays a far-future hyperscale note.

- [ ] **Full-text / vector search** -- the still-future axis of the query
      roadmap: presumably new `POST .../query` profiles + `features` tokens per
      the established pattern (`tsvector`/GIN and `pgvector` on Postgres; FTS5
      and `sqlite-vec` if the SQLite tier lands). Open design question: how it
      interacts with the byte-exact vs. normalized-projection tension (the
      shipped profiles keep stored bytes exact and index write-time projections;
      search would ride the same path).

- [ ] **Composite adapter** -- one `StorageBackend` satisfied by several
      specialized stores (e.g. Postgres for metadata + `jsonb` query, S3-style
      object storage as the streaming blob tier, Redis as cache / vector index /
      live-notification layer), keeping the port single while the implementation
      spans stores. Open: whether the composition lives behind the port or above
      it. (Different axis from BYOS `managedBy: external`, which selects _whose_
      storage a Collection lives on, not how the server's own backend is
      composed.)

- [ ] **External KEK custody** behind the existing `recordKekLoader()` seam (HSM
      / cloud KMS). The KEK is process-resident today, so at-rest encryption
      defends against a disk dump and nothing more; an external custodian
      narrows that -- the process holds a handle rather than the key, and unwrap
      operations become auditable and revocable at the custodian. First cheap
      step, worth doing before any adapter exists: widen `recordKekLoader`'s
      return type to `RecordKek | Promise<RecordKek>`, since an external
      custodian needs an async loader (network fetch, with caching and a
      negative-cache policy for retired KEKs).

- [ ] **Sub-path-mounted `SERVER_URL` drops its base path in built URLs.** Every
      absolute-URL join goes through `new URL(<leading-slash path>, serverUrl)`,
      and `new URL('/space/x', 'https://host/was')` resolves to
      `https://host/space/x` -- the `/was` base path is dropped. This affects
      both the `Location` response headers (`CollectionRequest.post`,
      `SpaceRequest`, `BackendRequest`, `SpacesRepositoryRequest`) **and** the
      ZCap target derivation (`spaceContext.ts` `allowedTarget`, `zcap.ts`
      `fullRequestUrl`), so a server deployed under a path prefix would emit
      wrong `Location`s and reject every delegated write (the client's
      `invocationTarget` includes the base path, so it would no longer match ->
      404). Origin-root deployments (the default) are unaffected, so this is low
      priority. The path _builders_ in `src/lib/paths.ts` are correct (they
      return relative paths); the fix belongs at the join sites -- a
      `serverUrl`-rooted join helper that preserves the base path -- plus a
      sub-path `SERVER_URL` test fixture. Because it touches the ZCap match
      path, treat it as its own change. This is the server side of the same
      defect `was-client` fixed in its 2026-07 refactor (its finding #12).

- [ ] **Server-enforced JSON Schema per Collection.** The `equality` profile
      established the precedent and the code path for the server parsing JSON
      Resource content at write time, as an explicit per-Collection opt-in. A
      future optional `schema` Collection property (a JSON Schema the server
      validates content writes against, rejecting non-conforming bodies) would
      ride the same hook: declared on the Collection Description, applied in the
      same post-authorization write path, plaintext-JSON-only, mutually
      exclusive with `encryption` for the same reason. Worth speccing as its own
      registry or Collection-property section.

- [ ] **Equality-index extensions.** Follow-ons deliberately deferred from the
      v1 `equality` profile: (a) _compound indexes_ -- a declaration form such
      as `{ "names": ["parentId", "author"], "unique": true }` for efficient
      conjunction lookup and composite uniqueness claims, with zero changes to
      the query wire shape (an `equals` element with multiple pairs is already a
      compound query); (b) _custom-sourced indexes on encrypted Collections_ --
      permitting `custom`-only `indexes` on `encryption`-marked Collections
      (tags on encrypted photos), since `custom` metadata is server-visible
      plaintext regardless, with a pointed privacy warning; (c) _path-valued
      index names_ -- extending the `name` grammar to JSON Pointer for nested
      attributes.

---

## Reverse gaps (server features the spec does not yet describe)

Spec-side follow-ups noticed during the comparison; tracked here so the two
documents converge:

- `POST /space/{id}/import` is implemented (tar merge with FEP-6fcd manifest,
  `ImportStats` summary, `invalid-import` errors) but the spec defines no Import
  operation, and `import` is not in the Reserved Path Segment Registry (the
  `invalid-import` error type is registered, orphaned).
- ZCap revocation is presupposed but never specified: the spec calls the
  authorization profile "delegatable, revocable, secure, flexible" and its
  `controller-mismatch` privacy note names "capability revocation status" as
  provider-defined state, yet defines no revocation operation. The server
  follows the ezcap-express `/zcaps/revocations/` convention
  (`POST /space/{space_id}/zcaps/revocations/{revocation_id}`), which the spec
  should either adopt or replace.
- Export has no detailed spec section (format, manifest, response shape) -- the
  API summary and the Reserved Path Segment Registry both still mark
  `POST /space/{space_id}/export` "Reserved / not yet specified". The server's
  tar + manifest format is the de facto definition. When specifying it, also
  describe chunk entries neutrally in the export manifest
  (index/contentType/version): today the archive chunk layout is the filesystem
  backend's on-disk encoding (`chunkDirName` + `fileNameFor` + `.meta.<n>.json`
  sidecars), which the Postgres export synthesizes and any non-filesystem
  backend must emulate to interoperate.
- The `changes` profile's registry entry omits the `epoch` member the server
  emits on feed documents (the `key-epochs` stamp, carried so a replicating
  reader picks the right epoch key without a `/meta` fetch per Resource) -- and
  more broadly the served key-epochs surface (the `encryption.epochs` /
  `currentEpoch` marker rails, the `WAS-Key-Epoch` Resource stamp) is
  unspecified: the EDV-over-WAS appendix currently declares epoch bookkeeping
  deliberately client-side. Either add the optional `epoch` member (and the
  marker/stamp surface) to the spec, or document the server's `key-epochs`
  feature as an extension.
- **Layered-revocation security-considerations text** (keyhive item 4). The spec
  should state the two-layer revocation model explicitly: revoking a delegated
  zcap is _authorization_ revocation -- immediate and total at the server
  checkpoint -- while _cryptographic_ revocation for encrypted Collections
  additionally requires rotating the key epoch, because a revoked reader still
  holds the old epoch key and can decrypt anything already pulled (the server
  ships both halves: zcap revocation and key epochs). The same section should
  own the trust model: WAS deliberately verifies against one authoritative chain
  at request time, so the server _is_ the revocation checkpoint and offline /
  pure-P2P operation is out of scope -- an architectural advantage over
  coordination-free designs (cite Keyhive as the contrast). Pairs with the
  epoch-configuration-authentication hardening item above.
- The planned "server knowledge" section for encrypted Collections (keyhive
  item 1) should follow the Cryptomator threat-model documentation style:
  plainly enumerate what stays plaintext (resource ids, sizes, timestamps,
  `createdBy`, epoch ids and recipient `kid`s, changes-feed metadata, access
  patterns), what tampering is client-detectable (per-object AEAD), and what is
  an explicitly accepted risk (ciphertext rollback, listing truncation,
  plaintext-metadata forgery). Their security-target page is the template.
- **The `was` envelope-binding protected-header parameter** (shipped in the
  client stack, 2026-07-20). The EDV-over-WAS appendix should specify the
  private JWE protected-header member writers now emit and readers verify:
  `was: { v, resource?, epoch? }` -- the scheme version, the resource id the
  envelope was written under, and the key-epoch id, all AEAD-covered by the JWE,
  so a server-side envelope swap between ids, an epoch relabel, or a
  per-envelope scheme downgrade fails on decrypt. Rules to carry into the text:
  `resource` is omitted for content-derived ids (readers instead verify by
  re-deriving the id from the ciphertext); envelopes without the member are
  accepted as the pre-binding vintage; `v` greater than the reader's supported
  version is a refusal, not a fallback. The metadata (`custom`) envelope binds
  `{ v, resource }` the same way.
- **The `encryption.version` marker member.** The server now validates an
  optional positive-integer `version` on the `encryption` marker and enforces
  that, once set, it never decreases and is never removed (the same
  never-backwards rail as `currentEpoch`); clients stamp `version: 1` when
  declaring epochs. The Encryption Scheme Registry should gain a scheme-version
  column plus migration guidance: only key-wrap material is ever rewritten,
  never ciphertext bodies -- the per-resource-CEK-under-epoch-key layout means
  moving a Resource to a new epoch only rewraps the JWE `recipients` -- which
  suggests a future client-driven bulk **rewrap** operation as a cheap
  post-removal migration (honest caveat: rewrapping does not help against a
  reader that cached the CEKs themselves).
- **The `epochsMac` authenticated epoch configuration** (shipped in the client
  stack, 2026-07-20; the server stores it opaquely). The spec should define the
  marker member `epochsMac: { v: 1, alg: "HS256", mac }`: an HMAC-SHA256 over
  `"was-epoch-config/v1." + JSON.stringify({ scheme, version, currentEpoch, epochs })`
  (epoch ids in marker order, `version` null when absent), keyed via HKDF-SHA256
  from the current epoch's 32-byte secret with info `"was-epoch-config-mac/v1"`
  -- a key the server never holds. Writers verify it before encrypting, so a
  server that points `currentEpoch` back at an epoch a revoked reader still
  holds fails to authenticate. The text must also own the limitation: a replay
  of an _entire_ old consistent configuration (old list plus its old MAC) is
  only detectable with client-side monotonic state, out of scope for the marker
  itself. Pairs with the layered-revocation security-considerations item above.
- **The chunked-stream encryption profile** (shipped in the client stack,
  2026-07-20; chunks stay opaque to the server). The EDV-over-WAS chunked
  profile should adopt what stream writes now produce by default: the shared
  protected header carries `caad: 1` and each chunk's AEAD AAD becomes the
  encoded header concatenated with `0x2E` and the uint64 big-endian chunk index,
  defeating within-Resource chunk reordering and substitution (the per-stream
  random CEK already blocks cross-Resource transplants); and the stream state
  (`{ sequence, chunks }`) is sealed inside the document envelope, so readers
  take the chunk count from authenticated state and truncation to fewer chunks
  is detected. Legacy streams without the `caad` member remain readable; readers
  must be upgraded before writers when deploying.
