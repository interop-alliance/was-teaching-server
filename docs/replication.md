# Replication

How a server replicates a Space from a peer server: the sync signer, replica
registrations and the checks they pass, the pull loop, and the apply path that
stores what the loop reads. The replication facet writes replicated records only
through the backend's `apply*` methods, and no request route can supply a write
stamp. [ARCHITECTURE.md](../ARCHITECTURE.md) holds the layer map and the
glossary (see Replica registration, Pull loop and Creating stamp there).

## The sync signer

`src/lib/syncIdentity.ts` holds the signer a server invokes a peer's
capabilities with when it replicates a Space. It is the same seed key as the
export-signing key, named as the method `{serverDid}#{publicKeyMultibase}`.

`loadSyncSigner` returns a signer only when `resolveServerDid` yields a
`serverDid` and the resolved document lists the key under
`capabilityInvocation`. `resolveServerDid` is described in
[server-identity-and-provenance.md](server-identity-and-provenance.md).
Otherwise `loadSyncSigner` returns a refusal with a reason: no advertised
`serverDid`, or the key not listed under `capabilityInvocation`. A storage fault
met while reading the log is thrown as its 5xx and is not a refusal.

A controller delegates the pull capability to `serverDid`, so a peer verifies
the invocation against the server's log. There is no second key and no
`/service` member. Listing the relationship is the switch that enables
replication. Every read a pull loop makes of a peer Space is signed with it
(`sync/peerClient.ts`).

## Registrations

`src/sync/` is the replication facet: replica registrations and their pull
loops. A registration is one source peer of a Space, a directed edge the
controller writes at `POST /space/:spaceId/replicas`
(`requests/ReplicaRequest.ts`). It carries:

- `id`
- `fromSpace`, the peer Space's URL
- `toSpace`, this Space's URL
- `capability`, the pull capability, delegated to this server's DID with
  `allowedAction` within `GET` and `HEAD`
- an optional `collections` list
- `role`, which is `source`

`GET` there lists the records as `{ url, totalItems, items }`. `GET` and
`DELETE` of `/space/:spaceId/replicas/:replicaId` read and remove one, and there
is no `PUT`. Every method is controller-only, the reads included, through the
container rule's `controller-only`.

A record is stored inside the Space (`.replica.<id>.json` beside
`.replica.<id>.state.json` in the filesystem Space dir, a row of the Postgres
`replicas` table), so Delete Space removes it. It is not replicated and not
exported. Storing or removing one advances the Space Metadata object's local
segment, since the served `replicas` member changed (see
[validators-and-stamps.md](validators-and-stamps.md)).

## Registration checks

`sync/registration.ts` holds the checks a registration passes before it is
stored. A malformed body is `invalid-request-body` (400). The rest read the
peer, and a break of one is `replica-refused` (409). The checks are:

- The local Space is not the `server` Space.
- This server has a sync signer, and the capability is delegated to its DID.
- The peer's `/service` lists the replication entry at this server's version and
  an `originId` that is not this server's (see
  [service-description.md](service-description.md)).
- The peer Space, read through the capability, has the local Space's `type` set,
  and a controller the local one matches.
- Each Collection both sides hold agrees on the immutable members.

The peer Space's id need not equal the local one.

The controller match has two branches. The two controllers are equal, or the
peer controller is a `did:webvh` hosted in the peer Space whose current document
lists the local Space's `did:key` controller under `capabilityInvocation`. The
second branch is the common order: a wallet promotes its Space to its
`did:webvh` before the Space gains a replica, and a new local Space is created
under one of the account's enrolled client keys. The local Space cannot be
promoted first, since the DID resolves here only through the registration.

For that branch the check reads the peer's `did.jsonl` through the pull
capability, verifies it offline, as a replicated copy is, and requires the
registration to pull the log's Collection, so the copy the promotion needs
arrives with the first pull. The DID is never fetched by itself. Once the first
pull lands, Update Space moves the local Space to the DID, and the controllers
are equal from then on. Without the controller check, a holder of any readable
pull capability could register another user's Space as a source and read the
copy through root invocations. A key the document lists under
`capabilityDelegation` alone, a ladder method, does not pass.

