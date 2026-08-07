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
