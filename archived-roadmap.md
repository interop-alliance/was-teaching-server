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

### WAS-67: Narrow the client-annex clause's first predicate to the account Space's items subtree

- status: done
- done: 2026-09-01
- priority: high
- labels: security, zcap, client-annex
- discovered-from: freewallet FW-356 design pass (2026-08-26), re-decided as
  blocking 2026-08-28 once FW-359 shipped
- touches:
  - `src/lib/clientAnnexClause.ts` -- the first admission predicate and the
    header comment's locked-property statement (shipped: the predicate gains the
    target and action bounds, the header comment is rewritten)
  - `test/client-annex-clause-api.test.ts` -- the admission cases (shipped: both
    directions covered)
  - `ARCHITECTURE.md:177-202` -- the only prose description of the clause
    (shipped: the Chain inspection text now describes two bounded shapes plus
    the target-exact one)
  - app-connect-spec `decisions/0003-ladder-authority-clauses.md` -- the
    normative home of the rule this predicate implements (shipped: predicate 1
    and the locked property amended in place, 2026-09-01)
  - wallet-core `decisions/0013` -- its Revisit Criteria 1 names this narrowing
    as a trigger, and `decisions/0004` states the wallet-side convention the
    narrowing would make enforced (shipped: 0004 records the narrowing as
    landed; 0013's criterion is not triggered, since the clause still skips a
    link whose proof method carries both relations)
- acceptance:
  - [x] The first predicate gains a target bound: a ladder-signed delegation
        whose grantee is the pointed annex DID is admitted only when its
        `invocationTarget` is within the account Space's items subtree -- the
        target a generation delegation already carries. A Space-level target,
        which reaches Update Space Description and so the Space's controller, is
        refused
  - [x] Keystore targets are refused by the same bound, stated explicitly rather
        than left to fall out of the subtree test
  - [x] The action bound is decided on the record: either the full verb set
        (matching what a generation delegation needs) or a narrower set, with
        the reason written down. Today the predicate reads no action at all
  - [x] Tests drive both directions: the generation-delegation shape stays
        admitted, and a ladder-signed delegation to the same grantee with a
        Space-level target is refused
  - [x] The header comment's locked-property paragraph is rewritten. It
        currently concedes that the first disjunct "is silent about what that
        key subsequently delegates" and names "target attenuation, the action
        limitations, and the parent's expiry" as the bound -- while the
        predicate itself applies no target attenuation
  - [x] `ARCHITECTURE.md:177-202` is updated to describe two bounded predicates
        rather than one bounded and one grantee-keyed
  - [x] A minimum-version note in CHANGELOG.md, since a wallet minting a wider
        ladder-signed delegation than the items subtree would start being
        refused. No shipped wallet does: freewallet's generation delegation
        targets exactly that subtree

Context: the clause admits a ladder-signed delegation under two disjuncts. The
second is exact -- a `PUT` on the signing DID's own account log, or `GET`/`PUT`
on the delegated-clients auxiliary Space in the trailing-slash form that
excludes Update Space Description -- and its stated safety property holds: all
the delegation can do is write a log, and the write is the record.

The first is bounded by grantee identity alone. It admits on sole-`controller`
equality against the account document's `#DelegatedClients` annex DID behind a
syntactic self-hosted-`did:webvh` gate, and returns before
`capability.invocationTarget` is ever read. So a ladder verification method may
delegate anything the account controls, the Space-level target included, so long
as the grantee is the pointed annex DID.

That was tolerable while the annex verification method held
`capabilityInvocation` only: whatever it received, it could exercise but not
pass on. Freewallet's FW-359 (2026-08-28, wallet-core `decisions/0013`) gave the
per-visit annex method `capabilityDelegation` beside `capabilityInvocation` so
that a transient session can mint App Connect grants. The chain is now root ->
ladder-signed delegation to the annex DID -> annex-signed grant to an arbitrary
third party, and this repo's own test pins that the third link is skipped by the
inspector ("a two-relation annex VM is outside the clause"). The onward step is
offline signing and leaves no entry in any log.

The clause's header comment was revised in the same change and states the
consequence honestly, but the predicate was not touched. What bounds those
onward grants today is a wallet-side convention -- freewallet scopes its
generation delegation to the items subtree -- rather than anything this server
enforces. This item moves that bound server-side.

Two things sharpen the priority. The exposure is live now on every
ladder-anchored account, which is most passphrase accounts on a wallet whose
default signup is credential-anchored. And freewallet FW-356 proposes to keep a
standing ladder verification method for the life of each unlock credential,
which would make the surface permanent and multiply it by the number of standing
credentials; that item's design records this narrowing as blocking its approval.

Superseding note 2026-09-01 (freewallet FW-400 v5). An earlier note here
described a third clause predicate for FW-400's account deletion, then withdrew
it: FW-400 v3 deleted each Space by direct root invocation, so the clause was
untouched and the replacement item was WAS-72. Both of those are now out of
date. WAS-72 is retired, and v5 deletes every Space of the account through a
delegation the ladder VM signs and the visit's annex key invokes. The third
predicate is back, and under v5 it is that design's only server change.

What it must admit: a ladder-signed delegation whose `invocationTarget` is a
bare Space URL and whose `allowedAction` is exactly `['DELETE']` (the delete) or
exactly `['GET']` (the Space Description read the deletion walk probes existence
with), target-exact against the parent's own `invocationTarget` when the parent
is delegated, and against the synthesized root's Space URL when it is not. It
covers all three Space kinds -- the account Space, the auxiliary annex Space(s),
and the sibling unlock Spaces. Predicate 1 admits those delegations target-blind
today (`src/lib/clientAnnexClause.ts:396-405`), which is exactly what this item
narrows, so the third predicate lands with the narrowing rather than after it.
The paired server obligation is WAS-60, which must carry the same exception on
the enforcement side.

Adjacent, not in scope: the clause is fail-open across implementations -- a
server running unmodified zcap verification accepts what this one refuses -- and
nothing is served that a client could read to learn the clause is enforced,
while the clause's own header says a wallet publishes a ladder verification
method only on a host advertising the profile. That standing contradiction is
freewallet FW-357's subject.

### WAS-71: Pin the root-invocation `capabilityInvocation` relation check

- status: done
- done: 2026-09-01
- priority: high
- labels: security, zcap, authorization, tests, docs
- discovered-from: freewallet FW-400 research pass (2026-08-31); re-scoped
  2026-09-01 once the suspected gap was measured and found not to exist
- touches:
  - `src/zcap.ts:253-285` -- `webvhVerifier`, where the check comes from: it
    makes no comparison of its own, it restates `controller: did` on the
    reconstructed method (`:276`), and that is what routes the purpose check to
    the resolved document (waived: no source change, the mechanism is pinned by
    a test rather than modified)
  - `src/lib/webvhController.ts:325-352` -- `dereferenceFragment`, reached
    through `webvhDidResolverDriver`, which serves the `did#fragment` node the
    proof-purpose comparison reads the relation out of (waived: no source
    change, the mechanism is documented rather than modified)
  - `test/` -- the regression test pinning the measured matrix (shipped:
    `test/root-invocation-relation.test.ts`)
  - ARCHITECTURE.md -- the current-key-set rule's description, which states the
    rule but not the mechanism that carries it on the invocation side (shipped:
    the entry now names the restated controller and the resolver driver)
- acceptance:
  - [x] A regression test pins the measured matrix on a promoted (did:webvh
        controlled) Space: a verification method listed under `assertionMethod`
        and `capabilityDelegation` only -- a ladder VM -- cannot root-invoke
        `GET` or `DELETE`, and neither can an `authentication`-only method; a
        `capabilityInvocation` member can do both, as can a method carrying all
        four relations
  - [x] The test asserts the refusal shape the server actually returns (404 at
        the route, from the maximum-privacy masking) and pins the underlying
        verifier message, so a silent widening in a jsigs or zcap upgrade fails
        the suite rather than passing quietly
  - [x] ARCHITECTURE.md's current-key-set paragraph names the mechanism on the
        invocation side: the restated `controller` plus the fragment-resolving
        driver route jsigs' `ControllerProofPurpose` to read the relation out of
        the resolved document, so root invocation and delegation proof are
        relation-scoped by the same code
  - [x] The bootstrap case is documented beside the test: requests that invoke
        as a bare did:key Space controller before promotion take the `did:key`
        branch, not the listed-VM lookup, so no relation applies to them

Filed on the suspicion that the root-invocation path did no relation check. The
suspicion is wrong, measured 2026-09-01 against main @ `6bd3e3f` by in-process
probes over `startTestServer` from `test/helpers.js` (the probe scripts are not
committed). `webvhVerifier` does look the keyId up by membership in the flat
`verificationMethod` array and compares no relation itself
(`src/zcap.ts:260-269`). But it restates `controller: did` on the verification
method it reconstructs (`src/zcap.ts:276`), and that routes jsigs'
`ControllerProofPurpose` to fetch the controller document and read
`capabilityInvocation` out of it. The relation check is therefore already
enforced on root invocations, by the same code as on the delegation-proof path.

The measured matrix, `GET` and `DELETE` on a promoted Space by root invocation:
all four relations -> 200 / 204; `capabilityInvocation` only -> 200 / 204;
`assertionMethod` plus `capabilityDelegation`, the ladder VM -> 404 / 404;
`authentication` only -> 404 / 404. The verifier's refusal reads
`Verification method ... not authorized by controller for proof purpose "capabilityInvocation"`.

So there is nothing to enforce and the item becomes two obligations. First a
regression test: the behavior is load-bearing for freewallet's FW-400, which
depends on a ladder VM being unable to root-invoke anything, and it rests on an
indirection (a restated `controller` string, resolved through the document
loader) that an unrelated refactor could drop without any local signal. Second a
wording fix, since this item's own premise text said the check "only runs on the
delegation-proof path" and that claim traveled into two design docs before it
was measured.

Note 2026-09-01. WAS-72 held the one designed exception to the membership check
this item was going to add. That item is retired: freewallet FW-400 v5 replaced
its mechanism with a delegation, so no exception is needed and nothing lands
with this item.

### WAS-74: CORS proxy response cache and upstream connection reuse

- status: done
- done: 2026-09-03
- priority: medium
- labels: performance, cors-proxy
- acceptance:
  - [x] A 2xx GET response relayed by `/api/cors` is served from an in-memory
        cache on a repeat request for the same URL within its TTL, taken from
        the upstream `Cache-Control` `max-age` when present and otherwise a
        short fixed default; non-2xx and non-GET responses are never cached
  - [x] The cache is bounded (LRU, capped entry count and per-entry size) so an
        open endpoint cannot grow it without limit
  - [x] A host validated by `checkProxyTarget` within a short window skips the
        DNS re-lookup, and the pinned undici `Agent` is reused across requests
        to the same pinned addresses rather than built and destroyed per
        request; the SSRF pinning guarantees are unchanged (a new pin set gets a
        new Agent)
  - [x] Tests in `test/` for the cache hit, the TTL expiry, the no-cache cases,
        and the Agent reuse

Context: the signup log fetched ten distinct issuer-registry URLs (five
registries, each a `.well-known/openid-federation` document and a `fetch?sub=`
document) five times each through the proxy. Every proxied request today does a
fresh DNS lookup, builds a new `Agent`, pays a full TLS handshake, and discards
it all in `finally` (`src/corsProxy.ts`). Federation metadata changes rarely, so
a short TTL removes most of that. The client side of the same pattern (the
wallet fetches the five well-known URLs twice back to back in one signup) is a
freewallet item, not this one.

### WAS-75: Cheap revalidation of cached did:webvh documents

- status: done
- done: 2026-09-03
- priority: low
- labels: performance, webvh
- acceptance:
  - [x] A cached verified document past its TTL is revalidated by comparing the
        log Resource's stored version (or an equivalent cheap validator) against
        the one it was verified from, and re-read and re-verified only when that
        differs; the TTL backstop for multi-process deployments is kept
  - [x] The per-verification `createDefaultDidResolver()` in
        `didResolverWithWebvh` (`src/zcap.ts`) is built once per storage backend
        (a `WeakMap`, like the two existing caches) rather than per request
  - [x] Tests in `test/`: a log rewrite past the TTL is picked up; an unchanged
        log past the TTL is not re-verified

