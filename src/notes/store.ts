import type { PoolClient } from "pg";
import { appendChange } from "../db/changes.js";
import { config } from "../config.js";

/**
 * Shared note write path.
 *
 * The MCP note tools (src/tools/notes.ts) and the /sync/push applier
 * (src/sync/routes.ts) both mutate `notes`. CLAUDE.md requires the two paths
 * to stay in sync, and history + preconditions are exactly the kind of
 * invariant that rots when duplicated — so the in-transaction work lives
 * here, once. Design: docs/design/note-lifecycle.md §5.
 *
 * Division of labour:
 *   - The `notes_version_history` trigger (migration 013) owns `version`
 *     bumps and `note_versions` rows. It fires for every writer, including
 *     raw SQL, so nothing here needs to remember to write history.
 *   - This module owns row locking, preconditions (expected_version,
 *     expected_status, base_updated_at), lifecycle validation, the
 *     change-log row, the `app.changed_via` GUC the trigger records, and
 *     history retention.
 *   - Callers own the transaction (`withTransaction` for MCP, the dedupe
 *     claim transaction for sync) and all post-commit side effects
 *     (embedding re-index, entity extraction, response shaping).
 *
 * Every helper takes the caller's PoolClient and MUST be called inside an
 * open transaction: SELECT ... FOR UPDATE and set_config(..., is_local=true)
 * are both transaction-scoped.
 */

// ── Constants & types ────────────────────────────────────────────────

export const NOTE_SCOPES = ["work", "personal", "shared"] as const;
export const STORED_NOTE_STATUSES = ["active", "superseded"] as const;
export const EFFECTIVE_NOTE_STATUSES = ["active", "superseded", "expired"] as const;
export const PROVENANCE_VALUES = ["stated", "decided", "inferred", "fetched", "derived"] as const;

export type NoteScope = (typeof NOTE_SCOPES)[number];
export type StoredNoteStatus = (typeof STORED_NOTE_STATUSES)[number];
export type EffectiveNoteStatus = (typeof EFFECTIVE_NOTE_STATUSES)[number];
export type Provenance = (typeof PROVENANCE_VALUES)[number];

/** A `notes` row as node-postgres returns it (timestamps are Dates). */
export interface NoteRow {
  id: string;
  title: string;
  content: string;
  domain: string | null;
  tags: string[];
  scope: NoteScope;
  source_url: string | null;
  related_task_ids: string[];
  status: StoredNoteStatus;
  superseded_by: string | null;
  superseded_at: Date | string | null;
  valid_until: Date | string | null;
  provenance: Provenance | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

/** Fields a caller may set on insert. */
export interface NoteInsert {
  title: string;
  content: string;
  scope: NoteScope;
  domain?: string | null;
  tags?: string[];
  source_url?: string | null;
  related_task_ids?: string[];
  provenance?: Provenance | null;
  /** ISO-8601 with offset, or null. */
  valid_until?: string | null;
}

/**
 * Fields a caller may change on update. `undefined` = leave alone; `null`
 * clears a nullable column. Lifecycle columns (status, superseded_by,
 * superseded_at) are deliberately absent — they move only through
 * supersedeNoteInTx and the delete-time splice.
 */
export interface NotePatch {
  title?: string;
  content?: string;
  domain?: string | null;
  tags?: string[];
  scope?: NoteScope;
  source_url?: string | null;
  related_task_ids?: string[];
  provenance?: Provenance | null;
  valid_until?: string | null;
}

const PATCHABLE_COLUMNS: ReadonlyArray<keyof NotePatch> = [
  "title",
  "content",
  "domain",
  "tags",
  "scope",
  "source_url",
  "related_task_ids",
  "provenance",
  "valid_until",
];

/**
 * Who is writing. Recorded by the trigger in note_versions.changed_via.
 * Free text so a future tool can add its own name without a migration.
 */
export type ChangedVia =
  | "update_note"
  | "supersede_note"
  | "delete_note"
  | "sync_push"
  | "str_replace_note"
  | "append_note"
  | (string & {});

export interface WritePreconditions {
  /** Row must currently be at exactly this version. Enforced whenever present. */
  expectedVersion?: number;
  /** Row's STORED status must equal this. Enforced whenever present. */
  expectedStatus?: StoredNoteStatus | string;
  /** Row's updated_at must match this instant (sync legacy precondition). */
  baseUpdatedAt?: string;
}

/**
 * Why a write did not apply. `current` is the row as it is now, so the
 * caller can hand it back and let the client rebase.
 */
export type NoteWriteConflict =
  | { kind: "not_found"; missing?: "id" | "superseded_by" }
  | { kind: "version_conflict"; current: NoteRow }
  | { kind: "status_conflict"; current: NoteRow }
  | { kind: "stale_base"; current: NoteRow }
  | { kind: "invalid_successor"; reason: string; current: NoteRow; successor: NoteRow | null };

export type NoteWriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; conflict: NoteWriteConflict };

