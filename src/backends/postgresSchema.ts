/**
 * PostgreSQL schema for the `PostgresBackend`: an ordered list of migration
 * scripts plus the tiny hand-rolled runner that applies them idempotently
 * (inside an advisory-locked transaction) on backend `init()`. The whole
 * schema is readable in this one file; there is no external migration tool.
 *
 * Collation note: every identifier or ISO-8601 timestamp column that
 * participates in an `ORDER BY` or keyset `>` comparison is declared
 * `COLLATE "C"` (byte order, which for UTF-8 is code-point order) so Postgres
 * ordering agrees with the JS code-unit comparisons the filesystem backend and
 * the pagination cursors use. (The two orders could theoretically diverge for
 * supplementary-plane characters -- unreachable here because the request layer
 * validates ids as URL-safe ASCII.) Timestamps are stored as the fixed-width
 * ISO-8601 strings the wire model uses (`new Date().toISOString()`), not
 * `timestamptz`, so change-feed checkpoints round-trip byte-identically.
 */
import type pg from 'pg'

/**
 * Ordered migration scripts. Version `n` is `MIGRATIONS[n - 1]`; append only,
 * never edit an applied entry.
 */
export const MIGRATIONS: string[] = [
  // v1: the full WAS + WebKMS surface.
  `
  -- The Spaces tree. 'description' is NULL for a placeholder row created by a
  -- write below the Space level (a resource/policy write to a Space whose
  -- description was never written) -- the analogue of a Space directory
  -- without a '.space.' file; getSpaceDescription treats it as absent.
  -- 'usage_bytes' is the transactional quota counter (spec "Quotas"),
  -- maintained in the same transaction as every content write and delete.
  CREATE TABLE spaces (
    space_id    text COLLATE "C" PRIMARY KEY,
    description jsonb,
    usage_bytes bigint NOT NULL DEFAULT 0
  );

  CREATE TABLE collections (
    space_id      text COLLATE "C" NOT NULL
                  REFERENCES spaces ON DELETE CASCADE,
    collection_id text COLLATE "C" NOT NULL,
    description   jsonb,
    PRIMARY KEY (space_id, collection_id)
  );

  -- One row per Resource, live or tombstoned. 'content' is the byte-for-byte
  -- representation (JSON stored as its serialized UTF-8 bytes, NOT jsonb --
  -- jsonb normalization would break byte fidelity); NULL on a tombstone.
  -- 'content_type' records the last-known type on a tombstone. 'version' /
  -- 'meta_version' are the two ETag validators; 'custom' is the user-writable
  -- metadata (or the opaque encryption envelope on an encrypted Collection).
  CREATE TABLE resources (
    space_id      text COLLATE "C" NOT NULL,
    collection_id text COLLATE "C" NOT NULL,
    resource_id   text COLLATE "C" NOT NULL,
    content_type  text NOT NULL,
    content       bytea,
    is_json       boolean NOT NULL,
    size_bytes    bigint NOT NULL DEFAULT 0,
    version       integer NOT NULL,
    meta_version  integer,
    custom        jsonb,
    deleted       boolean NOT NULL DEFAULT false,
    created_at    text COLLATE "C" NOT NULL,
    updated_at    text COLLATE "C" NOT NULL,
    PRIMARY KEY (space_id, collection_id, resource_id),
    FOREIGN KEY (space_id, collection_id)
      REFERENCES collections ON DELETE CASCADE
  );

  -- The changes-feed keyset: (updatedAt, resourceId) ascending within a
  -- collection. Also serves the tie-broken seek.
  CREATE INDEX resources_changes_idx
    ON resources (space_id, collection_id, updated_at, resource_id);

  -- Policies for all three levels in one table; '' sentinel columns keep the
  -- primary key total (Postgres PKs reject NULL). Space policy: ('', '');
  -- collection policy: (cid, ''); resource policy: (cid, rid).
  CREATE TABLE policies (
    space_id      text COLLATE "C" NOT NULL
                  REFERENCES spaces ON DELETE CASCADE,
    collection_id text COLLATE "C" NOT NULL DEFAULT '',
    resource_id   text COLLATE "C" NOT NULL DEFAULT '',
    policy        jsonb NOT NULL,
    PRIMARY KEY (space_id, collection_id, resource_id)
  );

  -- Registered external backend records; 'record' is the full secret-bearing
  -- StoredBackendRecord (same custody posture as the filesystem file).
  CREATE TABLE backend_records (
    space_id   text COLLATE "C" NOT NULL REFERENCES spaces ON DELETE CASCADE,
    backend_id text COLLATE "C" NOT NULL,
    record     jsonb NOT NULL,
    PRIMARY KEY (space_id, backend_id)
  );

  -- WebKMS facet: a sibling tree to spaces, exactly as on the filesystem.
  -- 'controller' / 'sequence' / 'kms_module' are denormalized from the
  -- verbatim config for the list filter and the update gates.
  CREATE TABLE keystores (
    keystore_id text COLLATE "C" PRIMARY KEY,
    controller  text NOT NULL,
    sequence    integer NOT NULL,
    kms_module  text NOT NULL,
    config      jsonb NOT NULL
  );
  CREATE INDEX keystores_controller_idx ON keystores (controller);

  -- 'record' is the opaque (possibly envelope-encrypted above the backend)
  -- KmsKeyRecord, stored verbatim; the primary key is the create-only gate.
  CREATE TABLE kms_keys (
    keystore_id text COLLATE "C" NOT NULL
                REFERENCES keystores ON DELETE CASCADE,
    local_id    text COLLATE "C" NOT NULL,
    record      jsonb NOT NULL,
    PRIMARY KEY (keystore_id, local_id)
  );

  -- 'expires' is meta.expires (the GC horizon), NULL = never.
  CREATE TABLE revocations (
    keystore_id   text COLLATE "C" NOT NULL
                  REFERENCES keystores ON DELETE CASCADE,
    delegator     text COLLATE "C" NOT NULL,
    capability_id text COLLATE "C" NOT NULL,
    record        jsonb NOT NULL,
    expires       text COLLATE "C",
    PRIMARY KEY (keystore_id, delegator, capability_id)
  );
  `,
  // v2: denormalize a Space's controller onto its own column for the Spaces
  // count quota (spec "Quotas"). The controller also lives inside 'description'
  // (description->>'controller'), but a dedicated, indexed column keeps the
  // per-controller COUNT(*) cheap and lockable. Backfill from existing rows;
  // writeSpace maintains it on every insert and update.
  `
  ALTER TABLE spaces ADD COLUMN controller text;
  UPDATE spaces SET controller = description->>'controller';
  CREATE INDEX spaces_controller_idx ON spaces (controller);
  `,
  // v3: record a Resource's creator -- the DID of the invoker of its FIRST
  // content write, set once and preserved verbatim thereafter (the spec's
  // OPTIONAL `createdBy`). NULL for a pre-existing row and for one written by
  // a caller with no resolved invoker. Not `COLLATE "C"`: unlike `created_at` /
  // `updated_at`, this column never participates in an `ORDER BY` or keyset
  // comparison.
  `
  ALTER TABLE resources ADD COLUMN created_by text;
  `,
  // v4: Space-scoped zcap revocations -- the WAS route families' sibling of the
  // keystore-scoped `revocations` table above. A separate table (rather than a
  // nullable-FK union over one table) lets each keep its own `ON DELETE CASCADE`
  // to its parent and its own composite primary key; deleting a Space here
  // deletes its revocations. Columns mirror `revocations`, with 'space_id'
  // referencing the spaces tree in place of 'keystore_id'.
  `
  CREATE TABLE space_revocations (
    space_id      text COLLATE "C" NOT NULL REFERENCES spaces ON DELETE CASCADE,
    delegator     text COLLATE "C" NOT NULL,
    capability_id text COLLATE "C" NOT NULL,
    record        jsonb NOT NULL,
    expires       text COLLATE "C",
    PRIMARY KEY (space_id, delegator, capability_id)
  );
  `,
  // v5: the client-declared key epoch a Resource's content was encrypted under
  // (multi-recipient encrypted Collections). Stored opaquely: the server never
  // computes or verifies it. NULL when no epoch was declared (a plaintext
  // Collection, or an encrypted write that omitted the stamp). Not `COLLATE "C"`
  // -- it never participates in an `ORDER BY` or keyset comparison.
  `
  ALTER TABLE resources ADD COLUMN epoch text;
  `,
  // v6: the monotonic Collection Description version -- the ETag validator behind
  // conditional (`If-Match`) Collection Description writes, so concurrent
  // recipient edits compare-and-swap instead of clobbering. Kept out of the
  // stored 'description' jsonb (it travels only as the `ETag` header). Backfill
  // existing rows to 1; writeCollection bumps it on every write.
  `
  ALTER TABLE collections ADD COLUMN description_version integer NOT NULL DEFAULT 1;
  `
]

/**
 * Applies any not-yet-applied migrations, inside a transaction holding a
 * schema-scoped advisory lock so concurrent server instances sharing one
 * database serialize their startup migration runs. Idempotent: applied
 * versions are recorded in `schema_migrations` and skipped on the next run.
 * @param options {object}
 * @param options.client {pg.PoolClient}   a dedicated client (not the pool);
 *   the caller is responsible for releasing it
 * @returns {Promise<void>}
 */
export async function applyMigrations({
  client
}: {
  client: pg.PoolClient
}): Promise<void> {
  await client.query('BEGIN')
  try {
    // Scope the advisory lock to the active schema so parallel test schemas
    // in one database do not serialize against each other.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':was-migrations'))`
    )
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    const { rows } = await client.query<{ version: number }>(
      'SELECT version FROM schema_migrations'
    )
    const applied = new Set(rows.map(row => row.version))
    for (let index = 0; index < MIGRATIONS.length; index++) {
      const version = index + 1
      if (applied.has(version)) {
        continue
      }
      await client.query(MIGRATIONS[index]!)
      await client.query(
        'INSERT INTO schema_migrations (version) VALUES ($1)',
        [version]
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}
