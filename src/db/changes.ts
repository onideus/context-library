import type { PoolClient } from "pg";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { getClient, query } from "./client.js";

/**
 * Sync change-log helpers.
 *
 * Every mutation to a synchronised entity (tasks, notes, artifacts, handoffs)
 * must record exactly one row in the `changes` table in the SAME transaction
 * as the mutation itself — that atomicity is what makes the pull-side cursor
 * safe. The `seq` bigserial is authoritative; `changed_at` is display-only.
 *
 * Postgres-persisted primitives (tasks, notes, artifacts) use `withTransaction`
 * so the entity write and the change-log INSERT share one BEGIN/COMMIT.
 * Handoffs are file-based; there is no cross-store transaction to enforce, so
 * `appendChangeBestEffort` records the change row after the file write and
 * swallows DB errors to preserve the file-mode graceful-degradation guarantee.
 */

export type ChangeOp = "insert" | "update" | "delete";
export type EntityType = "task" | "note" | "artifact" | "handoff";

/**
 * Append a single change-log row using the caller-provided client. MUST be
 * called from within an active transaction so a rollback undoes the log row
 * alongside the mutation.
 */
export async function appendChange(
  client: PoolClient,
  entityType: EntityType,
  entityId: string,
  op: ChangeOp
): Promise<{ seq: string; changed_at: string }> {
  const res = await client.query<{ seq: string; changed_at: string }>(
    `INSERT INTO changes (entity_type, entity_id, op)
     VALUES ($1, $2, $3)
     RETURNING seq::text, changed_at`,
    [entityType, entityId, op]
  );
  return res.rows[0];
}

/**
 * Run `fn` inside a Postgres transaction. Commits on success, rolls back on
 * throw, always releases the client. Return value flows through unchanged.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Rollback failure is secondary — surface the original error.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Best-effort change-log append for handoffs (file-mode). Never throws — a
 * Postgres outage must not fail the handoff write, which by design keeps
 * working under Tier-1 degradation.
 */
export async function appendChangeBestEffort(
  entityType: EntityType,
  entityId: string,
  op: ChangeOp
): Promise<void> {
  try {
    await withTransaction(async (client) => {
      await appendChange(client, entityType, entityId, op);
    });
  } catch (err) {
    console.warn(
      `[changes] Best-effort append failed for ${entityType}:${entityId}:${op}: ${(err as Error).message}`
    );
  }
}

/**
 * Reconcile handoff files on disk with the `changes` table.
 *
 * `appendChangeBestEffort` silently drops rows when Postgres is unavailable
 * (Tier-1 file-mode is the priority — a DB outage must never fail a handoff
 * write). Without a reconciler, any handoffs written during that window would
 * be invisible to `/sync/changes` forever after the DB recovers. This scans
 * the handoffs directory once at startup, diffs against the change log, and
 * inserts a single `insert` row per orphaned filename so pullers eventually
 * see them.
 *
 * Idempotent: filenames already present in `changes` are skipped. Safe to run
 * repeatedly. Handoff filenames are the entity_id for handoffs (a design
 * choice from migration 011).
 *
 * Best-effort: any Postgres or filesystem error logs a warning and returns
 * without throwing — the caller (server startup) must never fail on this.
 */
export async function backfillHandoffChanges(): Promise<{
  scanned: number;
  backfilled: number;
  skipped_reason?: string;
}> {
  const handoffsDir = join(config.dataDir, "handoffs");

  let files: string[];
  try {
    const entries = await readdir(handoffsDir);
    files = entries.filter(
      (f) => f.endsWith(".json") && !f.startsWith(".tmp-")
    );
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "ENOENT") {
      return { scanned: 0, backfilled: 0, skipped_reason: "no handoffs dir" };
    }
    console.warn(
      `[changes] Handoff backfill skipped (readdir failed): ${(err as Error).message}`
    );
    return { scanned: 0, backfilled: 0, skipped_reason: "readdir failed" };
  }

  if (files.length === 0) {
    return { scanned: 0, backfilled: 0 };
  }

  let existingIds: Set<string>;
  try {
    const rows = await query<{ entity_id: string }>(
      `SELECT DISTINCT entity_id FROM changes WHERE entity_type = 'handoff'`
    );
    existingIds = new Set(rows.rows.map((r) => r.entity_id));
  } catch (err) {
    console.warn(
      `[changes] Handoff backfill skipped (DB unavailable): ${(err as Error).message}`
    );
    return {
      scanned: files.length,
      backfilled: 0,
      skipped_reason: "db unavailable",
    };
  }

  let backfilled = 0;
  const missing = files.filter((f) => !existingIds.has(f)).sort();
  for (const filename of missing) {
    try {
      await withTransaction(async (client) => {
        await appendChange(client, "handoff", filename, "insert");
      });
      backfilled++;
    } catch (err) {
      // Per-file failure is non-fatal — surface it and keep going. The next
      // startup pass will retry the still-missing files.
      console.warn(
        `[changes] Handoff backfill failed for ${filename}: ${(err as Error).message}`
      );
    }
  }
  return { scanned: files.length, backfilled };
}
