# WAS Teaching Server Roadmap -- archived (completed) items

Completed items from [ROADMAP.md](../ROADMAP.md), moved here verbatim when they
ship so that item-number references (WAS-N) in the active roadmap, commit
messages, and design docs keep resolving. Append-only: newest at the bottom; do
not rewrite or summarize items on the way in. Ids remain permanent and are never
reused. CHANGELOG.md stays the record of _what_ landed; this file preserves each
item's acceptance criteria and context.

Items completed before this archive existed (2026-07-23) were dropped outright
and live only in git history of ROADMAP.md.

---

### WAS-38: Conformance tests for the delegated Create Space failure shapes

- status: done
- done: 2026-08-06
- priority: medium
- labels: authz, conformance-suite
- acceptance:
  - [x] Chain rooted in a different DID than the body's controller: 400,
        `controller-mismatch`, Space not created
  - [x] Expired delegation (proof backdated via ezcap's `now` override, past the
        verifier's clock-skew tolerance): 400, `controller-mismatch`, Space not
        created
  - [x] Tampered delegation proof: 400, `controller-mismatch`, Space not created
  - [x] Optional-tier test: the three responses' `detail` strings are pairwise
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

### WAS-51: Reconcile the `encryption.version` descriptor text with the implementation

- status: done
- done: 2026-08-09
- priority: medium
- labels: spec-side, encryption
- acceptance:
  - [x] The Collection Data Model descriptor definition and the implementation
        agree on `version`'s type and optionality (spec today: a required
        string, e.g. `"0.1"`; server: an optional positive integer)
  - [x] The error surface for a version transition is reconciled: the spec today
        folds any `version` change or removal into 409 `encryption-immutable`,
        while the server allows increases (a future scheme migration) and
        rejects decreases/removals with 400 `invalid-request-body`
        (`#/encryption/version`) -- amend one side and update the error-registry
        row to match
  - [x] The server rejects an unrecognized `version` of a recognized scheme with
        `unsupported-encryption-scheme`, per the spec's
        accept-only-what-you-enforce SHOULD (registry defines only `edv`/`1`;
        the server today accepts any positive integer)
  - [x] Conformance coverage for the reconciled version-transition behavior
        added (deliberately left out of WAS-43 because of this divergence)

Discovered while implementing WAS-43 (discovered-from: WAS-43). Touches the same
descriptor text WAS-33 extends (the scheme-version registry column and the
never-backwards rail), so the two should land as one spec edit.

Spec update 2026-08: the spec side has moved and made the calls. `version` is
now an optional positive integer (absent means `1`), matching the server --
first criterion met. On the error surface the spec kept 409
`encryption-immutable` for a decrease or removal (its error-registry row now
says so explicitly), so the remaining reconciliation is server-side: swap the
400 `invalid-request-body` throws in `assertEncryptionVersionTransition`
(`src/lib/encryption.ts`) for `EncryptionImmutableError`, then add the
conformance coverage.

Resolution 2026-08-09: server-side reconciliation landed. Version decreases and
removals now throw `encryption-immutable` (409, pointer `#/encryption/version`);
the registry entry pins recognized `versions` per scheme (`edv`: 1) and an
unrecognized version of a recognized scheme is rejected with
`unsupported-encryption-scheme` (400, pointer `#/encryption/version`).
Conformance coverage added in `@interop/was-conformance-suite` 0.4.3
(`encryption.version-*`, six tests incl. one optional-tier).

### WAS-34: Spec the `epochsMac` authenticated epoch configuration

- status: retired
- priority: medium
- labels: spec-side, encryption
- retired: 2026-08-12
- acceptance:
  - [ ] The descriptor member `epochsMac: { v: 1, alg: "HS256", mac }` and its
        MAC/HKDF construction defined
  - [ ] The whole-config replay limitation owned in the text

Shipped in the client stack, 2026-07-20; the server stores it opaquely. The spec
should define: an HMAC-SHA256 over
`"was-epoch-config/v1." + JSON.stringify({ scheme, version, currentEpoch, epochs })`
(epoch ids in descriptor order, `version` null when absent), keyed via
HKDF-SHA256 from the current epoch's 32-byte secret with info
`"was-epoch-config-mac/v1"` -- a key the server never holds. Writers verify it
before encrypting, so a server that points `currentEpoch` back at an epoch a
revoked reader still holds fails to authenticate. The text must also own the
limitation: a replay of an _entire_ old consistent configuration (old list plus
its old MAC) is only detectable with client-side monotonic state, out of scope
for the descriptor itself. Pairs with the layered-revocation item (WAS-30).