/** Error code for a conflict, consistent with STATUS_CONFLICT / HANDOFF_CONFLICT. */
export function conflictCode(conflict: NoteWriteConflict): string {
  switch (conflict.kind) {
    case "not_found":
      return "NOT_FOUND";
    case "version_conflict":
      return "VERSION_CONFLICT";
    case "status_conflict":
      return "STATUS_CONFLICT";
    case "stale_base":
      return "STALE_BASE";
    case "invalid_successor":
      return "INVALID_SUCCESSOR";
  }
}

/** Human-readable message for a conflict; callers may prepend context. */
export function conflictMessage(conflict: NoteWriteConflict, id: string): string {
  switch (conflict.kind) {
    case "not_found":
      return conflict.missing === "superseded_by"
        ? `Successor note not found`
        : `Note not found: ${id}`;
    case "version_conflict":
      return `Note ${id} is at version ${conflict.current.version}; the expected_version you supplied is stale. Re-read the note (get_note or get_note_history) and re-issue the write against the current version.`;
    case "status_conflict":
      return `Note ${id} has status '${conflict.current.status}'${
        conflict.current.superseded_by ? ` (superseded by ${conflict.current.superseded_by})` : ""
      }, not the status you expected.`;
    case "stale_base":
      return `Note ${id} was modified after the base_updated_at you supplied.`;
    case "invalid_successor":
      return conflict.reason;
  }
}

// ── Input normalisation ──────────────────────────────────────────────

const ISO_WITH_OFFSET_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Validate a `valid_until` value: ISO-8601 date-time WITH an explicit offset
 * (`Z` or `±hh:mm`). Offset-less values are rejected on purpose — JS parses
 * them as local time while Postgres uses the session zone, so the same
 * string would mean two different instants. Returns the normalised UTC ISO
 * string, or null when the value is not acceptable. Shared by the MCP tools
 * and the sync applier so both paths accept exactly the same inputs.
 */
