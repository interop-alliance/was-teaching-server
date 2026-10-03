# 0004: A write stamp is minted by this server or carried from a peer, by nothing else

- Status: accepted
- Date: 2026-10-02
- Driving work: the multi-primary Spaces design
  (`designs/WAS-96-multi-primary-spaces.md`, approved 2026-10-02). The design
  replaces the per-record version counters with an origin stamp (a hybrid
  logical clock plus an origin id) that peers compare to pick the winning write,
  so where a stamp may come from decides whether replicas converge.
- Affects: was-teaching-server (`src/lib/hlc.ts`; both backends' write critical
  sections and `apply*` methods; `src/backends/filesystemStore.ts` and the
  Postgres store row, which hold the origin id and the clock's high-water mark;
  the import plan in `src/lib/importPlan.ts`; `docs/admin-guide.md`;
  ARCHITECTURE.md beside the cache entries that already rest on a
  single-instance deployment). `@interop/space-archive` keeps archived stamps in
  its Metadata files, which import now reads for provenance only. The wallet's
  restore flow warns when the destination Space has registrations.

## Context

Under last-writer-wins, the greater stamp wins on every replica, and a stamp is
never re-examined once stored. Anything that lets a stamp into a store without
the clock discipline can therefore break convergence for good: a stamp dated far
ahead beats every honest write until physical time catches up, and two different
writes under one stamp let a peer dedup the second away. The design already
rejected a client-declared clock for this reason. Three other doors were open.

Import restored archived stamps verbatim in the draft. A delegated importer
could then land a stamp dated far in the future, and every peer's pull of that
Collection would stall at the clock bound permanently.

Two server processes over one Postgres store would share one origin id and mint
identical `(ms, 0, originId)` for two successive writes to one record, giving
different bytes the same strong validator.

A data directory booted before stamps existed holds records with no stamp at
all, and the clock is in memory, so after a restart it can stand below a stamp
the store already holds.

## Decision

A stamp enters this store by exactly two paths: the local clock, inside the
write's critical section, or a peer's stamp, through the apply path.

- The local mint is `max(hlc.now(), held + one counter tick)` under the record's
  lock, after the clock observes the held stamp. The backend persists a
  high-water mark of the clock in `store.json` or the store row on a cadence and
  seeds the clock from it at boot. A local write therefore never carries a lower
  stamp than the one it overwrites.
- Import re-mints every stamp with the importing server as origin, as
  `updatedAt` is re-stamped today. The archived stamps are read for provenance
  verification only.
- One minting process per origin. A store is served by one server process; this
  is documented in ARCHITECTURE.md beside the cache entries that already rest on
  it, and in the admin guide. The multi-process case is parked as a later item.
- A store holding any Space whose records carry no stamp is refused at boot with
  `StoreVersionError`. There is no stamping migration. An empty store is stamped
  at the new layout version and boots.
- The apply path refuses a received stamp whose `originId` equals the local one,
  and shape-checks every received stamp before storing it (`ms` and
  `updatedAtCounter` safe non-negative integers, `originId` within
  `[A-Za-z0-9_-]{1,64}`).
- On the filesystem backend the sidecar, which holds the stamp and the feed
  position in one write, is the commit point: the representation lands first,
  under a name the sidecar then points at, so a torn write reads as the prior
  revision.

## Rejected Alternatives

- **Restoring archived stamps verbatim on import.** A client-declared clock by
  another door. Whoever holds an import grant chooses the stamp, and a stamp
  dated ahead of every peer's clock stalls their pulls of that Collection with
  no honest write able to beat it.
- **A per-process origin suffix, so several processes can share a store.** It
  makes the origin id a process property rather than a store property, which is
  what the origin id's permanence (the `WAS_ORIGIN_ID` mismatch refusal, the
  duplicate-origin check) rests on.
- **Stamping old records at upgrade.** A migration would have to invent a stamp
  for each record from `updatedAt` alone, with no counter and no knowledge of
  what a peer holds. Under the greenfield stance the store is refused instead.

## Consequences

- A restored backup's records carry fresh stamps and beat concurrent peer
  writes, which is what importing asks for. The wallet's restore flow warns when
  the destination Space has registrations, since the restore will overwrite
  peers at their next pull.
- A cloned data directory carries its origin id with it. A clone that will run
  beside its source must boot with a fresh `WAS_ORIGIN_ID`; the duplicate-origin
  check in the apply path catches a direct pull between clones, and a third
  server pulling from two clones is a documented operator error it does not
  catch.
- A deployment running several server processes over one store is unsupported
  until the parked item lands.
- An operator upgrading a populated pre-stamp store wipes it or restores from an
  archive, whose stamps are re-minted on the way in.
- The high-water mark adds a write to the store file on a cadence, not per
  write.

## Revisit Criteria

Reopen this decision when one or more of the following holds:

1. A deployment needs more than one server process per store. Reopen the
   per-process suffix, or a shared clock in the store row, as that item's
   design.
2. A write-time creation or revision statement (signed by the creating origin
   and carried with the record) ships. An archived stamp that verifies against
   such a statement is no longer client-declared, and import may keep it instead
   of re-minting.
3. A populated deployment must upgrade in place without a wipe. Design a
   stamping step then, with the counter and origin rules stated.
