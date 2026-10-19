/**
 * Shared table registry for export / import.
 *
 * Every synchronised Postgres table lives here exactly once. Export writes
 * `${name}.jsonl` in this order; import reads the same files in the same
 * order and INSERTs with the listed column list. Add a new table by adding
 * one entry — do not fan changes across export.ts and import.ts.
 *
 * Ordering matters for LOAD (import reads the files in this order):
 *   - `entities` (JIT seeds) and `entity_nodes` have no cross-table FKs, load first
 *   - `note_versions` FKs notes(id), so it follows `notes`. `notes` also has a
 *     self-referencing FK (`superseded_by` → `notes.id`); import runs
 *     `SET CONSTRAINTS ALL DEFERRED` per table so those rows load in `id`
 *     order regardless of which note references which
 *   - `entity_relations` FKs source_entity_id / target_entity_id → entity_nodes
 *   - `sync_op_log.change_seq` FKs changes.seq (ON DELETE SET NULL, but we
 *     preserve the reference where possible)
 *   - `embeddings` is only loaded when `--include-embeddings` was set at export
 *   - `pending_embeddings` is included so a re-embed campaign in flight at
 *     export time is not lost across the restore
 *
 * The `orderBy` clause is the deterministic sort key — consecutive exports
 * of an unchanged database must produce byte-identical JSONL so the
 * nightly-commit-to-a-private-backup-repo pattern actually diffs cleanly.
 *
 * Restore tolerates older tarballs: a column that is ABSENT from a JSONL row
 * (as opposed to present with `null`) is emitted as the SQL keyword DEFAULT
 * (see rows.ts), and a table with no JSONL file loads as zero rows. That is
 * how a tarball written before a column or table existed still restores —
 * the destination's column defaults supply the missing values.
 */

export interface TableSpec {
  /** Table name (also the JSONL filename stem). */
  name: string;
  /** Column names, in a stable order used for both SELECT and INSERT. */
  columns: string[];
  /** ORDER BY clause for deterministic export. */
  orderBy: string;
  /** True if this table is only exported when --include-embeddings is set. */
  embeddingsOnly?: boolean;
  /**
   * Optional list of columns whose value must be cast to a Postgres type on
   * import. Keyed by column name → SQL cast (e.g. "jsonb", "vector",
   * "task_status"). If a column is not listed, the parameter is bound as-is.
   */
  casts?: Record<string, string>;
}

/**
 * Table load order for import. Parent tables (referenced by FKs) come first.
 *
 * This list is NOT a wipe order. `--force` truncates every table in this same
 * forward order with `TRUNCATE ... RESTART IDENTITY CASCADE`, and CASCADE
 * handles the FK dependencies, so iteration order is not load-bearing there.
 */