Retired 2026-08-12: `epochsMac` was removed stack-wide in was-client 0.32.0 --
on a log-governed descriptor its coverage is a strict subset of log-chain
verification (the entry proof covers the full epoch configuration), so there is
no mechanism left to spec. The construction above is preserved verbatim as the
historical record.

### WAS-55: Collection-level metadata endpoints (`/space/{s}/{c}/meta`)

- status: done
- done: 2026-08-12
- priority: medium
- labels: http-api, data-model, encryption
- touches:
  - wallet-attached-storage-spec -- normative text tracked as WASS-9 in that
    repo's `_spec/ROADMAP.md` (done, moved to archive)
  - was-teaching-server -- routes, both backends, `metaVersion` validators,
    server tests + conformance-suite coverage (done; suite tests published in
    `@interop/was-conformance-suite` 0.5.0)
  - was-client -- consumer, tracked as WCL-8 in that repo's ROADMAP.md (done)
- acceptance:
  - [x] `GET`/`PUT` `/space/{space_id}/{collection_id}/meta` mirroring the
        Resource metadata operations: server-managed members plus user-writable
        `custom`, full-replacement PUT
  - [x] An independent `metaVersion` ETag with the same conditional-request
        semantics as the Resource `/meta` one
  - [x] The reserved-segment collision behavior for a Resource whose id is
        `meta` matches the Resource-level rule
  - [x] Filesystem + postgres backends, storage-backend contract tests, and
        conformance-suite coverage (suite tests land in
        `@interop/was-conformance-suite` 0.5.0, pending publish)

The server half of WASS-9 (see that item for motivation and the rejected
blind-derived-id alternative): was-client's WCL-1 persists the blinded-index
schema in this envelope, and encrypted Collections gain client-encrypted
name/tags. The Resource-level `/meta` machinery (validators, full-replacement
semantics, encrypted-`custom` passthrough) is the template.

### WAS-56: Codec-path blinded-index conformance coverage + Reverse-gap cross-link

- status: done
- done: 2026-08-12
- priority: medium
- labels: tests, conformance-suite, encryption, query
- touches:
  - "@interop/was-conformance-suite" -- the `blinded-index-api` suite gains the
    codec-path cases (suite-side items are tracked here per convention, like
    WAS-38) (done; three codec-path tests land in 0.6.0, pending publish)
  - was-teaching-server ROADMAP.md -- the Reverse gaps section gains the
    blinded-index cross-link (second acceptance box) (done 2026-08-12)
- acceptance:
  - [x] The conformance suite exercises blinded-index queries against envelopes
        produced by the was-client codec path (`createEdvEncryption` +
        `Collection.declareIndex()` / `find()`): codec-written `indexed` entries
        match on the server and `find()` round-trips, including a `unique`
        conflict case. Today the `blinded-index-api` suite seeds documents by
        direct PUT of hand-built envelopes only, so nothing proves the two
        writers produce server-matchable tokens for the same content.
        (2026-08-12: `codec path` group in `blinded-index-api` -- equals
        round-trip, has + count, unique 409 conflict -- 183/183 conformant
        against this server)
  - [x] The Reverse gaps section cross-links the blinded-index envelope and
        descriptor semantics the server already serves (the `hmac` member,
        `indexed` entries, persisted index schema) to their spec home, ECS-2 in
        the encrypted-collections spec roadmap -- the WAS spec's Query Profile
        Registry covers only the `/query` wire shape. (2026-08-12)

Follow-on from was-client WCL-1 (codec-path content search, client side shipped
in was-client 0.35.x): the server's `blinded-index-query` matches `indexed`
entries regardless of who wrote them, but conformance coverage never writes
through the codec path, and the spec-side envelope semantics live in the
encrypted-collections spec, which this ROADMAP's Reverse gaps section does not
yet point at.

### WAS-29: Spec the key-epochs surface (`epoch` feed member, descriptor/stamp rails)

- status: done
- done: 2026-08-20
- priority: medium
- labels: spec-side, encryption
- acceptance:
  - [x] The optional `epoch` member added to the `changes` profile registry
        entry (or `key-epochs` documented as an extension)
  - [x] The descriptor/stamp surface (`encryption.epochs` / `currentEpoch`
        rails, `Key-Epoch` Resource stamp) covered

The `changes` profile's registry entry omits the `epoch` member the server emits
on feed documents (the `key-epochs` stamp, carried so a replicating reader picks
the right epoch key without a `/meta` fetch per Resource) -- and more broadly
the served key-epochs surface is unspecified: the EDV-over-WAS appendix
currently declares epoch bookkeeping deliberately client-side.

