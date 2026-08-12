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