One check reads no peer. A registration is refused when another local Space
already replicates the same peer Space with a Collection in common, since a
`did:webvh` hosted in a Collection two local Spaces replicate resolves from
neither copy (see
[Where a replicated log lives](#where-a-replicated-log-lives)). Two
registrations on one local Space may overlap. The check is not atomic with the
write, so two concurrent registrations can both pass, and the resolver then
refuses the DID.

## Guards on Delete Replica and Update Space

Delete Replica is refused with the same `replica-refused` (409) while the
registration is the only one that maps a local Space's `did:webvh` controller to
a copy of its log. Removing it would leave that Space with no resolvable
controller, and both repairs, a new registration and Update Space, are
authorized by the controller. The handler scans every stored Space for such a
controller. The caller changes that Space's controller first. To replace a
registration, the caller adds the new one on the same Space before removing the
old one. A removal that ends a two-Space mapping is allowed. A keystore
controller is not checked. Delete Space and Delete Collection are not guarded
either: a replicated copy of a log goes away with its Collection or Space, as a
self-hosted log does.

Update Space is refused with the same `replica-refused` (409, pointer
`#/controller`) when the controller change would break a mapping. A registration
that lists its Collections always pulls the one holding its Space's controller
log, so a controller change moves what the Space's own registrations pull. It
touches at most two peer Collections: the one hosting the new controller's log,
which the change may add to a selection, and the one hosting the current
controller's log, which it may remove.

- An added Collection that another local Space's registration of the same peer
  Space already pulls is refused, since the DID would then resolve from neither
  copy and the new controller could not invoke to undo the change.
- A removed Collection the Space was the one holder of is refused while some
  local Space's controller is a `did:webvh` hosted there, since that Space would
  be left with no resolvable controller, the lockout Delete Replica refuses. A
  demotion back to a `did:key` is such a change.

The caller changes that Space's controller first, or registers the log's
Collection on this Space by name, which holds it whatever the controller.
`controllerChangeConflict` in `lib/webvhLogLocation.ts` decides both cases, and
shares the second with Delete Replica. The three checks read the stored
registrations and the other Spaces' controllers afresh, past the caches, so a
controller another process wrote a moment ago counts. A Space with no
registrations is not checked. None of the checks is atomic with its write.

## Where a replicated log lives

`src/lib/webvhLogLocation.ts` decides where this server stores the history log
of a `did:webvh`. A self-hosted DID's log is the one the DID names. A DID hosted
in a Space on a replication peer, `did:webvh:<scid>:<H>:space:<S>:<C>`, has a
local copy when exactly one local Space X holds a replica registration whose
`fromSpace` is `https://H/space/S/` and which pulls Collection C. The log is
then X's `C/did.jsonl`, and X need not be S. `locateWebvhLog` makes the mapping,
and the resolver reads that log through the same verify, cache, head-record and
fast-forward path as a native one (see
[webvh-controllers.md](webvh-controllers.md)).

The mapping goes through the registration because a local Space named S could
belong to anyone on this server. A registration passes the controller check in
`sync/registration.ts`, so only the peer Space's controller, or a current
invocation key of its `did:webvh` document, can make one. When two or more local
Spaces map one DID, it has no location and does not resolve from storage. An
older copy could list a retired key, and the head record is lost on restart, so
picking either copy would let the older one win.

The registrations are read through an index of every stored registration, cached
per backend for `REPLICA_INDEX_CACHE_TTL`. Storing or removing a registration
drops it, and so does Delete Space. The head record of a replicated DID is keyed
by the DID alone, so it survives a change of the local Space that keeps the
copy. The apply path's write of a `did.jsonl` drops the cached document, so a
key retired at the origin stops authorizing after the next pull.

Such a DID may be a Space controller, a keystore controller, a delegator, and
the `createdBy` of a write. `lib/serverIdentity.ts`, `lib/syncIdentity.ts` and
import provenance stay native-only. `invokerDid` (`createdBy`) also records a
DID resolved over the network, since the authorization that ran before decided
its key. A create the provisioning policy granted verifies no signature, so it
records no `createdBy`.

## The apply path

`src/lib/replicaApply.ts` holds the rules the apply path stores a replicated
record by. A storage backend's `apply*` methods take a record a pull loop read
from a peer and store it under the peer's write stamp and generation, so the
record's `ETag` here equals the peer's. No request route reaches them. Both
backends decide through this module. The write stamp and the clock are described
in [validators-and-stamps.md](validators-and-stamps.md).

A record is applied when its stamp sorts above the held one by
`(ms, counter, originId)`, and skipped otherwise. An equal stamp is a record
this server already holds, which is also what stops a record from travelling
round a two-way pair. Three records follow other rules:

- A history log (a Collection's governing log, or a `did.jsonl`) fast-forwards:
  the held bytes must be a prefix of the received ones, a prefix of the held
  bytes is skipped, and anything else is a fork.
- A Collection tombstone carries no generation. It removes any life of the
  Collection created before its stamp, with its members, whatever their stamps,
  so a delete wins over a later member write.
- Two lives of one Collection id are ordered by their creating stamps (see the
  Creating stamp entry in the [ARCHITECTURE.md](../ARCHITECTURE.md) glossary). A
  received life created after the held one replaces it, members included, and
  one created before it is skipped.

An update of a held life replaces the object except for the members that are
immutable once set (`encryption`, `revisions.resolution`,
`revisions.immutable`). One the received object omits is kept, and two different
set values are a fork.

Each apply method runs inside the critical section the matching request-layer
write takes, and checks there, in order:

1. The registration is still stored and was made for the Space's current
   generation, else `unregistered`.
2. The backend's clock takes the received stamps in, else `refused` with reason
   `clock-bound`.
3. The record's Collection is live, else `skipped`.

An applied record takes a local feed position, so it appears in this server's
own `changes` feed and a third server can pull it from here (see
[changes-feed.md](changes-feed.md)). Preconditions, the encrypted-Collection
envelope rule, the write-once rule and the unique-attribute claims are not
evaluated, since the origin server admitted the write. Quotas and the upload cap
are. The Space Metadata object replicates its `name` alone: `controller`, `type`
and the server-derived members stay per server. Revocations, backend
registrations, keystores and chunks are not replicated.

## The pull loop

`sync/replication.ts` is the `ReplicationManager`, one per app, decorated as
`replication`. It runs one pull loop per stored registration, started at
`onReady` and on registration. A cycle reads the peer Space's Metadata object
and policy (conditional reads), then its Collection listing under
`?include=deleted`.

The registration's `collections` list selects among the listed Collections, live
and tombstoned, and the Collection that holds the controller's history log is
always selected. The rule is `peerCollectionSelector` in
`sync/collectionSelection.ts`, which the pull loop shares with
`lib/webvhLogLocation.ts`, so the two cannot drift. A selected tombstone is
applied. One for a Collection the registration does not pull is ignored, so it
cannot remove a local Collection that shares its id.

For each selected live Collection the loop applies the Collection Metadata
object when this server does not hold that life of the Collection, then reads
its `changes` feed from the stored checkpoint and applies each document by
`kind`. A Resource's content is read by `GET`, or taken from the document's
inline `data`, and its `/meta` object is read for the members the content write
set. An `ETag` that no longer equals the one the feed named means the record
moved, and the Collection is read again next cycle. The checkpoint advances past
a document once it is applied or skipped.

A feed page too large to buffer is asked for again at half the size, down to one
document, which is read up to the upload cap. A binary Resource's read times out
on the wait for the response and for each chunk, so a long transfer is not cut
off.

## Stalls and backoff

A `refused` apply stalls that Collection alone. The checkpoint holds and the
reason (`clock-bound`, `fork`, `quota-exceeded`, `unsupported-backend`,
`container-refused`) is stored with the loop state, which
`GET .../replicas/:replicaId/status` serves beside the loop `state` and the pull
times. The Collection is retried each cycle while the others go on, and a
clock-bound stall clears itself as local time catches up. A Collection stored on
a registered external backend on the peer stalls as `unsupported-backend`: this
server replicates into its own default backend only.

A request to the peer that fails, a 404 for the Space included, ends the cycle.
The loop then backs off, doubling its delay up to a limit, and logs one `warn`
when the failures begin. Nothing stops a loop but the removal of its
registration. The manager stops every loop in the same `onClose` hook that
closes the backend, ahead of it.

## Transport

`sync/peerFetch.ts` is the transport. `fromSpace` is a URL the controller
supplies, so every request to it is bound as the peer log fetch is (see
`lib/peerWebvh.ts` in [webvh-controllers.md](webvh-controllers.md)): `https`
only, the default port, no redirect followed, and a connection only to the
public addresses checked after DNS. The plugin's `peerFetch` option replaces it
in tests.

The feed has a read-only form for the loop,
`GET /space/:spaceId/:collectionId/query?profile=changes`, with `checkpoint` and
`limit` in the query string, verified under the `GET` action. The `POST` form
needs a `POST` capability, which a pull capability does not carry.