export function parseIsoWithOffset(value: string): string | null {
  if (typeof value !== "string" || !ISO_WITH_OFFSET_RE.test(value.trim())) return null;
  const ms = Date.parse(value.trim());
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

const UUID_TEXT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Canonical (lowercase) form of a UUID string, so ids compared in JS agree
 * with the lowercase text Postgres returns. Non-UUID input is returned
 * unchanged and left to Postgres to reject.
 */
export function normaliseUuid(id: string): string {
  return UUID_TEXT_RE.test(id) ? id.toLowerCase() : id;
}

// ── Lifecycle SQL fragments ──────────────────────────────────────────

/**
 * Computed lifecycle status. `expired` is never stored (design §3.3);
 * supersession wins when both apply because it carries a successor.
 */
export function effectiveStatusSql(alias = "notes"): string {
  return `CASE
    WHEN ${alias}.status = 'superseded' THEN 'superseded'
    WHEN ${alias}.valid_until IS NOT NULL AND ${alias}.valid_until <= now() THEN 'expired'
    ELSE 'active'
  END`;
}

/** Same computation for a row already in hand. */
export function effectiveStatus(
  row: Pick<NoteRow, "status" | "valid_until">,
  now: Date = new Date()
): EffectiveNoteStatus {
  if (row.status === "superseded") return "superseded";
  if (row.valid_until !== null && row.valid_until !== undefined) {
    const until = row.valid_until instanceof Date ? row.valid_until : new Date(row.valid_until);
    if (!Number.isNaN(until.getTime()) && until.getTime() <= now.getTime()) return "expired";
  }
  return "active";
}

export interface LifecycleFilter {
  /** Drop rows whose stored status is 'superseded'. */
  excludeSuperseded: boolean;
  /** Drop rows whose valid_until has passed. */
  excludeExpired: boolean;
}

/**
 * SQL predicate for a lifecycle filter, or "TRUE" when nothing is excluded.
 * Columns are qualified with `alias` so the fragment is safe inside joins.
 */
export function lifecyclePredicateSql(alias: string, filter: LifecycleFilter): string {
  const clauses: string[] = [];
  if (filter.excludeSuperseded) clauses.push(`${alias}.status = 'active'`);
  if (filter.excludeExpired) {
    clauses.push(`(${alias}.valid_until IS NULL OR ${alias}.valid_until > now())`);
  }
  return clauses.length ? `(${clauses.join(" AND ")})` : "TRUE";
}

// ── Locking ──────────────────────────────────────────────────────────

/**
 * Advisory lock serialising lifecycle operations (supersede, delete-splice,
 * prune). A delete-splice locks its target then its predecessors; a
 * concurrent delete/supersede of an adjacent chain member locks the other
 * row then waits on a predecessor — a cycle. One transaction-scoped
 * advisory lock around lifecycle operations only (plain update_note never
 * takes it) removes the cycle at a cost that is irrelevant at single-user
 * scale. Released automatically at COMMIT/ROLLBACK.
 */
export const LIFECYCLE_ADVISORY_LOCK_KEY = 7013001;

export async function lockLifecycle(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1)", [LIFECYCLE_ADVISORY_LOCK_KEY]);
}

async function setChangedVia(client: PoolClient, via: ChangedVia): Promise<void> {
  // set_config(..., is_local = true) scopes the value to the current
  // transaction, which is what the trigger reads. SET LOCAL cannot take a
  // bind parameter, hence set_config.
  await client.query("SELECT set_config('app.changed_via', $1, true)", [via]);
}

// ── Precondition helpers ─────────────────────────────────────────────

/**
 * Does the row's updated_at match the instant the client claims it last saw?
 * The driver returns a Date; clients echo back the ISO string they received
 * in a snapshot (JSON.stringify(Date) → toISOString, millisecond precision,
 * same as the driver's parse). Exact string match first; then instant
 * equality so a client that normalises "+00:00" to "Z" (or vice versa) still
 * matches. Replaces the String(Date) comparison that could never succeed.
 */