Context: after promotion every verification resolves the account log, and an
annex-signed delegated invocation resolves the annex log as well. The cache in
`src/lib/webvhController.ts` has a 5 s TTL, so a ceremony longer than that
re-reads and re-verifies the whole log every 5 s. Measured on the signup log's
2-entry account log, one verification is about 2.6 ms; the cost is linear in log
length, and every enrollment or rotation appends an entry, so it grows with the
account's age rather than with any one request.

### WAS-76: Memoize access-control policy documents

- status: done
- done: 2026-09-03
- priority: low
- labels: performance, policy
- acceptance:
  - [x] `resolveEffectivePolicy` reads the Space, Collection, and Resource
        policy documents through a per-backend short-TTL cache in the shape of
        `lib/spaceDescriptionCache.ts`, keyed by the policy's level
  - [x] The policy PUT and DELETE handlers, Delete Collection, Delete Space, and
        import invalidate the affected entries
  - [x] Tests in `test/`: a policy write is visible on the next anonymous read;
        a deleted policy stops granting on the next read

Context: every anonymous read that falls through to the policy path issues three
policy reads before the Resource read itself (the signup log shows this on each
public `did.jsonl` read). Policies change only through their own handlers, so
they fit the Space Description cache pattern exactly.

### WAS-63: Move the Collection `indexes` declaration under `plaintext`

- status: done
- done: 2026-09-05
- priority: medium
- labels: data-model, query, breaking
- touches:
  - was-teaching-server: `src/lib/equalityIndex.ts` (`assertSupportedIndexes`,
    `normalizeIndexes`, `assertIndexesNotEncrypted` -- the exclusion becomes
    presence-based: `plaintext` and `encryption` both present is
    `invalid-request-body`, pointer `#/plaintext`),
    `src/requests/SpaceRequest.ts` (create body `plaintext`),
    `src/requests/CollectionRequest.ts` (update path, the added-unique-index
    scan, the `equality` query and `GET ?filter[...]` routes reading
    `plaintext.indexes`), ARCHITECTURE.md / AGENTS.md unaffected (neither
    documents `indexes`)
  - storage-core: SC-1 supplies `CollectionDescription.plaintext`
  - wallet-attached-storage-spec: shape of record is decision record
    `_spec/decisions/0004-plaintext-and-encryption-counterparts.md`
    (2026-08-20); the spec text lands with the `equality` profile under WASS-26
  - was-conformance-suite: the `plaintext` declaration cases listed in the
    acceptance below (the `equality` query suite itself waits on spec WASS-26);
    suite-side items are tracked here
  - was-client: unaffected (no `indexes` producer or `equality` binding)
- acceptance:
  - [x] A Collection description carries `plaintext: { indexes: [...] }`; a
        top-level `indexes` is no longer read or stored (no compatibility
        fallback -- greenfield)
  - [x] `plaintext` and `encryption` both present on the resulting description
        is rejected with `invalid-request-body` on create and update, regardless
        of whether `plaintext.indexes` is empty
  - [x] `plaintext` is updatable (add, change; `{}` is the empty state, there is
        no removal) on an existing Collection; a malformed `plaintext`
        (non-object, non-array `indexes`, bad entry, empty or duplicate `name`,
        unknown `source`) is `invalid-request-body`
  - [x] The `equality` profile and `GET ?filter[...]` read their declarations
        from `plaintext.indexes`; existing `test/` coverage is moved to the new
        shape
  - [x] was-conformance-suite cases (a new `plaintext-declaration-api` suite or
        additions to `collection-api`): `plaintext.indexes` persist/echo,
        `plaintext` + `encryption` both present 400 on create and update,
        malformed `plaintext` 400, `plaintext` add/change on an existing
        Collection, `unique` index conflict 409

The spec settled server-side indexing as `plaintext.indexes` (decision 0004,
2026-08-20; text ships with WASS-26; server side landed 2026-09-05 in 0.26.0,
the conformance-suite cases in was-conformance-suite 0.8.0): the two mutually
exclusive top-level Collection members are `encryption` and `plaintext`, so the
exclusion is a structural fact rather than a cross-reference, and "indexes"
stops colliding with the blinded indexes of an encrypted Collection. The server
shipped the flat `indexes` ahead of the spec text; this item moves it. Note for
WAS-25 (b): with the presence-based exclusion, "`custom`-only indexes on
`encryption`-marked Collections" would need a `plaintext` member beside
`encryption`, which the spec forbids; and the spec already makes an encrypted
Collection's `custom` metadata an envelope, so that extension is superseded as
written.

### WAS-78: KMS key wrap accepts only AES-sized payloads

- status: done
- done: 2026-09-05
- priority: high
- labels: kms, correctness
- touches:
  - minimal-cipher: the WebCrypto `Kek` backend must accept every RFC 3394
    payload length and both backends must refuse malformed lengths with one
    distinguishable, exported error (its name is a library API contract and
    needs maintainer sign-off before coding); publish, then bump here. Shipped
    as `InvalidKeyLengthError` in minimal-cipher 7.9.0
- acceptance:
  - [x] minimal-cipher's `wrapKey` accepts any `unwrappedKey` whose length is a
        multiple of 8 bytes and at least 16, on both the WebCrypto and pure-JS
        backends, with byte-identical output; shorter or unaligned lengths throw
        the distinguishable error before either backend runs
  - [x] minimal-cipher's `unwrapKey` throws the same error for a ciphertext that
        is not a multiple of 8 bytes or is shorter than 24, instead of resolving
        `null` (which stays reserved for the integrity-check miss)
  - [x] `WrapKeyOperation` on an `AesKeyWrappingKey2019` key wraps 40, 48, and
        64-byte payloads, and maps the library's length error to a 400
        `invalid-request-body` with pointer `#/unwrappedKey` (`#/wrappedKey` on
        unwrap)
  - [x] `UnwrapKeyOperation` returns the same material for every length the wrap
        side accepts
  - [x] Tests in `test/` cover a 64-byte round trip, the 400 for an 8-byte and a
        20-byte payload, and the 16/24/32-byte cases keep passing

Context: the move from `node:crypto`'s `id-aes256-wrap` to minimal-cipher's
`Kek.wrapKey` imports the payload as an AES-GCM `CryptoKey` before wrapping, so
WebCrypto rejects any payload that is not 16, 24, or 32 bytes with a `DataError`
that `aesWrapKey` does not catch (the client sees a 500). The unwrap side has
the quieter form of the same defect: a 72-byte ciphertext fails the AES-GCM
import, the `catch` swallows it, and the operation reports `null`, which the
client reads as a wrong KEK. Verified against minimal-cipher 7.8.3.

The defect is upstream. minimal-cipher's pure-JS backend (`@noble/ciphers`
`aeskw`) already accepts every RFC 3394 length, so the two backends disagree on
what they accept while documenting identical output. The fix is in `aeskw.ts`:
the WebCrypto `Kek` falls through to the noble primitive whenever the payload is
not an AES key size (or, on unwrap, the ciphertext is not 24, 32, or 40 bytes),
and a single length check ahead of both backends throws the distinguishable
error. Output bytes for 16/24/32-byte payloads do not change, so previously
wrapped keys need no migration. This server keeps only the request-layer half:
catching that error and rethrowing it as the 400. RFC 3394's 16-byte minimum
stays; arbitrary lengths would be RFC 5649 key wrap with padding, a different
algorithm and key type, and are out of scope.

### WAS-79: Get Chunk leaks the chunk stream when the parent gate fails

