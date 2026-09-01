# 0002: The client-annex clause admits target-exact single-verb ladder delegations

- Status: accepted
- Date: 2026-09-01
- Driving work: the browser wallet's transient account-deletion design
  gate. A transient session deletes the account's Spaces through
  ladder-signed DELETE-only delegations, and reads otherwise
  unreachable sibling Spaces through GET-only ones; the clause needed a
  predicate that admits exactly those shapes.
- Affects: was-teaching-server (`src/lib/clientAnnexClause.ts`, a third
  admission predicate; the locked-property comment; ARCHITECTURE.md's
  restatement). The clause's normative home is app-connect-spec
  `decisions/0003` and the companion-profile text it governs, amended
  in step; wallet-core and the wallets mint the shapes it admits.

## Context

The clause bounds what a ladder VM's delegations may do. Its predicate
1 (pointer equality on the annex DID) is target-blind today and is
being narrowed; it also only ever admitted an annex-DID delegatee. The
deletion ceremony's delegatee and invoker is the ladder VM's own bare
did:key -- the one identity that keeps resolving while the walk deletes
the Spaces every hosted document lives in -- so predicate 1 never
admitted the ceremony's chains and this predicate is their only
admission path. The chains come in two lengths: a child of a sibling
unlock Space's `manageCapability`, and a child of a Space's own
synthesized root for the account and annex Spaces.

## Decision

A ladder-signed delegation is admitted when its `invocationTarget` is a
bare Space URL and its `allowedAction` is exactly `['DELETE']` or
exactly `['GET']`. When the parent is a delegated capability, the
target must equal the parent's unchanged; when the parent is the
synthesized Space root, the target must equal that root's own Space
URL. Both chain lengths are covered, for all Space kinds. The ladder VM
is identified the way the clause already identifies it, by relation
asymmetry, not by any new derivation.

The clause's locked property is restated to cover the new shape: every
admitted ladder delegation either resolves through a loud annex entry,
can only write a log, or is a target-exact single-verb GET or DELETE on
one Space of the delegator's own account -- a read, or a destruction
whose account-Space case removes the log any record would live in.
Two bounds keep the widening narrow: on the `manageCapability` arm the
parent already carries DELETE on exactly that Space URL, so the
predicate widens who signs the last link rather than what the account
may do; and the child's target is its parent's unchanged, so the ladder
VM cannot aim it anywhere new.

## Rejected Alternatives

- **Relying on predicate 1's target-blind admission.** That admission
  is exactly what is being narrowed, and it never admitted a did:key
  delegatee anyway.
- **A general ladder-may-delegate-anything predicate.** Rejected
  outright; it dissolves the clause.
- **Identifying the ladder VM by subject instead of relation
  asymmetry.** Carries the identification pitfalls the existing rule
  avoids: action-set normalization, a verification method the predicate
  never receives, and an embedded-node method that yields no multibase.

## Consequences

- The predicate lands together with predicate 1's narrowing; without
  it, every Space DELETE the deletion ceremony sends fails.
- The container rule's enforcement pass must carry the WAS profile's
  two exceptions (the exact-target single-verb Space DELETE, and the
  delegated collection PUT under a Space-subtree parent) or it refuses
  the ceremony's DELETEs and today's remembered-session unlock-Space
  delete alike.
- A DELETE admitted under this predicate writes no log; that carve-out
  is the amendment app-connect-spec `decisions/0003` records against
  its previously absolute locked property.

## Revisit Criteria

Reopen this decision when one or more of the following holds:

1. app-connect-spec `decisions/0003` changes the clause's normative
   predicates; this record follows the normative home.
2. A new ceremony needs a third action set or a changed target rule;
   extend as a new enumerated shape rather than loosening the
   target-exactness or the two-verb bound.
