## Documents

Operations:

- [Administrator's Guide](admin-guide.md) -- operational guidance for deploying
  and running the server (at-rest KMS key-record encryption, KEK rotation)
- [Deploying on Fly.io](deployment-fly.io.md) -- choosing an origin layout, the
  Docker image, what a reverse proxy in front of the server must do, and an
  example Fly.io deployment
- [Consuming the Server as a Library](consuming-server-as-library.md) -- using
  the exported `fastifyWas` plugin to compose your own WAS server

Behavior, one topic per file. [ARCHITECTURE.md](../ARCHITECTURE.md) is the map
and names which of these applies to each module:

- [The Request Pipeline](request-pipeline.md) -- the hook chain, 405 refusals,
  reserved paths, slash redirects, body integrity, the hosted-page sandbox, the
  read caches, denial reasons
- [Validators, Write Stamps and Preconditions](validators-and-stamps.md) -- the
  hybrid-logical-clock write stamp, the `ETag` format, `If-Match` /
  `If-None-Match`, conditional reads, write responses, policy records
- [The Changes Feed](changes-feed.md) -- feed positions, feed documents, the
  checkpoint
- [Governing History Logs and the Revisions Descriptor](governed-logs-and-revisions.md)
  -- the `meta/log` sub-resource, derived descriptors, `revisions`, the
  write-once rule
- [Replication](replication.md) -- replica registrations, the apply path, the
  pull loop, where a replicated `did:webvh` log lives
- [Export and Import of a Space](export-import.md) -- the archive, the import
  plan's checks, archived revocations
- [Server Identity and Export Provenance](server-identity-and-provenance.md) --
  the server's `did:webvh` and signing key, provenance statements on export and
  their verification on import
- [Chain Inspection: the Client-Annex Clause and the Container Rule](client-annex-clause.md)
  -- the five admitted ladder-delegation shapes, the invocation-time bounds, the
  container rule
- [Storage Layout](filesystem-layout.md) -- `store.json` and layout versions,
  sidecars and Resource tombstones, crash cases, Collection tombstones on disk
- [did:webvh Controllers and Invokers](webvh-controllers.md) -- resolution,
  verification, the current-key-set rule, the append-only log, foreign invokers
- [The Service Description](service-description.md) -- the five `specs` entries,
  the `instance` member, the `Link` header