Closed 2026-08-20 by the roadmap reconciliation: the spec now carries `epoch` in
item summaries (mirroring the Resource Metadata property), the `Key-Epoch`
header and `epoch` stamping, and the Key Epochs section with its server
validation and epoch-stamping text; nothing remains unspecified.

### WAS-32: Spec the `was` envelope-binding protected-header parameter

- status: done
- done: 2026-08-20
- priority: medium
- labels: spec-side, encryption
- acceptance:
  - [x] The private JWE protected-header member `was: { v, resource?, epoch? }`
        specified in the EDV-over-WAS appendix
  - [x] The rules carried into the text: `resource` omitted for content-derived
        ids, pre-binding vintage accepted, `v` greater than supported is a
        refusal
  - [x] The metadata (`custom`) envelope's `{ v, resource }` binding covered

Shipped in the client stack, 2026-07-20. Writers now emit and readers verify
this member -- the scheme version, the resource id the envelope was written
under, and the key-epoch id, all AEAD-covered by the JWE, so a server-side
envelope swap between ids, an epoch relabel, or a per-envelope scheme downgrade
fails on decrypt.

Closed 2026-08-20 by the roadmap reconciliation: the Encrypted Collections spec
defines the binding (`#was-binding`, `#binding-verification`, `#content-ids`),
including the metadata envelope's binding and the greater-than-version refusal.
The "pre-binding vintage accepted" rule no longer applies: the profile admits no
unbound envelope.

### WAS-33: Spec the `encryption.version` descriptor member

- status: done
- done: 2026-08-20
- priority: medium
- labels: spec-side, encryption
- acceptance:
  - [x] The Encryption Scheme Registry gains a scheme-version column
  - [ ] Migration guidance written: only key-wrap material is rewritten, never
        ciphertext bodies (the rewrap path), with the cached-CEK caveat
  - [x] The never-backwards rail documented (once set, never decreases, never
        removed)

Spec update 2026-08: the Encryption Scheme Registry now carries a `version`
column (`edv`/`1`) and the descriptor text documents the set-once,
version-monotonic rail (absent `version` means `1`; raising permitted). Only the
rewrap migration guidance (with the cached-CEK caveat) remains unwritten.

The server now validates an optional positive-integer `version` on the
`encryption` descriptor and enforces that, once set, it never decreases and is
never removed (the same never-backwards rail as `currentEpoch`); clients stamp
`version: 1` when declaring epochs. The per-resource-CEK-under-epoch-key layout
means moving a Resource to a new epoch only rewraps the JWE `recipients` --
which suggests a future client-driven bulk **rewrap** operation as a cheap
post-removal migration (honest caveat: rewrapping does not help against a reader
that cached the CEKs themselves).

Closed on the server side 2026-08-20: the registry column and the
never-backwards text shipped in the spec; the remaining rewrap migration
guidance is Encrypted Collections territory and was re-homed as ECS-5 in that
spec's roadmap.

### WAS-72: Admit `capabilityDelegation` members as root invokers of a did:webvh-controlled Space's DELETE

- status: retired
- priority: high
- labels: security, zcap, authorization, client-annex
- retired: 2026-09-01
- discovered-from: freewallet FW-400 design pass v3 (2026-08-31)
- touches:
  - `src/requests/SpaceRequest.ts:504-520` -- the Delete Space handler's
    `fetchSpaceAndVerify` call, the one site the rule fires at
  - `src/zcap.ts` `webvhVerifier` and `src/lib/webvhController.ts`
    `dereferenceFragment` -- where the relation check lives, shared with WAS-71
  - `test/` -- the admission and refusal matrix below
  - `ARCHITECTURE.md` -- the current-key-set rule's prose
  - the spec's authorization profile (W2, co-designed as WASS-2)
  - wallet-core `decisions/0004` -- amended wallet-side
- acceptance:
  - [ ] The rule fires in the Space DELETE handler and nowhere else
  - [ ] A root-capability invocation signed by a `capabilityDelegation` member
        of the resolved controller document is admitted: on the account Space
        and on the auxiliary annex Space of that account. An unlock Space is out
        of reach by construction, since its controller is its own did:key rather
        than the account did:webvh (corrected 2026-08-31 with FW-400 v4)
  - [ ] The same verification method is refused on a resource DELETE, on a
        collection DELETE, and on `PUT /space/{id}`
  - [ ] A verification method belonging to another did:webvh's document is
        refused, as is a signing key absent from the document
  - [ ] Existing `capabilityInvocation` root DELETE behavior is unchanged
  - [ ] A delegated capability still cannot authorize a Space DELETE (WASS-2)
  - [ ] The log is resolved and fully verified out of the Space being deleted
        before the delete runs, and the caches are busted after
  - [ ] Lands together with WAS-71
  - [ ] A minimum-version note in CHANGELOG.md