export function updatedAtMatches(current: Date | string, claimed: string): boolean {
  const currentIso = current instanceof Date ? current.toISOString() : String(current);
  if (currentIso === claimed) return true;
  const a = current instanceof Date ? current.getTime() : Date.parse(String(current));
  const b = Date.parse(claimed);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

function checkPreconditions(
  row: NoteRow,
  pre: WritePreconditions
): NoteWriteConflict | null {
  // Order matters: expected_version is the strongest, most specific claim,
  // so it wins when several fail (design §4.7).
  if (pre.expectedVersion !== undefined && row.version !== pre.expectedVersion) {
    return { kind: "version_conflict", current: row };
  }
  if (pre.expectedStatus !== undefined && row.status !== pre.expectedStatus) {
    return { kind: "status_conflict", current: row };
  }
  if (pre.baseUpdatedAt !== undefined && !updatedAtMatches(row.updated_at, pre.baseUpdatedAt)) {
    return { kind: "stale_base", current: row };
  }
  return null;
}

// ── Retention ────────────────────────────────────────────────────────

/**
 * Enforce NOTE_HISTORY_MAX_VERSIONS after a versioned write. History rows
 * for a note at version v are v1..v-1; keeping the newest N means deleting
 * version <= v-1-N. No-op when the cap is unset (0).
 */
async function trimHistory(client: PoolClient, noteId: string, currentVersion: number): Promise<void> {
  const max = config.noteHistoryMaxVersions;
  if (!max || max <= 0) return;
  await client.query(
    "DELETE FROM note_versions WHERE note_id = $1 AND version <= $2",
    [noteId, currentVersion - 1 - max]
  );
}

// ── Writes ───────────────────────────────────────────────────────────

/** Insert a note and its change-log row. `id` lets sync supply the client's UUID. */
export async function insertNoteInTx(
  client: PoolClient,
  fields: NoteInsert,
  opts: { id?: string } = {}
): Promise<{ row: NoteRow; seq: string }> {
  const res = await client.query<NoteRow>(
    `INSERT INTO notes (id, title, content, domain, tags, scope, source_url, related_task_ids, provenance, valid_until)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
     RETURNING *`,
    [
      opts.id ?? null,
      fields.title,
      fields.content,
      fields.domain ?? null,
      fields.tags ?? [],
      fields.scope,
      fields.source_url ?? null,
      fields.related_task_ids ?? [],
      fields.provenance ?? null,
      fields.valid_until ?? null,
    ]
  );
  const row = res.rows[0];
  const change = await appendChange(client, "note", row.id, "insert");
  return { row, seq: change.seq };
}

export interface UpdateOutcome {
  row: NoteRow;
  /** False when the patch changed nothing — no version bump, no change-log row. */
  changed: boolean;
  seq?: string;
}

/**
 * Update a note under a row lock with preconditions. The caller has already
 * validated that `patch` has at least one key (VALIDATION_ERROR is cheaper
 * than a round trip). A patch that changes no values is applied as a true
 * no-op by the trigger and reported with `changed: false`.
 */
export async function updateNoteInTx(
  client: PoolClient,
  id: string,
  patch: NotePatch,
  opts: WritePreconditions & { via: ChangedVia }
): Promise<NoteWriteResult<UpdateOutcome>> {
  const locked = await client.query<NoteRow>(
    "SELECT * FROM notes WHERE id = $1 FOR UPDATE",
    [id]
  );
  if (locked.rows.length === 0) {
    return { ok: false, conflict: { kind: "not_found", missing: "id" } };
  }
  const current = locked.rows[0];

  const conflict = checkPreconditions(current, opts);
  if (conflict) return { ok: false, conflict };

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  for (const col of PATCHABLE_COLUMNS) {
    const value = patch[col];
    if (value === undefined) continue;
    const cast = col === "valid_until" ? "::timestamptz" : "";
    sets.push(`${col} = $${idx++}${cast}`);
    params.push(value);
  }
  if (sets.length === 0) {
    return { ok: true, value: { row: current, changed: false } };
  }

  await setChangedVia(client, opts.via);
  const upd = await client.query<NoteRow>(
    `UPDATE notes SET ${sets.join(", ")}
     WHERE id = $${idx} AND version = $${idx + 1}
     RETURNING *`,
    [...params, id, current.version]
  );
  if (upd.rows.length === 0) {
    // Cannot happen while we hold FOR UPDATE, but keep the guard so a future
    // caller that drops the lock still gets a truthful answer.
    return { ok: false, conflict: { kind: "not_found", missing: "id" } };
  }
  const row = upd.rows[0];
  const changed = row.version !== current.version;
  if (!changed) {
    return { ok: true, value: { row, changed: false } };
  }
  const change = await appendChange(client, "note", id, "update");
  await trimHistory(client, id, row.version);
  return { ok: true, value: { row, changed: true, seq: change.seq } };
}

export interface SupersedeOutcome {
  old: NoteRow;
  successor: NoteRow;
  seq: string;
}

/**
 * Mark `id` as replaced by `successorId`. Both rows must be active: the old
 * one because re-pointing an already-superseded note is not a supersede
 * (STATUS_CONFLICT tells the caller by whom), the successor because a
 * superseded or expired note cannot be the current truth. Both-active makes
 * cycles impossible by construction. Only the old row changes, so only it
 * gets a change-log row.
 */
export async function supersedeNoteInTx(
  client: PoolClient,
  id: string,
  successorId: string,
  opts: Omit<WritePreconditions, "baseUpdatedAt"> & { via: ChangedVia }
): Promise<NoteWriteResult<SupersedeOutcome>> {
  await lockLifecycle(client);

  // Postgres returns uuid text lowercase; callers (an MCP client echoing a
  // Swift uuidString, say) may send uppercase. Compare on the canonical form
  // so a real note is never reported NOT_FOUND over letter case.
  id = normaliseUuid(id);
  successorId = normaliseUuid(successorId);

  const ids = id === successorId ? [id] : [id, successorId];
  const locked = await client.query<NoteRow>(
    "SELECT * FROM notes WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
    [ids]
  );
  const byId = new Map(locked.rows.map((r) => [r.id, r]));
  const old = byId.get(id);
  if (!old) return { ok: false, conflict: { kind: "not_found", missing: "id" } };
  const successor = byId.get(successorId);
  if (!successor) return { ok: false, conflict: { kind: "not_found", missing: "superseded_by" } };

  if (id === successorId) {
    return {
      ok: false,
      conflict: {
        kind: "invalid_successor",
        reason: `A note cannot supersede itself (${id}).`,
        current: old,
        successor: null,
      },
    };
  }

  const conflict = checkPreconditions(old, opts);
  if (conflict) return { ok: false, conflict };

  if (old.status !== "active") {
    return { ok: false, conflict: { kind: "status_conflict", current: old } };
  }
  const successorStatus = effectiveStatus(successor);
  if (successorStatus !== "active") {
    return {
      ok: false,
      conflict: {
        kind: "invalid_successor",
        reason: `Successor ${successorId} is ${successorStatus}; only an active note can supersede another.`,
        current: old,
        successor,
      },
    };
  }

  await setChangedVia(client, opts.via);
  const upd = await client.query<NoteRow>(
    `UPDATE notes
        SET status = 'superseded', superseded_by = $2, superseded_at = now()
      WHERE id = $1 AND version = $3
      RETURNING *`,
    [id, successorId, old.version]
  );
  if (upd.rows.length === 0) {
    return { ok: false, conflict: { kind: "not_found", missing: "id" } };
  }
  const change = await appendChange(client, "note", id, "update");
  await trimHistory(client, id, upd.rows[0].version);
  return { ok: true, value: { old: upd.rows[0], successor, seq: change.seq } };
}

export interface DeleteOutcome {
  deleted: NoteRow;
  /** Predecessors re-pointed or reactivated by the splice, as they are now. */
  relinked: NoteRow[];
  seq: string;
}

/**
 * Delete a note, splicing any chain that ran through it (design §7):
 *   - A→B→C, delete B  ⇒ A→C (A keeps its original superseded_at);
 *   - A→B,   delete B  ⇒ A reactivated — nothing current says otherwise.
 * Each relinked predecessor is versioned by the trigger and gets its own
 * change-log row so pullers re-snapshot it. Returns null when the note does
 * not exist; callers decide whether that is NOT_FOUND (MCP) or a harmless
 * tombstone replay (sync).
 */
export async function deleteNoteInTx(
  client: PoolClient,
  id: string,
  opts: { via: ChangedVia }
): Promise<DeleteOutcome | null> {
  await lockLifecycle(client);

  const target = await client.query<NoteRow>(
    "SELECT * FROM notes WHERE id = $1 FOR UPDATE",
    [id]
  );
  if (target.rows.length === 0) return null;
  const deleted = target.rows[0];

  const predecessors = await client.query<NoteRow>(
    "SELECT * FROM notes WHERE superseded_by = $1 ORDER BY id FOR UPDATE",
    [id]
  );

  const relinked: NoteRow[] = [];
  if (predecessors.rows.length > 0) {
    await setChangedVia(client, opts.via);
    for (const pred of predecessors.rows) {
      const upd = deleted.superseded_by
        ? await client.query<NoteRow>(
            `UPDATE notes SET superseded_by = $2
              WHERE id = $1 AND version = $3 RETURNING *`,
            [pred.id, deleted.superseded_by, pred.version]
          )
        : await client.query<NoteRow>(
            `UPDATE notes
                SET status = 'active', superseded_by = NULL, superseded_at = NULL
              WHERE id = $1 AND version = $2 RETURNING *`,
            [pred.id, pred.version]
          );
      if (upd.rows.length === 0) continue;
      await appendChange(client, "note", pred.id, "update");
      await trimHistory(client, pred.id, upd.rows[0].version);
      relinked.push(upd.rows[0]);
    }
  }

  await client.query("DELETE FROM notes WHERE id = $1", [id]);
  const change = await appendChange(client, "note", id, "delete");
  return { deleted, relinked, seq: change.seq };
}

export interface PruneOutcome {
  row: NoteRow;
  /** History rows removed. */
  deleted: number;
  /** History rows remaining. */
  remaining: number;
}

/**
 * Delete all but the newest `keepLast` history rows of one note. The note
 * row itself does not change, so no change-log row is written —
 * note_versions is not a sync entity.
 */
export async function pruneNoteHistoryInTx(
  client: PoolClient,
  id: string,
  keepLast: number
): Promise<PruneOutcome | null> {
  await lockLifecycle(client);
  const locked = await client.query<NoteRow>(
    "SELECT * FROM notes WHERE id = $1 FOR UPDATE",
    [id]
  );
  if (locked.rows.length === 0) return null;
  const row = locked.rows[0];
  const keep = Math.max(0, Math.floor(keepLast));
  const del = await client.query(
    "DELETE FROM note_versions WHERE note_id = $1 AND version <= $2",
    [id, row.version - 1 - keep]
  );
  const remaining = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM note_versions WHERE note_id = $1",
    [id]
  );
  return {
    row,
    deleted: del.rowCount ?? 0,
    remaining: parseInt(remaining.rows[0]?.count ?? "0", 10),
  };
}

