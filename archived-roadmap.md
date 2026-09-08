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