Context: freewallet's transient wallet must delete its own account and every
Space that account owns, holding nothing but a standing unlock credential. What
such a visit has is the credential's ladder verification method, published under
`assertionMethod` and `capabilityDelegation`. It has no enrolled client, so it
holds no `capabilityInvocation` method anywhere in the account document.

The first design mechanism was a ladder-signed DELETE delegation on the bare
Space URL, and it was rejected. A capability naming a bare Space URL attenuates
over every path beneath it, so the delegation is far wider than the one verb it
was minted for, and WASS-2 forbids a delegated container DELETE outright. Direct
root invocation avoids both: nothing is minted, nothing is stored, and the
authorization ends with the request.

Why plain membership rather than a ladder-VM sub-clause. Every
`capabilityDelegation` member of an account document is one of two things: an
enrolled client, which already root-invokes today, or a ladder verification
method of a standing unlock credential. Both are the account's own authority by
construction, so a sub-clause would restate the membership test in narrower
words with no security gained. (The freewallet design's Q1 reopens this on one
ground the census misses: a retired credential whose ladder strike went
unattributed leaves a verification method under `capabilityDelegation` that this
rule would still admit.)

Note 2026-08-31 (freewallet FW-400 v4). The v3 design assumed unlock Spaces
would be promoted to the account did:webvh, which would have put them inside
this rule. That structure was withdrawn. An unlock Space keeps its own did:key
controller, so this rule reaches the account Space and the auxiliary annex
Space(s) only. The sibling unlock Spaces are deleted through a ladder-signed
child of the management capability the unlock did:key already delegated to the
account, which needs two other server changes rather than this one: an explicit
client-annex clause predicate for that child (landing beside WAS-67's narrowing
of predicate 1), and WAS-60's enforcement carrying the spec exception for an
exact-target, exactly-`['DELETE']` delegated capability. Approved by the
maintainer 2026-08-31, with the clause predicate admitting two exact action
sets: `['DELETE']` for the delete itself, and `['GET']` for the Space
Description read the deletion walk probes existence with. Both are target-exact
against the parent capability's own `invocationTarget`.

Retired 2026-09-01 (freewallet FW-400 v5). W1, the mechanism this item was the
server half of, was withdrawn by the maintainer, and the design now deletes
every Space of the account through a ladder-VM-signed delegation invoked by the
visit's annex key. That shape works on today's server with no server change, so
the item closes rather than shipping.

Three measurements against main @ `6bd3e3f`, 2026-09-01, by in-process probes
over `startTestServer` from `test/helpers.js` (the probes are not committed),
settle why. The membership rule this item was thought to formalize is not a
formalization but a net widening: root invocation already enforces
`capabilityInvocation` (`webvhVerifier` restates `controller: did` on the
reconstructed method at `src/zcap.ts:276`, routing jsigs'
`ControllerProofPurpose` to the resolved document), so a ladder VM's root
invocation is refused today -- 404 on both `GET` and `DELETE`, against 200 / 204
for a `capabilityInvocation` member. See the re-scoped WAS-71 for the full
matrix. The delegated shape needs no rule at all: a `['DELETE']` delegation on a
bare Space URL, invoked by its did:key delegatee, deleted the Space with a 204,
because `isRootInvocation` (`src/zcap.ts:334-340`) is called at two sites and
the Space DELETE handler is neither of them
(`src/requests/SpaceRequest.ts:489-520` calls only `fetchSpaceAndVerify`). And a
root invocation would have sat outside the client-annex clause entirely, since
the chain inspector skips index 0 (`src/lib/clientAnnexClause.ts:453-457`),
where a delegation is inspected and can be bounded.

The obligations move rather than vanish. WAS-60 must land carrying the exception
for an exact-target, exactly-`['DELETE']` delegated Space DELETE (FW-400 W2), or
it breaks every deletion the ceremony sends. The client-annex clause gains the
third predicate that bounds the ladder-signed case (FW-400 W3), landing with
WAS-67's narrowing of predicate 1. The context above is preserved verbatim as
the historical record, including its rejection of the delegated shape, which the
v5 measurements reverse.