// ── Reads shared by tools ────────────────────────────────────────────

export interface NoteVersionRow {
  note_id: string;
  version: number;
  snapshot: Record<string, unknown>;
  changed_fields: string[];
  changed_via: string;
  changed_at: Date | string;
}

/**
 * Walk superseded_by chains to their heads for a set of note ids. Returns a
 * map from each input id to its chain head id (an input that is itself a
 * head maps to itself). Depth is capped at 20 as belt-and-braces — cycles
 * are impossible under the both-active rule. Used by search redirection.
 */
export async function resolveChainHeads(
  exec: { query: PoolClient["query"] },
  ids: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (ids.length === 0) return result;
  const res = await exec.query<{ start_id: string; head_id: string }>(
    `WITH RECURSIVE chain AS (
       SELECT id AS start_id, id, superseded_by, 0 AS depth
         FROM notes WHERE id = ANY($1::uuid[])
       UNION ALL
       SELECT c.start_id, n.id, n.superseded_by, c.depth + 1
         FROM chain c JOIN notes n ON n.id = c.superseded_by
        WHERE c.depth < 20
     )
     SELECT DISTINCT ON (start_id) start_id, id AS head_id
       FROM chain
      ORDER BY start_id, depth DESC`,
    [ids]
  );
  for (const r of res.rows) result.set(r.start_id, r.head_id);
  return result;
}
