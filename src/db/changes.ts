import type { PoolClient } from "pg";
import { getClient } from "./client.js";

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