export const TABLES: TableSpec[] = [
  {
    name: "tasks",
    columns: [
      "id",
      "title",
      "context",
      "status",
      "scope",
      "priority",
      "tags",
      "blocked_reason",
      "scheduled_date",
      "due_date",
      "completed_at",
      "created_at",
      "updated_at",
    ],
    orderBy: "id",
    casts: {
      status: "task_status",
      scope: "task_scope",
      priority: "task_priority",
    },
  },
  {
    name: "notes",
    columns: [
      "id",
      "title",
      "content",
      "domain",
      "tags",
      "scope",
      "source_url",
      "related_task_ids",
      // Lifecycle / provenance / version columns (migration 013). `version`
      // is restored verbatim so it stays above every note_versions row.
      "status",
      "superseded_by",
      "superseded_at",
      "valid_until",
      "provenance",
      "version",
      "created_at",
      "updated_at",
    ],
    orderBy: "id",
  },
  {
    // Per-note edit history (migration 013), written by a BEFORE UPDATE trigger
    // on notes. Row (note_id, k) is the note as it was at version k; the
    // current row in `notes` is the latest version. Import must load it after
    // `notes` (FK) and its versions must all be < the note's current version —
    // import verifies that before writing anything.
    name: "note_versions",
    columns: [
      "note_id",
      "version",
      "snapshot",
      "changed_fields",
      "changed_via",
      "changed_at",
    ],
    orderBy: "note_id, version",
    casts: {
      snapshot: "jsonb",
    },
  },
  {
    name: "artifacts",
    columns: [
      "id",
      "title",
      "artifact_type",
      "content",
      "pointer",
      "status",
      "scope",
      "tags",
      "dependencies",
      "execution_order",
      "related_task_ids",
      "metadata",
      "created_at",
      "updated_at",
    ],
    orderBy: "id",
    casts: {
      pointer: "jsonb",
      metadata: "jsonb",
    },
  },
  {
    name: "entities",
    columns: [
      "id",
      "canonical_name",
      "scope",
      "aliases",
      "constraints",
      "metadata",
      "last_referenced",
      "created_at",
      "updated_at",
    ],
    orderBy: "canonical_name",
    casts: {
      metadata: "jsonb",
    },
  },
  {
    name: "entity_nodes",
    columns: [
      "id",
      "name",
      "entity_type",
      "canonical_name",
      "first_seen",
      "last_seen",
      "mention_count",
      "metadata",
      "created_at",
    ],
    // `id` is a final tiebreaker: (canonical_name, entity_type) is not
    // guaranteed unique across all deployments, and any collision would
    // make consecutive exports diff spuriously.
    orderBy: "canonical_name, entity_type, id",
    casts: {
      metadata: "jsonb",
    },
  },
  {
    name: "extraction_runs",
    columns: [
      "id",
      "provider",
      "provider_version",
      "status",
      "content_scope",
      "content_count",
      "triple_count",
      "started_at",
      "completed_at",
      "config",
      "error",
    ],
    orderBy: "started_at, id",
    casts: {
      config: "jsonb",
    },
  },
  {
    name: "entity_relations",
    columns: [
      "id",
      "source_entity_id",
      "target_entity_id",
      "relation_type",
      "confidence",
      "provider",
      "provider_version",
      "extraction_run_id",
      "source_content_type",
      "source_content_id",
      "context_snippet",
      "created_at",
    ],
    orderBy: "created_at, id",
  },
  {
    name: "pending_embeddings",
    // id is SERIAL — omitted from restore so new values are generated and no
    // sequence-conflict problem arises across restores into a fresh DB.
    columns: [
      "content_type",
      "content_id",
      "created_at",
      "retry_count",
      "last_error",
    ],
    orderBy: "content_type, content_id",
  },
  {
    name: "changes",
    // seq is BIGSERIAL — see note in portability/README-ish sections of
    // docs/backup-restore.md: the cursor space is EFFECTIVELY reset on restore
    // because BIGSERIAL is regenerated. This is intentional — sync clients
    // must re-pair after an import.
    columns: ["entity_type", "entity_id", "op", "changed_at"],
    orderBy: "seq",
  },
  {
    name: "sync_op_log",
    // change_seq is intentionally dropped on restore: `changes.seq` is a
    // fresh BIGSERIAL post-restore, so old references are meaningless. The
    // op_uuid dedupe still works — a client's replayed op finds its uuid,
    // sees the earlier apply, and returns the recorded outcome.
    columns: ["op_uuid", "entity_type", "entity_id", "op", "applied_at"],
    orderBy: "applied_at, op_uuid",
  },
  {
    name: "embeddings",
    embeddingsOnly: true,
    columns: [
      "id",
      "content_type",
      "content_id",
      "content_text",
      "embedding",
      "metadata",
      "created_at",
      "updated_at",
    ],
    orderBy: "content_type, content_id",
    casts: {
      embedding: "vector",
      metadata: "jsonb",
    },
  },
];

/** Look up a spec by table name. */
export function specForTable(name: string): TableSpec | undefined {
  return TABLES.find((t) => t.name === name);
}
