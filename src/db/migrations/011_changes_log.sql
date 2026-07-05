-- Sync foundation: append-only change log.
--
-- Every mutation to a synchronised entity (tasks, notes, artifacts, handoffs)
-- appends exactly one row here in the SAME transaction as the mutation. The
-- BIGSERIAL `seq` is the authoritative sync cursor — display-only `changed_at`
-- is present for humans reading the log but must never drive sync decisions
-- (clock skew, backfills, and NTP corrections make timestamps unsafe for that).
--
-- Deletes are represented as tombstone rows (op = 'delete'); the referenced
-- entity_id may no longer exist by the time a puller sees the row. Snapshot
-- application on the read side is idempotent — the puller is expected to
-- upsert-or-delete based on op.
--
-- entity_id is TEXT rather than UUID because handoffs are keyed by filename
-- (e.g. "2026-07-05T...json"), not a uuid, and the log is heterogeneous
-- across primitives.

CREATE TABLE IF NOT EXISTS changes (
    seq         BIGSERIAL       PRIMARY KEY,
    entity_type TEXT            NOT NULL,
    entity_id   TEXT            NOT NULL,
    op          TEXT            NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
    changed_at  TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_changes_entity ON changes (entity_type, entity_id);

-- Server-side dedupe of client push ops. When a client pushes the same
-- op_uuid twice (retry after a dropped response), the second insert violates
-- the primary key — the push handler treats that as a successful replay and
-- returns the same result without re-applying the mutation.
CREATE TABLE IF NOT EXISTS sync_op_log (
    op_uuid     UUID            PRIMARY KEY,
    entity_type TEXT            NOT NULL,
    entity_id   TEXT            NOT NULL,
    op          TEXT            NOT NULL,
    change_seq  BIGINT          REFERENCES changes(seq) ON DELETE SET NULL,
    applied_at  TIMESTAMPTZ     NOT NULL DEFAULT now()
);