- status: done
- done: 2026-09-05
- priority: high
- labels: chunks, correctness, filesystem-backend
- acceptance:
  - [x] When the parent-Resource read rejects or the parent is absent, the
        already-opened chunk stream is destroyed before the error is thrown
  - [x] A test in `test/` repeatedly GETs an orphan chunk (parent deleted, chunk
        file left) and asserts no file descriptor remains open (via a spy on the
        stream's `destroy`, or an fd count on Linux)

Context: `ChunkRequest.get` issues the parent-metadata read and `getChunk`
together under `Promise.allSettled`. On the filesystem backend `getChunk`
resolves only after the read stream's `open` event, so an fd is held by the time
the parent gate throws `ResourceNotFoundError`, and `autoClose` fires only on
end, error, or destroy. Each probe of an orphan chunk leaks one fd until
`EMFILE`. Related to the shared helper in WAS-80, which is the natural place for
the cleanup.

### WAS-80: One helper for the parent-gated parallel chunk reads

- status: done
- done: 2026-09-05
- priority: low
- labels: chunks, simplification
- acceptance:
  - [x] The three `Promise.allSettled` parent-gate blocks in `ChunkRequest.ts`
        (get, head, list) call one helper beside `getResourceMetadataOrThrow` in
        `collectionContext.ts` that takes the independent promise and applies
        the precedence rule (rejected parent read, then parent-absent 404, then
        rejected companion read)
  - [x] The helper owns the cleanup for a resolved-but-discarded companion value
        (WAS-79)
  - [x] Existing chunk tests keep passing

### WAS-81: Blinded-index candidate reads should skip meta sidecars

- status: done
- done: 2026-09-05
- priority: medium
- labels: filesystem-backend, performance, correctness
- acceptance:
  - [x] The blinded-index query path and the blinded-unique write path read JSON
        documents only (no `.meta.<id>.json` read per live Resource)
  - [x] A corrupt meta sidecar on an unrelated Resource does not fail a
        blinded-index query or a blinded-unique write
  - [x] `writeResource` calls the candidate reader only when a unique index
        (plaintext or blinded) actually requires it
  - [x] A test in `test/` writes an unparsable sidecar and asserts a
        blinded-index query still succeeds

Context: deleting `#readJsonCandidates` and deriving blinded-index candidates
from `#readEqualityCandidates` added one `readMetaSidecar` read per live
Resource (blobs included) on every blinded-index query and blinded-unique write,
and `readMetaSidecar` has no error handling, so one bad sidecar rejects the
whole `Promise.all`. A `jsonOnly` flag on `#readEqualityCandidates`, or a slim
JSON-only reader, restores the prior cost and failure surface.

### WAS-82: Skip the sidecar read on Resource and chunk misses

- status: done
- done: 2026-09-05
- priority: low
- labels: filesystem-backend, performance
- acceptance:
  - [x] `#readRepresentation` and `#statRepresentation` start the meta sidecar
        read only once `#findFile` has located the representation (or check the
        sidecar against the directory entries already in hand)
  - [x] Existing Resource and chunk 404 / HEAD tests keep passing

Context: both methods now issue `readMetaSidecar` concurrently with `#findFile`,
so every GET or HEAD for a nonexistent id pays a wasted sidecar open/read whose
result the following throw discards. Overlaps with WAS-77, which changes the
same lookup path.

### WAS-84: Key Operation handler still hand-rolls its body-shape check

- status: done
- done: 2026-09-05
- priority: low
- labels: kms, simplification
- acceptance:
  - [x] The Key Operation handler in `KeyRequest.ts` uses `assertJsonObjectBody`
        like the other handlers in that file
  - [x] A JSON array body is refused with the same 400 the helper produces
        elsewhere

Context: the remaining
`typeof request.body !== 'object' || request.body === null` check has no
`Array.isArray` exclusion, so the file now carries two definitions of "JSON
object body".

### WAS-62: Validate the `hmac` descriptor member (shape + permanence)

- status: done
- done: 2026-09-05
- priority: medium
- labels: encryption, data-model, validation
- touches:
  - was-teaching-server: `src/lib/encryption.ts` (a new `hmac` shape check
    beside `assertValidEncryptionEpochs`, and a permanence check inside
    `assertEncryptionDescriptorTransition`), `src/errors.ts` if the
    `encryption-immutable` detail text is widened; ARCHITECTURE.md / AGENTS.md
    unaffected (neither documents the descriptor members)
  - storage-core: unaffected; its `CollectionEncryption` type already declares
    `hmac` with the required shape, so the server's shape check narrows against
    that type rather than adding a local one
  - wallet-attached-storage-spec: the rules are shipped text (WASS-20,
    2026-08-20): `#blinding-key-member` and `#key-epoch-server-validation`
  - was-conformance-suite: `encryption-descriptor-api` gains the hmac cases
    listed in the acceptance below (suite-side items are tracked here, not in a
    separate roadmap)
  - was-client: unaffected (already mints `hmac` through the descriptor CAS and
    never changes `id`/`type` or drops the member)
- acceptance:
  - [x] On a create or update that supplies `encryption.hmac` for a recognized
        `edv` descriptor: `hmac` MUST be an object with non-empty string `id`
        and `type` and a non-empty `recipients` array whose entries have the
        epoch entry shape (`header.kid`, `header.alg` non-empty strings, string
        `encrypted_key`); a violation is `invalid-request-body` with a JSON
        pointer
  - [x] On an update of a stored descriptor that carries `hmac`: the member MUST
        remain present with `id` and `type` unchanged (`recipients` entries may
        change); a change or removal is `encryption-immutable` (409).
        Introducing `hmac` on a stored descriptor that lacks it is accepted (the
        WAS-EC provisioning-time rule stays client-side)
  - [x] The whole descriptor still round-trips unmodified (`hmac` included)
  - [x] Server `test/` coverage for each accepted and refused case
  - [x] was-conformance-suite `encryption-descriptor-api` cases: hmac round-trip
        (`encryption.hmac-persist-echo`), malformed hmac 400 (missing
        `id`/`type`, empty `recipients`, bad entry shape), hmac `id` change 409,
        hmac removal 409, hmac `recipients` change accepted, late hmac
        introduction accepted

Today `hmac` rides through the descriptor as an unknown extra member
(`encryption.ts` preserves unknown fields and
`assertEncryptionDescriptorTransition` has no `hmac` branch), so a client bug
can drop or replace the blinding key and orphan every blinded index in the
Collection. The spec now requires the shape check and the permanence invariant;
this item implements both.

### WAS-54: Read-side caching: 304 on `If-None-Match` and `Cache-Control`

- status: done
- done: 2026-09-07
- priority: low
- labels: caching
- acceptance:
  - [x] A Resource GET/HEAD with an `If-None-Match` that matches the current
        `ETag` returns 304 Not Modified with no body (and the `ETag` header),
        per RFC 9110 conditional-read semantics; a non-matching validator
        returns the full 200 representation
  - [x] The same conditional-read handling applies to the other ETag-emitting
        reads (chunk GET/HEAD, `/meta`, Collection Description)
  - [x] Non-idempotent responses are marked non-cacheable
        (`Cache-Control: no-store` on POST responses), per the spec SHOULD
  - [x] Integration tests in `test/`, plus optional-tier conformance tests in
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

A concrete consumer arrived 2026-09-07 (freewallet FW-134, the log-governed
collection encryption descriptors). Every resource log a wallet reads -- the
account `did.jsonl`, the user key roster, the annex generation log, and under
FW-134 one log per governed collection -- is re-downloaded whole and re-verified
from genesis on every visit. A client holding a verified head and its `ETag`
could confirm the log unchanged with a header round trip and skip both the body
and the chain verification. The log route is an ordinary Resource GET (body
`text/jsonl`), so the first acceptance box already covers it; nothing
log-specific is needed. The wallets adopt the header in their log store's read
path once this lands. Not a blocker for FW-134.

### WAS-88: Generation marker in the `ETag` so a hard delete cannot reuse a validator

- status: done
- done: 2026-09-07
- priority: high
- labels: caching, conditional-writes, wire-contract
- touches:
  - was-client: `parseEtag` reads the trailing integer after the last `.`;
    `If-Match` echoes the received validator string instead of rebuilding it
    from a number
  - conformance-suite: drop the literal `"1"` assertions; treat the validator as
    opaque
  - spec: already satisfied, the Conditional Requests text says the validator is
    opaque to clients and its derivation a server-side concern; no edit
- acceptance:
  - [x] `ETag` is `"<generation>.<version>"`; the generation is minted once per
        versioned record (Resource sidecar, chunk sidecar, Collection
        description, Collection metadata sidecar) and preserved through a
        Resource tombstone and re-create
  - [x] A chunk deleted and rewritten, and a Collection deleted and re-created
        under the same id, carry a different generation; a stale pre-delete
        `If-None-Match` gets 200 and a stale `If-Match` gets 412, on both
        backends
  - [x] Export/import carries the generation with the sidecars and the
        description
  - [x] was-client and the conformance suite consume the new shape (touches
        resolved)

Before this change the version counter restarted at 1 after a hard delete (chunk
delete, Delete Collection, Delete Space), so a re-created record could emit an
`ETag` equal to one a client cached from the old record, and the new 304 path
would answer it with the stale body. A counter that survives the delete would
need tombstones outside the Space tree and would tell a later controller of a
reused Space id how many writes the previous one made; a per-record random
generation needs no persistence beyond the record itself.

### WAS-85: `createApp` option to disable or replace the Fastify logger

- status: done (2026-09-07)
- priority: low
- labels: dx, testing
- acceptance:
  - [x] `createApp` accepts a `logger` option passed through to Fastify (`false`
        for silent, or a pino options object / instance), defaulting to the
        current `true`
  - [x] The backend diagnostics wiring in `src/plugin.ts` (the
        `storage.logger     = fastify.log` hand-off) still works when the logger
        is silent
  - [x] `test/helpers.ts` `startTestServer` defaults to `logger: false`, and the
        in-process consumers (was-react, was-sync) can opt in the same way
  - [x] CHANGELOG entry

Context: `createApp` in `src/server.ts` constructs Fastify with `logger: true`
and offers no way to change it. Every consumer that boots the server in-process
for its tests (was-react's and was-sync's integration suites, this repo's own
`test/`) gets one JSON log line per request in its test output, which buries
assertion failures. Requested from was-sync's WS-11, which moved its integration
suite from a fake server onto a live in-process instance.

### WAS-87: Governing-log sub-resource with a server-derived `encryption` member

- status: done
- done: 2026-09-07
- priority: medium
- labels: encryption, resource-log, data-model, cross-repo
- touches:
  - was-teaching-server (shipped 2026-09-07 in 0.28.0): `CollectionRequest` (the
    describe/list read path that serves `encryption`, and the create/update path
    that today accepts a client-written descriptor), `src/lib/encryption.ts`
    (the epoch and hmac transition checks move from Description PUT to log
    append for a governed Collection), the encrypted-Collection envelope
    enforcement (a log sub-resource is exempt), the listing and `changes` feed
    (a log sub-resource is not a Resource of the Collection), a new route
    `/space/{space_id}/{collection_id}/meta/log` beside the Collection `/meta`
    route (`CollectionRequest.getMeta` / `putMeta`), the problem-type registry
    in storage-core (one new entry)
  - wallet-attached-storage-spec: WASS-27 is the normative half, written
    generically (a governing-log sub-resource and server-derived members, the
    `encryption` descriptor as the first governed member); the wire values were
    settled 2026-09-07: path `.../meta/log`, declaration by guarded create, one
    new problem type `encryption-history-log-governed` (409), features flag
    `governed-history-logs`. Spec text landed and was committed 2026-09-07
    (e4907d4): the "Collection Governing History Log" section and its two
    operations, plus the registry, features, and cross-reference clauses.
    WASS-27 stays open in the spec repo only for its producer-side touches
  - storage-core: the new problem type in the shared registry
    (`https://wallet.storage/spec#encryption-history-log-governed`, 409).
    Shipped 2026-09-07 as `ProblemTypes.ENCRYPTION_HISTORY_LOG_GOVERNED` in
    storage-core 0.11.0 (published; the server depends on `^0.11.0`)
  - encrypted-collections-spec: owns the profile-level refusals this item does
    not implement (`state.type`, `history` inside `state`, proofs, chain); ECS-7
    resolves in this direction. Waived for this item 2026-09-07: ECS-7 is
    profile text that consumes the sub-resource and changes nothing this server
    serves; it stays `todo` in encrypted-collections-spec
  - was-client: the `/log` transport's `resourceLogStore` takes a Collection
    Resource handle today; the sub-resource is not a Resource, so the store
    needs a constructor over the Collection handle (or a raw URL). WCL-17
    carries that. The descriptor-store seam serves a governed Collection's
    descriptor from the derived member as today. Shipped 2026-09-07 in
    was-client 0.51.0 (0.52.0 is current; the server depends on `^0.52.0`):
    `resourceLogStore({ collection })` over `Collection.getHistoryLog` /
    `putHistoryLog`, plus a live-server integration test
  - freewallet FW-134 / dcw DCW-43: the producers; both drop their projection
    PUT and write the log alone. Waived for this item 2026-09-07: they consume
    the shipped server feature through was-client and do not change its
    contract; both stay `todo` in their own roadmaps
  - was-conformance-suite: a governed Collection's derived member equals the log
    head's `state` plus `history`; a direct `encryption` write on a governed
    Collection is refused; a log append violating epoch monotonicity is refused.
    Also: the suite's optional backend-description cases pin the exact
    `features` list and already fail on `chunked-streams`; they now also miss
    `governed-history-logs`. Shipped 2026-09-07 in suite 0.12.0 (the server
    depends on `^0.12.0`): a `governed-log-api` suite of 16 cases gated on the
    feature token, including the fast-forward append rule, and the `features`
    pin now carries the full list, conformant against this server
- acceptance:
  - [x] A Collection becomes log-governed by the guarded create of its log
        (`PUT .../meta/log` with `If-None-Match: *`) on a Collection whose
        Description holds no client-written `encryption` member; the create is
        refused with `encryption-immutable` (409) on one that does. No new
        Description member. For such a Collection the served `encryption` member
        on describe and on the Space listing is derived by the server from the
        governing log's head entry `state`, with `history: { method, resource }`
        stamped on. The server does not verify entry proofs or the hash chain;
        derivation is last-line parsing, and the member is exactly what a
        verifying reader would compute after stripping `history`
  - [x] The log is the sub-resource
        `/space/{space_id}/{collection_id}/meta/log`, not a Resource of the
        Collection and not part of the `/meta` body (a `PUT /meta` does not
        touch it): absent from listings and the `changes` feed, exempt from the
        encrypted-Collection envelope rule, and readable under any capability
        whose `invocationTarget` covers the Collection URL, so a share grantee
        or an app reads it with the zcap it already holds
  - [x] The log sub-resource supports the `/log` transport's three operations:
        read with `ETag`, append as a compare-and-swap on `If-Match` carrying
        the prior bytes verbatim, guarded create with `If-None-Match: *`; `412`
        on a lost race
  - [x] The epoch and hmac transition checks (`epochs` append-only,
        `currentEpoch` never older, `hmac` id/type permanent once present,
        `scheme`/`version` set-once) run on each log append against the prior
        head's `state`, and a violating append is refused before it lands. The
        server checks the WASS-27 line contract alone (JSON Lines, each line an
        object with a `state` member, last line is the head) and refuses an
        append that breaks it; `state.type`, the reserved `history` member
        inside `state`, proofs, and the chain are the profile's constraints and
        are NOT checked here
  - [x] A direct write of `encryption` on a governed Collection's Description is
        refused with `encryption-history-log-governed` (409, new registry
        entry); the descriptor is read-only on that path. A line-contract break
        on append is `invalid-request-body` (400); an epoch-transition violation
        on append raises what the Description PUT raises today
  - [x] Creating the log on a Collection that already carries a client-written
        `encryption` descriptor is refused (`encryption-immutable`);
        pre-release, there is no conversion, only re-provisioning
  - [x] Server `test/` coverage of the four refusals (direct member write,
        line-contract break, epoch-transition violation, governing an
        already-described Collection) and of derived == head-state equality; the
        backend advertises `governed-history-logs` in its features list;
        conformance-suite assertions gated on that flag **Server half held
        2026-09-07** -- `test/governed-log-api.test.ts` (21 cases) plus a
        backend-contract block run on both backends; the flag is advertised. The
        conformance-suite assertions landed 2026-09-07 (suite 0.11.0,
        unpublished)

Server half landed 2026-09-07 (uncommitted): the storage seam
(`getCollectionLog` / `writeCollectionLog` on both backends), the route and
handlers, derivation in `getCollectionOrThrow`, the refusals, and the tests. Two
notes from the implementation. An epoch-transition violation on append raises
what the Description PUT raises today, which for a dropped epoch or a backwards
`currentEpoch` is `invalid-request-body` (400), not `encryption-immutable`;
WASS-27's text says the latter and should follow the server. A log whose genesis
line carries no string `parameters.method` is served without a `history` stamp
(the storage-core type requires both members). storage-core 0.11.0 is published
and consumed from the registry. The Space listing (List Collections) carries no
`encryption` member for any Collection, governed or not, so the derived member
is served on describe alone. Done 2026-09-07: server 0.28.0, suite 0.12.0, and
was-client 0.52.0 are published, the spec text is committed, and the three
producer-side touches (ECS-7, FW-134, DCW-43) are waived for this item as noted
above.

Filed 2026-09-07 from freewallet FW-134's design pass. Under the
encrypted-collections log form each governed Collection's encryption descriptor
is the `state` of a hash-chained resource log's head, and today's design had
every producer append to the log and then PUT a point-state projection onto the
Collection Description, two requests with a drift window between them and an
ensure sweep to mend a tear. Deriving the projection server-side removes the
second write, the drift, and the mender, and lets the spec say what it already
half-says (encrypted-collections-spec ECS-7): the log is the only authoritative
serving and the point-state member is a projection of it. The server already
does the same thing one level up: it resolves a did:webvh Space controller by
reading `did.jsonl` out of its own storage. The difference here is that the
server does not verify the log; a verifying reader does, and everyone else
trusts the server exactly as much as they do now.

The sub-resource placement follows from two server rules. The envelope rule
refuses non-envelope content in an encrypted Collection, so the log cannot be a
document of the Collection it governs; and a document would show in listings and
the `changes` feed, where the sync driver would replicate it as a row. A
sub-resource beside `/meta` sits under the Collection URL for authorization and
outside its document set for everything else.

The read-side cost the wallets carry (one log fetch per governed Collection per
session, verified from genesis) is unaffected by this item; WAS-54 / WAS-86
(`If-None-Match` on reads) are the items that reduce it.

### WAS-89: A soft delete reopens the `/meta` validator reuse the generation closed

- status: done
- done: 2026-09-07
- priority: high
- labels: bug, conditional-writes, metadata, tombstones
- touches:
  - was-teaching-server (shipped 2026-09-07 in 0.28.0): `deleteResource` (the
    tombstone sidecar rewrite), the Resource `/meta` write path,
    `src/lib/etag.ts`, the Postgres schema (a `meta_generation` column on
    resources), CHANGELOG
  - wallet-attached-storage-spec (waived 2026-09-07, tracked separately as
    WASS-28): WASS-28 records the lifecycle rule this item enforces
  - was-sync (shipped 2026-09-07): WS-13 pins the resurrection path's `/meta`
    write against this server
- acceptance:
  - [x] A Resource's `/meta` validator carries its own generation, minted by the
        first metadata write and independent of the content sidecar's
        `generation` (the shape Collections already have with
        `description_generation` beside `meta_generation`)
  - [x] The tombstone rewrite drops that generation together with `custom` and
        `metaVersion`, so a re-created Resource's first metadata write starts a
        fresh generation at `metaVersion` 1
  - [x] Regression test on both backends: write `/meta`, soft-delete, re-create,
        write `/meta` again; the pre-delete meta `ETag` fails `If-Match` with
        412, and `If-None-Match: *` on `/meta` succeeds on the re-created
        Resource
  - [x] The content validator's behavior is unchanged: `generation` kept and
        `version` continuing through the tombstone

Server side shipped 2026-09-07 (sidecar `metaGeneration`, Postgres
`meta_generation` migration v4, both backends, contract and HTTP regression
tests). The was-sync touch (WS-13) shipped the same day: its integration case
pins both the one-cycle resurrection and the 412 on the pre-delete meta `ETag`
against this server. The spec touch (WASS-28) was waived on 2026-09-07 and is
tracked separately in the spec repo.

The `<generation>.<version>` change (0.28.0) keeps a Resource's generation
through a soft delete so the content counter stays continuous. The `/meta`
validator is built from that same sidecar generation and `metaVersion`, but the
tombstone rewrite in `deleteResource` drops `metaVersion` while keeping the
generation. After a re-create, the first metadata write mints `metaVersion` 1
under the old generation, so the meta `ETag` `<gen>.1` recurs. A replica still
holding the pre-delete `<gen>.1` passes `If-Match` on `/meta` and clobbers the
re-created Resource's metadata with stale `custom`. That is the lost update the
generation was introduced to close, reopened on the soft-delete path for the
metadata validator alone.

Dropping `custom` on delete is right (the user metadata goes with the deleted
Resource, and the spec treats a Collection's metadata object the same way). The
fix is to make the metadata object's validator die with it: a separate meta
generation, gone with the tombstone. Keeping `metaVersion` through the tombstone
instead would also close the hole, but it would force every resurrecting client
to carry a meta `ETag` off the tombstone feed entry and use `If-Match`, and
would change the tombstone's documented feed shape; the separate generation
leaves both the spec text and the sync driver as they are.

### WAS-90: Create-if-absent preconditions on Collection and Space Descriptions

- status: done
- done: 2026-09-08
- priority: low
- labels: conditional-writes, spec
- touches:
  - wallet-attached-storage-spec: WASS-31 (shipped 2026-09-07:
    `If-None-Match: *` and its 412 on Update Collection; the Space validator,
    the Read Space `ETag`, and both preconditions on Update Space)
  - was-conformance-suite: `conditional-requests-api` "Descriptions" group (four
    cases, drafted 2026-09-07 for 0.13.0; publish pending)
  - was-client: WCL-32 (the `ensureSpace` / `ensureSpaceAndCollection` create
    races; a 412 there has to become a re-read rather than an error)
- acceptance:
  - [x] `writeCollection` accepts `ifNoneMatch` beside `ifMatch`, evaluated
        atomically with the write like the metadata and log writes already are;
        `CollectionRequest.put` threads the parsed `If-None-Match: *` through
        instead of dropping it, and an existing Description answers 412
        `precondition-failed`
  - [x] Space Descriptions carry a server-managed version validator; Read Space
        emits it as a strong `ETag`, and `writeSpace` accepts `ifMatch` /
        `ifNoneMatch` on the same terms, with `SpaceRequest.put` threading the
        parsed headers through
  - [x] Conformance and `test/` coverage for both endpoints: guarded create
        succeeds on an absent target, 412 on a present one, `If-Match` CAS on
        the Space, and an unconditional PUT unchanged
  - [x] Spec text for both operations (the `If-None-Match: *` line and its 412
        on Update Collection; the Space validator, `ETag`, and preconditions),
        filed against the spec repo

Context: the client's `ensureSpace` and `ensureSpaceAndCollection` read the
Description, find it absent, and `PUT` a create. Two clients booting at once
both take that branch, and the loser's replace-semantics `PUT` overwrites the
winner's: a Space loses its `type` array (accepted at creation only) and a
collection its `backend`. `If-None-Match: *` is the only precondition that
states create-if-absent. The Collection Description handler parses it and drops
it; the Space handler reads no preconditions and its read emits no `ETag`, so
there is nothing to condition on. Neither endpoint rejects the header either, so
a client sending it gets no 412 and no protection. The Collection half reuses
the `ifMatch` / `assertTransition` plumbing `writeCollection` already has; the
Space half needs the validator first, which is the spec decision.

### WAS-91: Distinct problem type for an already-revoked revocation submission

- status: done
- done: 2026-09-09
- priority: medium
- labels: zcap, errors, revocation
- blocked-by: storage-core SC-2
- touches:
  - storage-core: SC-2 minted `ProblemTypes.CAPABILITY_ALREADY_REVOKED`
    (`#capability-already-revoked`, 400) on 2026-09-09; published as
    @interop/storage-core@0.12.0 (consumed here 2026-09-09)
  - was-client: WCL-39 maps the type to `AlreadyRevokedError` (waived here
    2026-09-09; tracked in the was-client roadmap)
  - wallet-core: WC-135 narrows `revokeTreatingAlreadyRevokedAsSuccess` to it
    (waived here 2026-09-09; tracked in the wallet-core roadmap)
- acceptance:
  - [x] `RevocationRequest` (`src/requests/RevocationRequest.ts`) answers the
        post-authorization store hit ("already revoked", the check that runs
        after `handleRevocationInvocationVerify`) with the SC-2 problem type
        instead of `INVALID_REQUEST_BODY`; the status stays 400
  - [x] Every other 400 on the route (malformed body, root capability, id
        mismatch, chain verification failure, no delegator) keeps
        `INVALID_REQUEST_BODY`, so a chain that fails to verify is never
        reported as revoked
  - [x] The oracle argument is recorded in the handler comment: the distinct
        type is emitted only after the masked authorization, so it discloses
        nothing an unauthorized prober could not already learn
  - [x] Server `test/` pins the type on a resubmission and pins
        `INVALID_REQUEST_BODY` on a tampered and on an expired chain

Discovered 2026-09-09 from wallet-core WC-135. Today every 400 on the revocation
route is one `InvalidRevocationError` carrying `INVALID_REQUEST_BODY` and the
title "Invalid Revoke Capability request"; the cases differ only in the
free-text `detail`. A client resubmitting a revocation blind (a resumed
ceremony) therefore cannot tell "already revoked" from "the chain does not
verify", and wallet-core currently treats both as success, which leaves a
still-valid generation delegation live for up to a year. Narrower than WAS-57:
that item types the denial on an invocation under a revoked chain; this one
types the answer to the revocation submission itself, on the one path whose
disclosure is already gated behind authorization.

### WAS-57: Typed denial reasons on zcap authorization failures

- status: done
- done: 2026-09-10
- priority: low
- labels: zcap, errors
- touches:
  - storage-core: SC-3 minted `ProblemTypes.CAPABILITY_REVOKED` and
    `CAPABILITY_EXPIRED` (`#capability-revoked` / `#capability-expired`, 404) on
    2026-09-09; published as @interop/storage-core@0.13.0. Earlier: SC-2 minted
    `ProblemTypes.CAPABILITY_ALREADY_REVOKED` (`#capability-already-revoked`,
    400), published as @interop/storage-core@0.12.0
  - zcap: the two verification-time expiry checks throw the exported
    `CapabilityExpiredError` (`name: 'CapabilityExpiredError'`), published as
    @interop/zcap@11.2.0
  - conformance-suite: `denial-reasons-api` (optional typed cases, required
    merged-not-found case), published as 0.14.0
  - was-client: WCL-40 maps both types to `CapabilityRevokedError` /
    `CapabilityExpiredError` (`NotFoundError` subclasses), published as 0.57.0
  - wallet-attached-storage-spec: WASS-32 records the registry entries and the
    privacy note, joining the WASS-4 revocation text (waived for this item:
    still todo in the spec repo, handled by the maintainer)
- acceptance:
  - [x] An authorization denial distinguishes, at minimum, a revoked capability
        in the chain, an expired capability, and a generic verification failure,
        as distinct problem types in the error response (today every cause
        collapses into one generic unauthorized response)
  - [x] A security-considerations pass decides which reasons are safe to expose
        to which callers: reason detail must not become an oracle (e.g.
        confirming to an unauthorized prober that a given capability exists or
        was revoked); reasons may need to be limited to callers presenting the
        affected chain
  - [x] The problem-type spellings are recorded (registry + spec-side note,
        joining the WASS-4 revocation spec text when that lands)
  - [x] Server `test/` coverage for each distinguished cause

2026-09-09: implemented. The security pass settled on 404 for every denial, the
two causes named by `type` only, and only for a caller signing with the invoked
capability's controller key (ARCHITECTURE.md "Denial reasons"). 2026-09-10: the
four packages published and the temporary link overrides dropped; archived.

The diagnosability half of the revocation-observability question, minted
2026-08-19; the read/status-probe half (a client-queryable revocation endpoint)
is deliberately deferred until a use case needs it -- revocation records are
retention-bounded internal enforcement state (`capability.expires + 24h`, then
prunable), so a query surface would promote them into a contract with retention
and authorization questions of their own. Motivating case, from wallet-side
ceremony design: a chain that stops verifying is opaque to its holder and to the
Space owner alike -- "revoked" is indistinguishable from "expired", a policy
denial, or a verification-clause refusal, which hurts incident response and
forces grantee apps to treat every 403 as ambiguous. Typed denial reasons give
the holder the answer at exactly the moment it matters, without a new query
surface. Denials currently funnel through the generic authorization error in
`src/zcap.ts` / `src/authorize.ts`; the revocation cause originates in
`revocationChainInspector` (`src/lib/revocations.ts`) and is distinguishable at
that point.

### WAS-99: Decide what `DELETE` answers at a container's `meta` sub-resource

- status: done (2026-09-12)
- priority: medium
- labels: was-v0.5, routes, wire-contract
- discovered-from: WAS-97
- touches:
  - wallet-attached-storage-spec: the route table says there is no `DELETE` at
    `meta`, but does not say what a server answers there; whichever status is
    chosen wants a sentence
  - was-teaching-server: `src/routes.ts`, `src/requests/CollectionRequest.ts`
- acceptance:
  - [ ] `DELETE /space/:s/meta` and `DELETE /space/:s/:c/meta` answer the chosen
        status, decided by the maintainer
  - [ ] The case in `test/client-annex-clause-api.test.ts` that asserts a
        ladder-signed `DELETE` aimed at the Space Metadata URL is refused
        asserts that status, and still proves the clause refuses the invocation
        rather than the route refusing it first

`DELETE /space/:s/meta` currently answers `409 reserved-id`, before any
authorization. The `meta` segment occupies the `{collectionId}` position, so the
request routes to Delete Collection, whose `assertValidIds` rejects the reserved
id. The status is defensible but accidental, and it is unauthenticated where the
neighbouring refusals are masked as 404.

Three candidates. `405` with an `Allow` header naming `GET, HEAD, PUT` matches
what the v0.5 container rule already does for a `PUT` at a container URL, and
says the true thing: the method is not defined at this URL. `404` matches the
masking every other under-authorized refusal uses. `409 reserved-id` is what
falls out today. This is a wire-contract choice, so it is the maintainer's.

Found while fixing the invocation-time ladder bound: the clause test asserting
that a ladder-signed `DELETE` aimed at the Space Metadata URL is refused now
never reaches the clause, because the route refuses it first. That assertion is
left failing rather than retargeted, since retargeting it would bake in the
accidental status.

2026-09-12: resolved as 405. Both Metadata URLs register an explicit `DELETE`
that raises `MethodNotAllowedError`, so the request no longer falls through to
the parametric route one level up. The maintainer took the reading that a 405
says the true thing (the method is not defined at this URL) while 409
`reserved-id` answered a question the request had not asked, and that the
404-masking argument does not apply, since which methods a Metadata URL accepts
is static route-table knowledge rather than anything per-Space.

### WAS-6: Resource `id` supplied on POST create

- status: done (2026-09-12)
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

Resolved 2026-09-12 without implementation (WAS-104): the spec now says Create
Resource generates the id and a client choosing one uses Update (or Create by
Id) Resource, and it no longer lists `reserved-id` or an existing-id
`id-conflict` there. No POST mechanism is coming, so nothing remains to build.

### WAS-100: Spec text for `backend` surviving an omitting Collection Metadata update

- status: done (2026-09-12)
- priority: medium
- labels: was-v0.5, spec-gap, wire-contract
- discovered-from: WAS-97
- touches:
  - wallet-attached-storage-spec: "Update (or Create by Id) Collection" lists
    the qualifications to full replacement; `backend` needs to join `plaintext`
    there, or the server's deviation needs removing
  - was-teaching-server: `src/requests/collectionInput.ts`
  - was-conformance-suite: shipped -- suite 0.16.0, consumed 2026-09-12, as the
    optional `collection.meta-update-omits-backend-keeps-selection` (optional
    because registering a backend to select has no spec'd wire contract)
- acceptance:
  - [x] The spec says what an update omitting `backend` does
  - [x] The server matches it, and the comment in `composeCollectionMetadata`
        citing the rule points at the spec rather than at the reasoning

The spec makes a Collection Metadata `PUT` a full replacement, qualified only
for the server-managed members and for a log-governed `encryption`. `plaintext`
carries its own carve-out in its member definition. `backend` carries none, so
by the letter of the spec an update that omits it clears it, and a cleared
`backend` means the server default.

That is what this server did until 2026-09-12, and it silently stranded data: a
Collection selecting a registered external backend, updated with a body that
omits `backend` -- a rename, say -- repointed its data plane at the default,
leaving every Resource already stored in the external backend unreachable and
sending later writes elsewhere. The server now keeps the stored selection on an
omitting update, which deviates from the spec as written. Either the spec gains
the carve-out, or the rule becomes something else deliberately (a set-once
member like `encryption`, say, refusing a change outright once the Collection
holds Resources).

Status 2026-09-12: the carve-out was chosen over a set-once rule. The spec now
requires an update that omits `backend` to keep the stored selection (Update (or
Create by Id) Collection, the `backend` member definition, and Backends), and
the server comment cites it. The conformance case for the omitting update is the
remaining touch; it rides the suite's v0.5 pass.

### WAS-101: Answer 405 for every method a reserved endpoint does not implement

- status: done (2026-09-12)
- priority: medium
- labels: was-v0.5, routes, wire-contract, errors
- discovered-from: WAS-99
- touches:
  - wallet-attached-storage-spec: shipped -- WASS-38 landed 2026-09-12 (the
    `#methods-at-reserved-endpoints` subsection; container-`PUT` 405 raised to
    MUST; decision 0005 Amendment 4)
  - was-teaching-server: `src/routes.ts` (`refuseUnimplementedMethods`, called
    last in the Space, Collection and Resource groups), `src/errors.ts`
    (`MethodNotAllowedError` title and detail), ARCHITECTURE.md, CHANGELOG.md
  - storage-core: unaffected (no new problem type; the refusal is `about:blank`)
  - was-client: unaffected (`mapError` maps a 405 to a generic `WasError`
    through its status fallback)
  - was-conformance-suite: shipped -- suite 0.16.0, consumed 2026-09-12: the new
    `reserved-methods-api` suite loops over the reserved endpoints at all three
    levels, with container-`PUT` 405 and absent-Space cases;
    `collection.meta-reserved-resource-id-409` became
    `collection.meta-delete-405-not-reserved-id`
- acceptance:
  - [x] Every reserved endpoint answers each method it does not implement with
        405 and an `Allow` header read from the router, at all three levels;
        `OPTIONS` still reaches CORS preflight and `HEAD` follows `GET`
  - [x] The 405 is identical for an existing and an absent Space
  - [x] `MethodNotAllowedError` titles every 405 `Method Not Allowed` (RFC 9457
        section 4.2.1) and names the refusing URL in `detail`
  - [x] `test/error-registry-api.test.ts` covers the endpoints at each level,
        the absent-Space case, the empty `Allow`, `HEAD`, and CORS preflight
  - [x] The conformance suite's v0.5 pass asserts the rule

The WAS-99 fix answered `DELETE` at the two `meta` URLs with 405. A probe then
showed `meta` was not special: every other reserved endpoint still fell through
to the parametric route one level up and answered a `409 reserved-id` for a
method it lacked (`DELETE /space/{s}/linkset`, `GET /space/{s}/export`,
`PUT /space/{s}/{c}/quota`, `GET /space/{s}/{c}/query`). The maintainer chose a
general spec rule over a `meta`-only one, and this item is the server half.

The refusals are data-driven. Each group ends by reading which methods its
reserved endpoints implement from the router and registering a 405 for every
other method Fastify routes, so the `Allow` header cannot drift from the routes.
That helper must stay last in its group.

One consequence worth knowing: every Collection-level reserved segment is now a
static route for every method, so a reserved Resource id can no longer reach the
Resource `PUT` over HTTP. `assertValidId`'s reserved-id guard stays covered by
its unit tests and by tar import. The cross-collection `/space/{s}/query` is
anchored but served by nothing here, so it answers every method with an empty
`Allow`, which RFC 9110 permits.

### WAS-104: Reserved and duplicate Resource ids on Create Resource are unreachable

- status: done (2026-09-12)
- priority: medium
- labels: was-v0.5, spec-gap, wire-contract
- discovered-from: WAS-97
- touches:
  - wallet-attached-storage-spec: shipped -- WASS-39 landed 2026-09-12 (Create
    Resource and Update (or Create by Id) Resource drop `reserved-id`, Create
    Resource drops the existing-id `id-conflict`, the Collection `meta`
    paragraph drops the `POST` body `id` wording, Version History bullet)
  - was-teaching-server: unaffected (Create Resource already generates the id)
  - was-conformance-suite: shipped -- suite 0.16.0, consumed 2026-09-12:
    `write-validation.resource-reserved-id-put` and
    `ordering.resource-post-conflict-404` removed
- acceptance:
  - [x] The spec no longer lists an error for Resource creation that no HTTP
        request can produce
  - [x] The suite asserts no Resource `reserved-id` or existing-id `id-conflict`
  - [x] Suite 0.16.0 is published and consumed here

The spec listed `reserved-id` (409) and `id-conflict` (409) among the errors of
Create Resource (`POST /space/{s}/{c}/`), and said a reserved Resource id is
rejected "where a Resource id is supplied explicitly, as in a `POST` body's
`id`". The operation never said a body `id` names the Resource, though, and its
example has the server generate one. This server has always ignored a body `id`
there and minted a UUID, so neither error could occur.

Under v0.4 the suite reached the reserved-id guard with a `PUT` at a reserved
Resource id such as `.../quota`. Since WAS-101 every Collection-level reserved
segment is a static route that answers 405 for a method it lacks, so that path
is gone and no HTTP request produces `reserved-id` for a Resource. The suite's
first v0.5 replacement case sent the reserved id in a `POST` body and failed
here (201 with a generated id).

Decision 2026-09-12 (maintainer): the spec drops the errors rather than the
server honoring a body `id`. Honoring it would have been new wire behavior, and
a JSON Resource carrying its own `id` (a Verifiable Credential with a URL id,
say) would have been refused or placed at that id. `PUT` stays the only way to
choose a Resource id. The same reasoning removed `reserved-id` from Update (or
Create by Id) Resource, whose path a reserved segment turns into a reserved
endpoint. `assertValidId`'s reserved-id guard stays, covering tar import.

### WAS-97: Serve the v0.5 route table -- container descriptions at `meta`, the merged Collection Metadata object, trailing-slash canonical URLs

- status: done (2026-09-12)
- priority: high
- labels: was-v0.5, breaking, routes, persistence, zcap, migration
- design: settled 2026-09-11 (four points, each an ask answered in session):
  1. Predicate 3 splits by verb. DELETE branch: the target is the canonical
     Space URL `/space/{s}/`, equal to the parent's target unchanged, with
     `allowedAction` exactly `['DELETE']` (the shape WASS-2 restates). GET
     branch: the target is `/space/{s}/meta` with `allowedAction` exactly
     `['GET']`, and the parent's target is that meta URL or the Space URL. The
     DELETE grant's reach is unchanged: the zcap library's `/`-boundary prefix
     rule already let the old bare `/space/{s}` target cover the subtree, so the
     old bare-vs-slash distinction was cosmetic. What the distinction did carry
     was that a subtree grant (predicates 1 and 2) reached neither Update Space
     nor Delete Space; under v0.5 both sit inside the subtree, so the clause
     adds an invocation-time bound (the inspector receives the invoked target
     and action from `handleZcapVerify`): a chain carrying a ladder-signed link
     is refused on `PUT /space/{s}/meta`, and on `DELETE /space/{s}/` unless
     every ladder-signed link in the chain is exactly the DELETE shape above.
     (Amended 2026-09-12 from a check of the invoked capability alone, which an
     annex verification method's narrowing could satisfy. Signed off
     2026-09-12.) The app-connect-spec decision 0003 amendment and wallet-core
     WC-230 shape follow from this (drafted in the 2026-09-11 session report,
     not yet carried over).
  2. The Space root capability target (`attenuatedRootTarget`, and the
     `urn:zcap:root:` id a client mints for the Space) is the canonical
     `/space/{s}/`. The prefix rule covers `/meta` and every Collection; the
     bare form only redirects. WCL-41 mints the same string.
  3. `meta` joins the server's local reserved-Collection-id set now;
     storage-core 0.14.0 lacks it, so the drift-guard test stays red until a
     storage-core 0.14.1 adds it upstream and the devDependency is bumped.
  4. The server lands ahead of WCL-41: was-client 0.60.0 still speaks the v0.4
     table, so the `test/` API suites that drive the server through it stay red
     until the client half ships. Backend-contract and unit suites stay green.
     Persistence: one storage-port pair per container (`writeSpace` /
     `getSpaceMetadata`, `writeCollection` / `getCollectionMetadata`), one
     validator surfaced out of band as `metaGeneration` / `metaVersion`, stored
     as the `_generation` / `_version` file members on the filesystem and the
     `meta_generation` / `meta_version` columns in Postgres (migration v6
     renames the `description` jsonb to `metadata`, folds the Collection
     `meta_*` annotation columns into it, and drops the `description_*` pair).
     The Collection metadata sidecar file is gone; `custom`, `epoch`,
     `createdAt`, `updatedAt` live in the one Collection metadata file.
- design-approved: 2026-09-11
- blocked-by: storage-core SC-4 (DONE)
- touches:
  - wallet-attached-storage-spec: shipped -- WASS-29 landed 2026-09-11 (decision
    `_spec/decisions/0005-container-descriptions-live-at-meta.md`, with its two
    2026-09-11 amendments)
  - was-teaching-server: `src/routes.ts` (the Space and Collection route
    tables),
    `src/requests/{SpaceRequest,CollectionRequest,SpacesRepositoryRequest,spaceContext}.ts`,
    `src/types.ts` (the storage-port methods for descriptions and metadata),
    `src/backends/filesystem.ts` and `src/backends/postgresSchema.ts` (the
    merge, plus a Postgres migration),
    `src/lib/{collectionListing,paths,validateId,metadataWrite}.ts`,
    `src/lib/clientAnnexClause.ts`; ARCHITECTURE.md and AGENTS.md; a CHANGELOG
    entry naming the break
  - storage-core: shipped -- SC-4 shipped the merged type (0.14.0), and 0.14.1
    added `meta` to the reserved-Collection-id registry; consumed here
    2026-09-12, so the drift-guard test is green
  - was-client: shipped -- WCL-41 released as 0.61.0; consumed here 2026-09-12,
    with the raw-request `test/` suites migrated to the v0.5 table, so the full
    Vitest suite is green
  - was-conformance-suite: shipped -- the v0.5 pass released as 0.16.0 and
    consumed here 2026-09-12 (`pnpm conformance:local` 262/262). Retired the
    two-validator case in favor of one asserting a shared `ETag`
  - wallet-core: waived 2026-09-12 (maintainer) -- WC-230 stays open in
    wallet-core. WC-230 filed 2026-09-11 is the minting half of the
    ladder-delegation redesign below -- `clientAnnex/spaceCapability.ts` mints
    exactly the single-verb, bare-Space-URL capability predicate 3 admits. The
    two items settle one shape together; neither should guess ahead of the other
  - freewallet: FW-523 filed 2026-09-11 (the downstream grant minters and the
    durable activity history that records their targets); it is blocked by this
    item, not blocking it
  - app-connect-spec: waived 2026-09-12 (maintainer) -- the decision 0003
    amendment for the invocation-time ladder bound (design point 1) is not
    carried over yet
- acceptance:
  - [x] Space routes: `GET`/`PUT` at `/space/:spaceId/meta` read and write the
        Space Metadata object; `GET /space/:spaceId/` lists Collections and
        `POST /space/:spaceId/` creates one; `DELETE /space/:spaceId/` deletes
        the Space; `PUT` at the bare Space URL is 405; the bare form
        308-redirects to the trailing-slash form
  - [x] `/space/:spaceId/collections` and `/collections/` are retired, the
        segment stays reserved, and the path MAY 308 to the Space URL
  - [x] Collection routes: `GET`/`PUT` at `/space/:s/:c/meta` read and write the
        merged object, `PUT` creating the Collection when absent;
        `GET /space/:s/:c/` lists members, `POST` adds one,
        `DELETE /space/:s/:c/` removes the Collection, `PUT` at the bare
        Collection URL is 405
  - [x] One validator. The description and metadata storage-port pairs collapse
        into one, the filesystem sidecar merges into the description file, and
        the Postgres `description_*` / `meta_*` column pairs unify under a
        migration. The lock namespaces that are deliberately disjoint today
        become one, and the comments saying why they were disjoint are replaced
  - [x] `If-None-Match: *` on the merged `PUT` means "create only if the
        Collection does not exist"; there is no never-written metadata state and
        no `DELETE` at `meta`
  - [x] `meta` joins the Space-level reserved Collection ids (it is already a
        reserved Resource id), and the Space-level route guard mirrors the one
        the Resource routes already have
  - [x] Container `url` members carry the trailing slash everywhere the server
        stamps one: the Space Metadata object, the List Spaces items, the
        Collection Metadata object, and the List Collection envelope. Resource
        URLs are unchanged. `lib/paths.ts` already has the `trailingSlash`
        option, so these are call-site fixes
  - [x] The ladder-delegation target rule is redesigned, not renamed. See the
        paragraph below; this box does not close on a mechanical substitution
  - [x] The conformance suite passes against the new route table

Context: WAS v0.5 moves a container's description to its `meta` sub-resource,
merges a Collection's description with its Metadata object into one object with
one validator, makes the trailing-slash form of a container URL canonical, and
turns the Space into an ordinary container whose `GET` lists Collections and
whose `POST` creates one. This server is the reference implementation and the
canonical "does the spec match an implementation?" check, so until it serves the
new table the spec text is unverified.

The persistence merge is the bulk of the work. A Collection's description and
its metadata are two objects today, with two validators, two storage-port method
pairs, a separate filesystem sidecar, and two sets of Postgres columns whose
schema comment states they are "deliberately INDEPENDENT". The filesystem
backend even takes disjoint locks so a metadata write and a description write
cannot block one another. All of that collapses into one object, one
`metaVersion`, and one lock.

The part that needs design before code is the ladder-delegation target rule in
`clientAnnexClause.ts`. Its predicate 3 exists precisely because the bare Space
URL and the trailing-slash Space URL are different targets today: the bare one
addresses the Space Description, so a narrow single-verb grant on it reaches
Update Space Description and Delete Space without being read as the broad
items-subtree grant. Under v0.5 the bare URL addresses nothing (it redirects),
the description moves to `/space/:spaceId/meta`, and `DELETE` keeps the trailing
slash -- so a `DELETE`-only grant on the Space URL is, by target string, the
same string as a broad subtree grant. The distinction the predicate rests on is
gone. Re-pointing `isBareSpaceUrlTarget` at the `meta` path handles the read
side, but expressing "DELETE the Space itself" narrowly needs a new answer. This
also intersects the spec's own WASS-2 (the container rule), which restated its
targets against the v0.5 layout.

Greenfield: no compatibility route table beyond the 308s the canonical-form rule
itself requires.

Status 2026-09-11: the server half is implemented (all acceptance boxes but the
conformance run). The `test/` API suites driven through `@interop/was-client`
0.60.0 fail against the new table by design until WCL-41 ships, and
`pnpm conformance:local` cannot pass until the suite's v0.5 pass lands; both are
the open touches above.

Status 2026-09-12: every acceptance box is met. Suite 0.16.0 is consumed and
`pnpm conformance:local` passes 262 of 262 with optional cases. The maintainer
waived the wallet-core WC-230 and app-connect-spec decision 0003 touches, so the
item is done; both stay open in their own repos.

### WAS-98: Serve the service description (first iteration, spec v0.5)

- status: done (2026-09-13)
- priority: high
- labels: was-v0.5, discovery, routes, cors
- blocked-by: WAS-97 (DONE) for the `"0.5"` entry to be true. The WASS-30 wire
  members were signed off 2026-09-11; only the `specs` key string stays
  provisional until the spec's WASS-36 rename
- touches:
  - wallet-attached-storage-spec: waived -- drafted 2026-09-11 on branch
    `service-description` (the Service Description section; decision
    `_spec/decisions/0006-service-description.md`, draft). The spec fixes no
    path for the document: it is found by a `Link` header
  - was-teaching-server: shipped -- `src/server.ts` or `src/plugin.ts` (the
    route and a global `onSend` hook for the `Link` header),
    `src/config.default.ts` (the instance-disclosure switch), `src/plugin.ts`
    (the CORS registration already exposes `Link`),
    `test/service-description-api.test.ts` (new), `test/cors-preflight.test.ts`;
    ARCHITECTURE.md (the request lifecycle gains a hook every response passes
    through); a CHANGELOG entry
  - storage-core: shipped -- SC-5 there, archived 2026-09-13 (0.15.0 exports
    `ServiceDescription`, `ServiceDescriptionVersionEntry`, `PwsVersionEntry`);
    consumed from the registry 2026-09-13, and `buildServiceDescription` returns
    `ServiceDescription`
  - was-client: waived -- the fetch/parse helper and version selection before
    the first structural request (WCL-101 there, filed 2026-09-13)
  - was-conformance-suite: waived -- a discovery check that follows the `Link`
    from an arbitrary URL, including a 404, and validates the document (moved to
    WAS-106)
- acceptance:
  - [x] `GET {serverUrl}/service` returns the service description as
        `application/json` with no authorization,
        `Access-Control-Allow-Origin: *`, `Cache-Control: public, max-age=...`,
        and an `ETag`. Fastify's implicit `HEAD` serves the bodyless form. The
        path is this server's choice, since the spec reserves none
  - [x] Every response carries `Link: <{serverUrl}/service>; rel="service"`:
        200s, the maximum-privacy 404s, 308 redirects, `OPTIONS` preflights, and
        error responses produced by the error handler. The hook appends to an
        existing `Link` header rather than replacing it, since pagination and
        policy responses already set one. A test asserts the header on an
        unauthorized `HEAD` of a private Resource and on a paginated listing
        whose `Link` has two relations
  - [x] `Access-Control-Expose-Headers` includes `Link` on every response; it
        already does through the CORS registration, and the test pins it so a
        CORS change cannot regress it
  - [x] The document is `{ url, specs, instance }`. `url` is the absolute
        service description URL. `specs` carries one entry under the spec's
        persistent identifier (provisionally `https://w3id.org/pws`) with
        `version: "0.5"`, `spaces` (absent when the Spaces Repository is
        disabled by configuration), `features`, `signatureAlgorithms`, and
        `zcapCryptosuites`. All URLs absolute, built from `serverUrl`
  - [x] `features` lists only what this configuration serves. The baseline for
        the default configuration is `listing`, `collection-management`,
        `space-management`, `linksets`, `policy`, `metadata`, `export`,
        `backends`, `query`, `quotas`. A feature the configuration disables (for
        example an unregistered backend provider) is not listed. Per-Backend
        tokens (`conditional-writes`, `chunked-streams`, `key-epochs`, the query
        profiles) stay on the Backend description and are not repeated
  - [x] `signatureAlgorithms` and `zcapCryptosuites` are derived from what
        `zcap.ts` actually verifies (`eddsa-jcs-2022`, and
        `Ed25519Signature2020` until WAS-69 drops it), not hand-typed, so WAS-69
        changes the advertisement by construction
  - [x] `instance` carries `name` (the package name), `source` (the repository,
        which also satisfies the AGPL network-source obligation), and
        `homepage`. `version` is included by default on this server, because
        `/health` and the welcome page already publish the exact build; one
        configuration switch removes the version from all three places together,
        for a hardened deployment
  - [x] The `"0.5"` entry is advertised only once WAS-97's route table is what
        the server serves. If this item lands first, the entry says `"0.4"` and
        the switch to `"0.5"` is part of WAS-97's acceptance
  - [x] The conformance suite's discovery check is tracked by WAS-106 (moved
        2026-09-13)
  - [x] Linkset builders (`buildLinkset` in `src/policy.ts`) add the `service`
        relation to the Space and Collection linksets

Context: WASS-30 adds the negotiation step WAS lacked. A client choosing a host
at signup, or deciding which URL layout to speak after WAS-97's breaking change,
needs an answer before any Space-scoped request is possible, and every signal
this server emits today (linksets, the Backend `features` array, `/health`) is
either Space-scoped or not a protocol feature. The spec settles the mechanism:
no fixed path, a `Link` header with the `service` relation on every response,
two CORS MUSTs, and a `specs` object keyed by persistent spec identifier whose
entries carry `version`, endpoint URLs, and feature tokens. A response with no
`service` link identifies a pre-0.5 server, which is what this server is until
the item lands.

The implementation is small. The document is static per configuration and can be
built once at plugin registration. The `Link` header is one global `onSend`
hook; the only care point is that `reply.header('Link', ...)` elsewhere already
carries pagination and policy links, so the hook reads the existing value and
appends. The CORS registration already lists `Link` under `exposedHeaders` and
uses `origin: '*'`, so the two spec MUSTs hold today for CORS requests; the test
pins them.

Two things this item does not do. It does not make the server mountable on a
subpath: `assertValidServerUrl` still rejects a `serverUrl` with a path, and
that is WAS-23. The spec's discovery design exists so that subpath mounting
works for clients; this server simply keeps its origin-root constraint until
WAS-23 lifts it, and the document's absolute URLs are built the same way either
way. And it does not advertise `exchanges` or a KMS entry: those have no
specification to be keyed under yet (decision 0006's consequences), so the
ephemeral-exchanges and keystore routes stay undiscoverable through this
document until one exists.

Greenfield: no second entry for `"0.4"` alongside `"0.5"`. The spec allows a
server to list both during a transition; this server switches route tables in
one release (WAS-97) and advertises one version at a time.

Server part landed 2026-09-13 (`src/serviceDescription.ts`). Two notes from
implementation. No handler sets a `Link` header today: pagination uses the
body's `next` member and linksets are bodies. The append path is still in the
hook and is covered by a test with a synthetic route whose `Link` has two
relations, standing in for the paginated listing the acceptance names. The
version-disclosure switch is `WAS_DISCLOSE_VERSION` (plugin option
`discloseVersion`); with it off, `/health` also drops the build commit and time.
The remaining box waits on the conformance suite's discovery check.

Status 2026-09-13: every server acceptance box is met. The service description
is typed with storage-core 0.15.0's `ServiceDescription`, and an app composed
without a `serverUrl` answers 404 at `/service`, since the spec requires `url`.
The full gate passes (1357 tests) and `pnpm conformance:local` passes 262
of 262. The maintainer moved the conformance discovery check to WAS-106 and
waived the spec and was-client touches, so the item is done; WCL-101 stays open
in was-client and the spec text rides its `service-description` branch.

### WAS-105: Fix the flaky List Keys ordering assertion

- status: done (2026-09-13)
- priority: low
- labels: tests, kms
- acceptance:
  - [x] `test/kms-key-api.test.ts` checks the List Keys order with the code-unit
        comparator the server sorts by (`compareCodeUnits`), not `localeCompare`
  - [x] The suite passes regardless of the case mix of the generated key ids

discovered-from: WAS-98. The assertion near line 1009 sorts the listed local ids
with `localeCompare`, which orders `z1ADnF...` before `z1ADVm...`, while the
server's keyset order puts uppercase first. It fails only when the random ids
differ first at a letter-case boundary; it failed once in a full run on
2026-09-13 and passed on seven reruns.

Both `localeCompare` sorts in the suite now use `compareCodeUnits` from
`src/lib/pagination.ts`, the comparator the backends' keyset order uses. The
paginated case's fixed-width ids were unaffected but switched for consistency.

### WAS-60: Enforce the container rule (unsafe methods at a container URL are controller-only)

- status: done (2026-09-13)
- priority: high
- labels: security, zcap, authorization
- touches:
  - wallet-attached-storage-spec: WASS-2 in that repo's ROADMAP.md defines the
    rule (Delete Space, Update Space Metadata, Delete Collection, Update
    Collection Metadata become direct-root-invocation only, and Collection
    creation, a `POST` to the Space URL under v0.5, classifies as exact-target
    delegable); this item is the enforcement half and follows the spec text,
    including the Space DELETE exception and the delegated collection PUT
    exception below, both of which WASS-2's text must state before this item
    enforces them. WASS-2's targets were restated for the v0.5 layout (WASS-29):
    the two description writes are `PUT`s of the `meta` sub-resource, and every
    container URL carries a trailing slash
  - was-teaching-server: `src/requests/SpaceRequest.ts` (`putMeta`, `delete`,
    `post`), `src/requests/CollectionRequest.ts` (`putMeta`, `delete`),
    `src/routes.ts`, `src/lib/clientAnnexClause.ts` (the clause predicate
    covering the exception's ladder-signed case, freewallet FW-400 W3),
    AGENTS.md
  - wallet-core: WC-232 is the annex-side statement of the gap this item closes.
    Under v0.5 the generation delegation's target (the trailing-slash Space URL)
    IS the Delete Space URL and contains the Space Metadata URL, and
    `clientAnnexChainInspector` returns `{ valid: true }` at its
    `ladderLinks.length === 0` short-circuit, so a generation delegation signed
    by an enrolled client's promoted signer (the default arm) reaches both
    writes unchecked. Its action-set comments in `src/clientAnnex/log.ts` name
    that as an open gap until this lands
  - was-client: no change expected; its Collection-create binding already posts
    to the Space URL (WCL-41)
  - conformance-suite: negative-path assertions (a delegated capability with
    `allowedAction` covering `PUT`/`DELETE` invoked at a Space or Collection URL
    is denied with the maximum-privacy 404) and a positive assertion for
    exact-target delegated Collection creation
- acceptance:
  - [x] `PUT /space/{id}/meta` and `DELETE .../{collectionId}/` accept only
        direct root-capability invocation by the Space controller; a delegated
        capability is refused regardless of its `allowedAction`
  - [x] `PUT .../{collectionId}/meta` accepts direct root-capability invocation,
        and additionally a delegated capability whose `invocationTarget` is the
        Space's items subtree (the trailing-slash Space URL, the shape a
        generation delegation carries) and whose `allowedAction` covers `PUT`. A
        delegated capability whose target is the collection container URL
        itself, or a resource URL, is refused. This second exception is
        mandatory (freewallet FW-400 W2, decided 2026-09-01 under its review
        R3); see below
  - [x] `DELETE /space/{id}/` accepts direct root-capability invocation, and
        additionally a delegated capability whose `invocationTarget` is exactly
        that Space's canonical (trailing-slash) URL and whose `allowedAction` is
        exactly `['DELETE']`. This exception is mandatory (see below); it holds
        whatever DID method the Space's controller uses
  - [x] Regression tests for the exception: an exactly-`['DELETE']` delegation
        on the Space's canonical URL stays admitted, while a two-verb delegation
        carrying `DELETE` (say `['GET', 'DELETE']`) is refused, as is a
        `['DELETE']` delegation whose target is a prefix rather than that
        Space's own URL, and one whose target is the slash-less spelling
  - [x] Regression tests for the enrolled-client-signed arm (wallet-core
        WC-232): a generation delegation signed by an enrolled client's key, not
        a ladder VM's, invoked by a transient visit's annex VM, is refused
        `DELETE` on the account Space's canonical URL and `PUT` on its Metadata
        URL; a delegated-clients delegation (`['GET', 'PUT']` over the annex
        Space's container URL) is refused `PUT` on the annex Space's Metadata
        URL. The existing clause test covers the ladder-signed chain only
  - [x] Regression tests for the collection-PUT exception: a delegated
        `PUT .../{collectionId}/meta` under a Space-subtree delegation is
        admitted (a transient session's unlock-methods registry write, a
        generation collection create, and App Connect collection provisioning
        all ride this shape), while the same PUT under a capability targeting
        the collection container URL is refused
  - [ ] Every request freewallet's account-deletion ceremony and transient login
        send stays admitted with enforcement on: freewallet's `tests/e2e-was/`
        suite runs green against this server version before freewallet adopts it
        (waived at close, 2026-09-13: freewallet still pins was-client 0.60, a
        pre-v0.5 client, so its e2e suite fails at signup with a 405 against any
        v0.5 server; the run is owed by freewallet's v0.5 adoption item, and
        every shape those paths send is covered by the server tests and the
        conformance cases instead)
  - [x] Collection creation (`POST /space/{id}/`) stays where v0.5 put it and
        accepts an exact-target delegated capability (per the WASS-1 / WAS-59
        classes); the container rule does not make it controller-only
  - [x] The Update Space Metadata path (`SpaceRequest.putMeta`) keeps its
        body-controller consent check (`verifyBodyControllerConsent`) on top of
        the new rule
  - [x] Server `test/` coverage for each refused and permitted case, plus the
        conformance assertions above

Split out of wallet-attached-storage-spec WASS-2 (2026-08-20), which keeps the
spec half. Today all four container unsafe handlers run capability-only
verification (`fetchSpaceAndVerify` / `handleZcapVerify`) that accepts a
delegated chain attenuating from the Space root, so a Space-scoped grant
carrying `DELETE` can delete the Space or any Collection in it. Collection
creation is `POST /space/{id}/` (`SpaceRequest.post`); this item's original text
routed it through a reserved `collections` endpoint, which WASS-29 retired, so
WASS-2 now classifies the `POST` at the Space URL as exact-target delegable
instead.

Sequencing against WAS-59, revised 2026-09-13: independent, and this item goes
first. The original ordering rested on the `collections` create route, which
needed WAS-59's exact-target class for reserved path segments; that route is
gone. Everything this item governs (the container DELETEs, the two `meta` PUTs,
the Space-URL create POST) is decided in the Space and Collection request
handlers on the invoked verb, the invoked URL, and the chain's link shapes,
while WAS-59 reclassifies what `attenuatedRootTarget` covers at the reserved
endpoints. Neither needs the other's rule. WC-232 makes this item the one
closing a live authority gap on every account with a transient login, where
WAS-59 closes exposures that need a deliberately crafted grant.

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
method. The root-only rule stands unchanged for `PUT /space/{id}/meta` and for
both collection container methods. The ladder-signed case is additionally
bounded by the client-annex clause's third predicate (FW-400 W3, target-exact
against the parent capability's own `invocationTarget`, admitting exactly
`['DELETE']` and exactly `['GET']`), which lands with WAS-67's narrowing of
predicate 1.

The rule must be signer-independent (wallet-core WC-232, 2026-09-13). The
clause's invocation-time bound (`ladderInvocationRefusal`) already refuses the
Space Metadata PUT and the non-target-exact Space DELETE, but only on a chain
carrying a ladder-signed link. The generation delegation is signed by the
account ladder VM OR by an enrolled client's promoted signer, and the second is
the default (freewallet's `ensureGenerationDelegation`, the revocation cascade's
re-mint, wallet-core's GC swap). An enrolled client's key is published under all
four document relations, so it is not a ladder VM, the chain carries no ladder
link, and the bound never runs. Before WAS-97 both writes sat outside the
delegation by layout (the slash-less Space URL); after it, the DELETE is at the
delegation's target and the Metadata PUT one segment inside it. The remedy is
this item's route-level rule, keyed on the exact verb-and-target shape of every
link rather than on who signed one, not a narrowing of the generation
delegation's action set (a permanent app-connect-spec wire artifact whose
structural attenuation would cap every transient App Connect grant).

Closed 2026-09-13. Shipped as a third chain inspector
(`src/lib/containerRule.ts`) composed into `handleZcapVerify` through a
`containerRule` option, reading the invoked capability alone. Touches resolved:
spec text landed (WASS-2 done); wallet-core WC-232 done (comments and changelog
corrected); conformance suite 0.17.0 carries the `container-rule` cases (273/273
locally); was-client waived as expected; the freewallet e2e run waived as noted
in its box. The residual self-narrowing path on the enrolled-client-signed arm
is WAS-107.

### WAS-109: A ladder-signed read of one Resource in an unlock Space

- status: done (2026-09-13)
- priority: medium
- labels: was-v0.5, zcap, authorization, client-annex
- touches:
  - was-teaching-server: `src/lib/clientAnnexClause.ts` (the admission
    predicates and the invocation-time bound), ARCHITECTURE.md's client-annex
    clause paragraph
  - wallet-core: WC-231 mints whatever shape this settles on
    (`src/clientAnnex/spaceCapability.ts`) -- waived 2026-09-13 (maintainer):
    the minter lands under WC-231 in its own repo
  - freewallet: `src/session/unlockMethods.ts` (`unlockEntryReaderFor`) and
    `src/session/accountSettings.ts`'s copy of the same reader -- waived
    2026-09-13 (maintainer): the readers follow WC-231 in their own repo
  - wallet-attached-storage-spec and app-connect-spec decision 0003: to be
    assessed if the clause gains a predicate, since predicate 3's shape is
    restated there -- waived 2026-09-13 (maintainer): the dated amendment adding
    the fourth admitted form is handled by the user
- acceptance:
  - [x] A decision, signed off before any code, between (a) the clause admits a
        ladder-signed read of one Resource in an unlock Space, with its exact
        target, verb set, and parent bounds, and (b) the clause stays as it is
        and the wallet reads the keyring record through an authority that is not
        ladder-signed
  - [x] On (a): the predicate is implemented, the invocation-time bound still
        refuses every write it refuses today, and tests in `test/` assert the
        new shape is admitted and a widened sibling (another Resource path, a
        second verb, a Collection target) is refused
  - [ ] (n/a) On (b): the clause's header comment states that a ladder-signed
        Resource read is refused on purpose, and WC-231 is told which authority
        the wallet uses instead

WAS-97 split predicate 3 by verb. Its GET branch admits only a target-exact
`GET` of the Space Metadata object (`/space/<S>/meta`, `allowedAction` exactly
`['GET']`). Under the v0.4 layout the GET branch targeted the bare Space URL,
and WAS-97's own design note records that the zcap library's `/`-boundary prefix
rule let that target cover the Space's subtree. So a GET-only child of a stored
management zcap could read a Resource inside the Space. WAS-97 removed that
reach, and nothing replaced it.

freewallet relied on it. A transient session holds no enrolled-client key, only
the ladder VM, which stands under `capabilityDelegation` but not
`capabilityInvocation`. To read an unlock Space's keyring record it mints a
three-link chain: the unlock Space's root, the management zcap the unlock
identity delegated to the account DID at bind time, and a `['GET']` child signed
by the ladder VM for its own bare did:key. wallet-core now narrows that child's
target to the Space Metadata object, which serves the Space existence probe but
cannot name the keyring record. No current predicate admits a ladder-signed read
of that Resource: predicate 1 is bound to the annex DID and the account Space,
predicate 2 to the bridge and delegated-clients targets, and predicate 3 to
Space delete and Space Metadata read.

Option (a) would widen what a ladder VM may sign, so it has to keep the clause's
locked property (no ladder authority whose exercise leaves no record beyond a
read or a destruction). A plausible bound is a `['GET']` child whose target is a
Resource URL under the parent's own Space URL, parented on a delegated
capability whose target is that Space. Whether it is limited to unlock Spaces,
and how the server would recognize one, is part of the decision.

discovered-from: WAS-97. Filed from wallet-core WC-231.

Decided 2026-09-13: option (a), with no unlock Space special-casing. The shape
is predicate 4 in `src/lib/clientAnnexClause.ts`: a `['GET']` delegation whose
target is a Resource URL `/space/<S>/<C>/<R>` (reserved segments excluded),
under a parent targeting that same URL or the Space's canonical trailing-slash
URL, root or delegated. Touches: the server half shipped; the wallet-core,
freewallet, and decision 0003 entries were waived at close (2026-09-13), so
WC-231 and the freewallet readers stay open in their repos (they mint the
shape), and app-connect-spec decision 0003, which restates the clause's locked
property with the admitted forms, still needs a dated amendment adding this one,
handled by the user.

### WAS-110: `space-subtree-put` refuses a collection-scoped grant's Metadata writes

- status: done (2026-09-14)
- priority: high
- labels: was-v0.5, security, zcap, authorization
- touches:
  - was-react: WR-47 records the app-side half of this conflict;
    `src/storage/wasSync.ts` and `src/storage/wasRemoteStore.ts` make the three
    writes this rule refused -- WR-47 closed 2026-09-14 (done, no code change:
    the writes pass as written)
  - wallet-core: unaffected (the index declarations stay app-side)
  - wallet-attached-storage-spec: unaffected (the spec has no such rule, and
    none is added)
  - was-conformance-suite: `container-rule-api`'s Collection-URL grant case
    flipped from a refusal to an admission (0.18.0, TBD)
- acceptance:
  - [x] `PUT /space/{s}/{c}/meta` carries no container rule: a delegated
        capability targeting the Collection container URL or the Collection
        Metadata URL writes the object (`src/requests/CollectionRequest.ts`)
  - [x] `PUT /space/{s}/{c}/meta/log` keeps `space-subtree-put`
  - [x] `test/container-rule-api.test.ts` asserts both admissions
  - [x] ARCHITECTURE.md's container-rule paragraph and CHANGELOG.md restated

Draft rather than todo: the unreleased `space-subtree-put` container rule
(`src/lib/containerRule.ts`, in 0.33.0) guards `PUT /space/{s}/{c}/meta` and
`PUT /space/{s}/{c}/meta/log`. It accepts a direct root-capability invocation,
or a delegated capability whose tail targets exactly the Space's canonical
trailing-slash URL. A capability targeting the Collection container URL, the
Collection Metadata URL, or a Resource URL is refused.

was-react never holds a Space-subtree grant: every grant it gets, from a wallet
or from a dev-mode provisioner, is scoped to one Collection. Under this rule
that refuses three app-side writes to the merged Metadata object: marking a
collection encrypted when the wallet did not already declare it, a public
collection's plaintext index declaration, and the compare-and-swap that declares
a private collection's blinded-index schema. All three are best-effort on the
was-react side and degrade with a warning instead of failing the session, but
equality queries on an undeclared index then fail.

The spec does not mandate this rule, so the conflict is a server decision, not a
spec violation, and there is nothing to accept yet. Three ways out: relax the
rule to also admit a collection-scoped grant on these two paths; move the index
declarations wallet-side, provisioned at grant time instead of written by the
app during sync; or have the wallet delegate a Space-subtree grant for this
purpose instead of a Collection-scoped one. See was-react WR-47 for the app-side
half of this.

Resolved 2026-09-14 by relaxing the rule on `PUT .../meta` only. The prefix
hazard is weak on that path: a holder of a Collection data grant already writes
and deletes every Resource in it, the `encryption` descriptor is immutable once
set, and Delete Collection stays controller-only. The log write keeps the rule,
since was-react never writes it and the guarded create is a permanent governance
declaration.

### WAS-106: Conformance checks for service description discovery

- status: done (2026-09-14)
- priority: high
- labels: was-v0.5, discovery, conformance, tests
- touches:
  - wallet-attached-storage-spec: the Service Description section, drafted on
    branch `service-description` (decision
    `_spec/decisions/0006-service-description.md`); the checks' `specRefs`
    anchor into it. Unaffected: the anchors already exist on that branch, no
    spec change needed
  - was-conformance-suite: a new `src/suites/service-description-api.ts`,
    registered in `src/suites/index.ts`; a CHANGELOG entry and a version bump.
    Done 2026-09-14 (suite 0.19.0 published, 9 checks)
  - was-teaching-server: the `@interop/was-conformance-suite` devDependency
    bump; the server behavior under test shipped with WAS-98. Done 2026-09-14
    (suite 0.19.0 published and consumed, `pnpm conformance:local` 282/282)
- acceptance:
  - [x] The suite follows the `rel="service"` link rather than assuming
        `/service`, since the spec reserves no path. It starts from the server
        base URL and resolves the link target against the response URL
  - [x] The `Link` header with the `service` relation is asserted on a 200, on
        an error response (an unauthenticated read of a Space that does not
        exist), on a 308 slash-variant redirect, and on a CORS preflight, and
        every one points at the same URL (spec
        `#discovering-the-service-description`)
  - [x] `Access-Control-Expose-Headers` includes `Link` on those responses, and
        the document is served with `Access-Control-Allow-Origin: *`
  - [x] The document is read with no capability invocation and validated against
        the data model (spec `#service-description-data-model`): `url` and
        `specs` present, `specs` an object of arrays, each entry's `version` a
        bare `major.minor` string, and every URL member absolute
  - [x] The `https://w3id.org/pws` key carries an entry whose `version` is
        `"0.5"`. Its `features`, `signatureAlgorithms`, and `zcapCryptosuites`
        members are arrays of strings when present, and its `spaces` member,
        when present, answers `GET` as a Spaces Repository
  - [x] The `Cache-Control` and `ETag` SHOULD is an optional case, with a
        conditional re-read answering 304
  - [x] Every check carries `specRefs` into the Service Description section
  - [x] The suite is published and consumed here, and `pnpm conformance:local`
        passes with the new checks

discovered-from: WAS-98. That item's last acceptance box was the suite's
discovery check, and it moved here when WAS-98 was archived. The suite repo
keeps no roadmap of its own, so the item lives in this one. The checks assert
only what the spec requires of every server. This server's specifics stay in
`test/service-description-api.test.ts`: the `/service` path, the `features`
baseline, the `instance` members, and the `WAS_DISCLOSE_VERSION` switch.

### WAS-107: Self-narrowing under an enrolled-client-signed Space-subtree grant

- status: done (2026-09-14)
- priority: high
- labels: security, zcap, authorization, client-annex
- touches:
  - was-teaching-server: `src/lib/clientAnnexClause.ts` (the chain walk and
    `ladderInvocationRefusal`), `src/lib/containerRule.ts` (unchanged, its
    tail-only reading stays), ARCHITECTURE.md's "Chain inspection" and
    container-rule paragraphs (done here: `transientAnnexInvocationRefusal`
    beside the ladder bound)
  - wallet-core: WC-233 is the annex-side statement of this gap; its
    `GENERATION_DELEGATION_ACTIONS` comment states the closing rule (already
    shipped there; nothing further to file)
  - wallet-attached-storage-spec: unaffected (the container rule's Delete Space
    exception keeps reading the invoked capability; the new bound is a
    client-annex clause rule, not a container-rule change)
  - app-connect-spec: unaffected (the generation delegation's shape and its
    re-delegation are unchanged)
  - freewallet / dcw: unaffected (no code change; the admitted delete shapes
    gain server tests)
- acceptance:
  - [x] The client-annex clause's chain walk classifies a link whose delegation
        proof method resolves in the annex document under `capabilityInvocation`
        (a transient annex VM) beside the ladder-signed category it already
        collects
  - [x] A Space DELETE on a canonical Space URL, or a Space Metadata PUT, is
        refused when any link in the chain is signed by a transient annex VM,
        whoever signed the links above it
  - [x] The residual admission test in `test/container-rule-api.test.ts`
        ("admits an annex-VM DELETE-only target-exact child of the generation
        delegation") flips to a 404 with the Space surviving
  - [x] The same refusal is tested against the delegated-clients sibling
        delegation targeting the auxiliary annex Space URL
  - [x] Admit tests stay green for the shapes freewallet invokes: a DELETE-only
        child of a two-verb `['GET', 'DELETE']` management parent (existing), a
        DELETE-only child of a three-verb `['GET', 'PUT', 'DELETE']` management
        parent with a ladder-VM-signed tail (new), and a two-link
        root-then-DELETE-only child signed by a ladder VM (new)
  - [x] ARCHITECTURE.md's "Chain inspection" paragraph states the bound, and the
        container-rule paragraph stops describing this arm as open
  - [x] CHANGELOG entry

The container rule's Delete Space exception reads the invoked capability alone:
target exactly the Space URL, `allowedAction` exactly `['DELETE']`. That is what
lets freewallet delete an unlock Space through a DELETE-only child of its
two-verb management grant. The same property leaves one path open on the
enrolled-client-signed arm. A transient visit holds a generation delegation (the
Space-subtree grant with the full verb set) signed by an enrolled client's key.
Its annex verification method stands under `capabilityDelegation` as well as
`capabilityInvocation`, so it can mint a child of that delegation with the same
target and `['DELETE']`, and invoke the child. The child satisfies the
exception, and no ladder link is in the chain, so the client-annex clause's
ladder bound never runs. The test file `test/container-rule-api.test.ts` asserts
this admission so a change here is noticed.

Remedy (decided with wallet-core WC-233, 2026-09-14): the bound keys on the
signer, not on the delegation's shape. A per-visit key's own delegation never
ends an account or its annex, so a Space DELETE whose chain carries a link
signed by a transient annex VM is refused (a Space Metadata PUT is already
controller-only at the route). The clause already resolves every
did:webvh-signed link's proof method to classify ladder VMs by relation
asymmetry; the transient VM is recognized by the shape of the signer's own
document, under `capabilityInvocation` and `capabilityDelegation` and no other
relation, rather than against the annex DID the `DelegatedClients` service entry
names, so a retired generation the entry no longer names and an annex a did:key
controller delegated to directly are covered too. The container rule stays
tail-only, so the management-grant shape freewallet relies on is untouched. No
legitimate delete is signed by a transient VM: freewallet's transient-login
deletion signs its DELETE-only children with the ladder VM and invokes them
under a did:key, and the annex GC's re-mint is signed by an enrolled client.

The alternative, reading the links above a DELETE-only tail in the container
rule and refusing any that grant POST, was set aside: it draws the management
line at one verb, and a signer-independent rule was no longer needed once the
transient VM was identified as the only signer with no legitimate delete.

discovered-from: WAS-60.
