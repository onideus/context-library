import type { Hono } from "hono";
import type { PoolClient } from "pg";
import { z } from "zod";
import { config } from "../config.js";
import { query } from "../db/client.js";
import { withTransaction, appendChange } from "../db/changes.js";
import type { EntityType, ChangeOp } from "../db/changes.js";
import { syncAuthMiddleware } from "./auth.js";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { HANDOFFS_DIR } from "../tools/handoff.js";

/**
 * Sync HTTP routes.
 *
 * These endpoints are NOT MCP tools. The mobile client (Phase 1a) can't
 * participate in the interactive OAuth flow the MCP transport requires, so
 * sync rides plain HTTP with its own auth boundary (see auth.ts). See
 * design-doc §3 for the protocol and §4 for the conflict rules.
 *
 * Semantics:
 *   - `seq` (BIGSERIAL) is the authoritative cursor. `changed_at` is display
 *     only — never make sync decisions from timestamps.
 *   - Snapshot application on GET /sync/changes MUST be idempotent. Pulling
 *     the same range twice must produce the same end state on the client.
 *   - POST /sync/push rejects individual stale ops, never batch-fails. A
 *     rejected op returns the current server state so the client can rebase.
 *   - Replays (same op_uuid twice) are harmless: the second one dedupes and
 *     returns the earlier outcome.
 */

// ── Snapshot loaders ─────────────────────────────────────────────────

async function loadTaskSnapshot(id: string): Promise<Record<string, unknown> | null> {
  const res = await query<Record<string, unknown>>(
    "SELECT * FROM tasks WHERE id = $1",
    [id]
  );
  return res.rows[0] ?? null;
}

async function loadNoteSnapshot(id: string): Promise<Record<string, unknown> | null> {
  const res = await query<Record<string, unknown>>(
    "SELECT * FROM notes WHERE id = $1",
    [id]
  );
  return res.rows[0] ?? null;
}

async function loadArtifactSnapshot(id: string): Promise<Record<string, unknown> | null> {
  const res = await query<Record<string, unknown>>(
    "SELECT * FROM artifacts WHERE id = $1",
    [id]
  );
  return res.rows[0] ?? null;
}

/**
 * Handoff filename validator. Handoff entity_ids are filenames like
 * `2026-07-05T12-34-56-000Z-abc12345.json` written by `writeHandoff`. Only
 * `writeHandoff`-generated names currently reach the changes table, but we
 * validate here as defense-in-depth so any future writer that hands us an
 * unexpected value can't reach outside HANDOFFS_DIR via path traversal.
 */
const HANDOFF_FILENAME_RE = /^[A-Za-z0-9._-]+\.json$/;

async function loadHandoffSnapshot(filename: string): Promise<Record<string, unknown> | null> {
  if (!HANDOFF_FILENAME_RE.test(filename) || filename.includes("..")) {
    return null;
  }
  try {
    const path = join(HANDOFFS_DIR(), filename);
    const raw = await readFile(path, "utf-8");
    return { filename, ...JSON.parse(raw) };
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

const SNAPSHOT_LOADERS: Record<
  EntityType,
  (id: string) => Promise<Record<string, unknown> | null>
> = {
  task: loadTaskSnapshot,
  note: loadNoteSnapshot,
  artifact: loadArtifactSnapshot,
  handoff: loadHandoffSnapshot,
};

interface ChangeRow {
  seq: string;
  entity_type: string;
  entity_id: string;
  op: string;
  changed_at: string;
}

// ── Push handlers ────────────────────────────────────────────────────

/**
 * Per-entity mutation applier. Each returns:
 *   - `applied` — the mutation was applied and returns the new snapshot
 *   - `conflict` — a precondition failed; caller sees current server state
 *
 * Only tasks, notes, and artifacts are pushable in Phase 1a. Handoffs are
 * write-through-MCP only for now — the mobile client reads handoffs via
 * /sync/changes but doesn't push them (design-doc §3).
 *
 * Appliers take a caller-provided PoolClient so the outer push handler can
 * combine the dedupe claim, the entity mutation, and the changes-log INSERT
 * into a single transaction. That is what makes rollback the correct cleanup
 * on conflict / error — the previous compensating-DELETE approach could leak
 * a permanently dedupe-blocked op_uuid on any transient failure.
 */

interface ApplyResult {
  status: "applied" | "conflict";
  snapshot: Record<string, unknown> | null;
  seq?: string;
  conflict?: {
    reason: string;
    current: Record<string, unknown> | null;
  };
}

const taskPatchSchema = z
  .object({
    title: z.string().optional(),
    context: z.string().nullable().optional(),
    status: z.enum(["open", "completed", "deferred", "cancelled"]).optional(),
    scope: z.enum(["work", "personal", "shared"]).optional(),
    priority: z.enum(["critical", "high", "normal", "low"]).nullable().optional(),
    tags: z.array(z.string()).optional(),
    blocked_reason: z.string().nullable().optional(),
    scheduled_date: z.string().nullable().optional(),
    due_date: z.string().nullable().optional(),
    completed_at: z.string().nullable().optional(),
  })
  .strict();

async function applyTaskOp(
  op: PushOp,
  client: PoolClient
): Promise<ApplyResult> {
  if (op.op === "insert") {
    const payload = taskPatchSchema.parse(op.payload ?? {});
    // Defaults live in JS, not SQL COALESCE — `COALESCE($n, 'literal')`
    // resolves to text and Postgres rejects that against enum/array columns
    // (task_status, text[]). Plain $n placeholders let the column drive type
    // inference. Matches the fix in 4d17ed8.
    const res = await client.query<Record<string, unknown>>(
      `INSERT INTO tasks (id, title, context, status, scope, priority, tags, blocked_reason, scheduled_date, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        op.entity_id,
        payload.title ?? "(untitled)",
        payload.context ?? null,
        payload.status ?? "open",
        payload.scope ?? "personal",
        payload.priority ?? null,
        payload.tags ?? [],
        payload.blocked_reason ?? null,
        payload.scheduled_date ?? null,
        payload.due_date ?? null,
      ]
    );
    const change = await appendChange(client, "task", op.entity_id, "insert");
    return { status: "applied" as const, snapshot: res.rows[0], seq: change.seq };
  }
  if (op.op === "delete") {
    await client.query("DELETE FROM tasks WHERE id = $1", [op.entity_id]);
    // Deleting a non-existent row is a no-op, not a conflict — replays stay
    // harmless. The change log row is still appended so pullers can reconcile
    // a tombstone regardless. Trade-off worth naming: an authenticated but
    // low-trust bearer could bloat `changes` by pushing deletes for random
    // UUIDs (each op_uuid dedupes exactly once, but a fresh op_uuid every
    // time is cheap). Acceptable under Phase 1a's single-tenant deployment
    // model. Multi-tenant deployments should add a lookup+skip here before
    // relaxing the trust boundary.
    const change = await appendChange(client, "task", op.entity_id, "delete");
    return { status: "applied" as const, snapshot: null, seq: change.seq };
  }
  // update
  const payload = taskPatchSchema.parse(op.payload ?? {});
  const precondition = op.precondition ?? {};
  const current = await client.query<Record<string, unknown>>(
    "SELECT * FROM tasks WHERE id = $1",
    [op.entity_id]
  );
  if (current.rows.length === 0) {
    return {
      status: "conflict" as const,
      snapshot: null,
      conflict: { reason: "NOT_FOUND", current: null },
    };
  }
  // Precondition: base updated_at (last-writer-wins with detection).
  if (
    typeof precondition.base_updated_at === "string" &&
    (current.rows[0].updated_at as unknown as { toISOString?: () => string })
      ?.toISOString?.() !== precondition.base_updated_at &&
    String(current.rows[0].updated_at) !== precondition.base_updated_at
  ) {
    return {
      status: "conflict" as const,
      snapshot: null,
      conflict: { reason: "STALE_BASE", current: current.rows[0] },
    };
  }
  // Precondition: expected_status — enforced only when the payload mutates
  // status. Mirrors the item-3 conditional-UPDATE pattern in update_task so a
  // sync push racing a chat/pipeline status transition returns STATUS_CONFLICT
  // instead of silently overwriting the winner.
  const statusChanging =
    payload.status !== undefined && payload.status !== current.rows[0].status;
  const useConditional =
    statusChanging && typeof precondition.expected_status === "string";
  if (
    useConditional &&
    String(current.rows[0].status) !== precondition.expected_status
  ) {
    return {
      status: "conflict" as const,
      snapshot: null,
      conflict: { reason: "STATUS_CONFLICT", current: current.rows[0] },
    };
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  for (const [k, v] of Object.entries(payload)) {
    sets.push(`${k} = $${idx++}`);
    params.push(v);
  }
  if (sets.length === 0) {
    return { status: "applied" as const, snapshot: current.rows[0] };
  }
  const idParam = `$${idx++}`;
  const conditional = useConditional ? ` AND status = $${idx++}` : "";
  const conditionalParams = useConditional ? [precondition.expected_status] : [];
  const upd = await client.query<Record<string, unknown>>(
    `UPDATE tasks SET ${sets.join(", ")} WHERE id = ${idParam}${conditional} RETURNING *`,
    [...params, op.entity_id, ...conditionalParams]
  );
  if (upd.rows.length === 0 && useConditional) {
    // A concurrent writer transitioned status between our SELECT and UPDATE.
    // Re-read so the client sees the current state.
    const reread = await client.query<Record<string, unknown>>(
      "SELECT * FROM tasks WHERE id = $1",
      [op.entity_id]
    );
    return {
      status: "conflict" as const,
      snapshot: null,
      conflict: { reason: "STATUS_CONFLICT", current: reread.rows[0] ?? null },
    };
  }
  const change = await appendChange(client, "task", op.entity_id, "update");
  return { status: "applied" as const, snapshot: upd.rows[0], seq: change.seq };
}

const notePatchSchema = z
  .object({
    title: z.string().optional(),
    content: z.string().optional(),
    domain: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    scope: z.enum(["work", "personal", "shared"]).optional(),
    source_url: z.string().nullable().optional(),
    related_task_ids: z.array(z.string()).optional(),
  })
  .strict();

async function applyNoteOp(op: PushOp, client: PoolClient): Promise<ApplyResult> {
  if (op.op === "insert") {
    const payload = notePatchSchema.parse(op.payload ?? {});
    const res = await client.query<Record<string, unknown>>(
      `INSERT INTO notes (id, title, content, domain, tags, scope, source_url, related_task_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        op.entity_id,
        payload.title ?? "(untitled)",
        payload.content ?? "",
        payload.domain ?? null,
        payload.tags ?? [],
        payload.scope ?? "personal",
        payload.source_url ?? null,
        payload.related_task_ids ?? [],
      ]
    );
    const change = await appendChange(client, "note", op.entity_id, "insert");
    return { status: "applied" as const, snapshot: res.rows[0], seq: change.seq };
  }
  if (op.op === "delete") {
    await client.query("DELETE FROM notes WHERE id = $1", [op.entity_id]);
    const change = await appendChange(client, "note", op.entity_id, "delete");
    return { status: "applied" as const, snapshot: null, seq: change.seq };
  }
  const payload = notePatchSchema.parse(op.payload ?? {});
  const precondition = op.precondition ?? {};
  const current = await client.query<Record<string, unknown>>(
    "SELECT * FROM notes WHERE id = $1",
    [op.entity_id]
  );
  if (current.rows.length === 0) {
    return {
      status: "conflict" as const,
      snapshot: null,
      conflict: { reason: "NOT_FOUND", current: null },
    };
  }
  if (
    typeof precondition.base_updated_at === "string" &&
    String(current.rows[0].updated_at) !== precondition.base_updated_at
  ) {
    return {
      status: "conflict" as const,
      snapshot: null,
      conflict: { reason: "STALE_BASE", current: current.rows[0] },
    };
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  for (const [k, v] of Object.entries(payload)) {
    sets.push(`${k} = $${idx++}`);
    params.push(v);
  }
  if (sets.length === 0) {
    return { status: "applied" as const, snapshot: current.rows[0] };
  }
  const upd = await client.query<Record<string, unknown>>(
    `UPDATE notes SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    [...params, op.entity_id]
  );
  const change = await appendChange(client, "note", op.entity_id, "update");
  return { status: "applied" as const, snapshot: upd.rows[0], seq: change.seq };
}

const artifactPatchSchema = z
  .object({
    title: z.string().optional(),
    artifact_type: z.string().optional(),
    content: z.string().nullable().optional(),
    status: z.enum(["draft", "ready", "executing", "completed", "superseded"]).optional(),
    scope: z.enum(["work", "personal", "shared"]).optional(),
    tags: z.array(z.string()).optional(),
    execution_order: z.number().int().nullable().optional(),
  })
  .strict();

async function applyArtifactOp(op: PushOp, client: PoolClient): Promise<ApplyResult> {
  if (op.op === "insert") {
    const payload = artifactPatchSchema.parse(op.payload ?? {});
    const res = await client.query<Record<string, unknown>>(
      `INSERT INTO artifacts (id, title, artifact_type, content, status, scope, tags, execution_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        op.entity_id,
        payload.title ?? "(untitled)",
        payload.artifact_type ?? "note",
        payload.content ?? null,
        payload.status ?? "draft",
        payload.scope ?? "personal",
        payload.tags ?? [],
        payload.execution_order ?? null,
      ]
    );
    const change = await appendChange(client, "artifact", op.entity_id, "insert");
    return { status: "applied" as const, snapshot: res.rows[0], seq: change.seq };
  }
  if (op.op === "delete") {
    await client.query("DELETE FROM artifacts WHERE id = $1", [op.entity_id]);
    const change = await appendChange(client, "artifact", op.entity_id, "delete");
    return { status: "applied" as const, snapshot: null, seq: change.seq };
  }
  // update — conditional on expected_status when the caller supplies one and
  // the mutation itself changes status. Mirrors the item-3 pattern in
  // update_artifact.
  const payload = artifactPatchSchema.parse(op.payload ?? {});
  const precondition = op.precondition ?? {};
  const current = await client.query<Record<string, unknown>>(
    "SELECT * FROM artifacts WHERE id = $1",
    [op.entity_id]
  );
  if (current.rows.length === 0) {
    return {
      status: "conflict" as const,
      snapshot: null,
      conflict: { reason: "NOT_FOUND", current: null },
    };
  }
  const currentStatus = String(current.rows[0].status);
  const statusChanging =
    payload.status !== undefined && payload.status !== currentStatus;
  // Match applyTaskOp: only enforce expected_status when the payload actually
  // mutates status. A pure metadata edit (e.g. title-only) that happens to
  // carry expected_status is not a status transition, so it doesn't need the
  // guard. Otherwise task and artifact would diverge on the same precondition
  // shape, which is exactly what the item-3 spec section warns against.
  const useConditional =
    statusChanging && typeof precondition.expected_status === "string";
  if (
    useConditional &&
    currentStatus !== precondition.expected_status
  ) {
    return {
      status: "conflict" as const,
      snapshot: null,
      conflict: { reason: "STATUS_CONFLICT", current: current.rows[0] },
    };
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  for (const [k, v] of Object.entries(payload)) {
    sets.push(`${k} = $${idx++}`);
    params.push(v);
  }
  if (sets.length === 0) {
    return { status: "applied" as const, snapshot: current.rows[0] };
  }
  const idParam = `$${idx++}`;
  const conditional = useConditional ? ` AND status = $${idx++}` : "";
  const conditionalParams = useConditional ? [precondition.expected_status] : [];
  const upd = await client.query<Record<string, unknown>>(
    `UPDATE artifacts SET ${sets.join(", ")} WHERE id = ${idParam}${conditional} RETURNING *`,
    [...params, op.entity_id, ...conditionalParams]
  );
  if (upd.rows.length === 0 && useConditional) {
    const reread = await client.query<Record<string, unknown>>(
      "SELECT * FROM artifacts WHERE id = $1",
      [op.entity_id]
    );
    return {
      status: "conflict" as const,
      snapshot: null,
      conflict: { reason: "STATUS_CONFLICT", current: reread.rows[0] ?? null },
    };
  }
  const change = await appendChange(client, "artifact", op.entity_id, "update");
  return { status: "applied" as const, snapshot: upd.rows[0], seq: change.seq };
}

// ── Push op schema ───────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pushOpSchema = z.object({
  op_uuid: z.string().regex(UUID_RE, "op_uuid must be a UUID"),
  entity_type: z.enum(["task", "note", "artifact"]),
  entity_id: z.string().min(1),
  op: z.enum(["insert", "update", "delete"]),
  payload: z.record(z.unknown()).optional(),
  precondition: z
    .object({
      base_updated_at: z.string().optional(),
      expected_status: z.string().optional(),
    })
    .partial()
    .optional(),
});

const pushBodySchema = z.object({
  ops: z.array(pushOpSchema).min(1).max(200),
});

type PushOp = z.infer<typeof pushOpSchema>;

/**
 * Dispatch a single push op to the right entity applier. Runs inside the
 * caller-provided transaction so dedupe + apply commit or roll back together.
 */
async function applyOp(op: PushOp, client: PoolClient): Promise<ApplyResult> {
  switch (op.entity_type) {
    case "task":
      return applyTaskOp(op, client);
    case "note":
      return applyNoteOp(op, client);
    case "artifact":
      return applyArtifactOp(op, client);
  }
}

/**
 * Sentinel used to unwind the per-op transaction cleanly when the mutation
 * fails its precondition. Throwing (rather than returning) triggers the
 * standard withTransaction ROLLBACK path, which automatically undoes the
 * sync_op_log claim — no compensating DELETE required.
 */
class OpConflict extends Error {
  constructor(
    public readonly conflict: {
      reason: string;
      current: Record<string, unknown> | null;
    }
  ) {
    super(conflict.reason);
    this.name = "OpConflict";
  }
}

/**
 * Marker for the "already deduplicated" case. We can't return early from a
 * transaction directly because withTransaction always commits on non-throw,
 * but a dedup is not a rollback either — the earlier successful op stays
 * committed. So we exit the closure normally with this marker and translate
 * outside.
 */
type DedupOutcome = { kind: "dedup"; seq?: string };
type AppliedOutcome = {
  kind: "applied";
  seq?: string;
  snapshot: Record<string, unknown> | null;
};
type TxOutcome = DedupOutcome | AppliedOutcome;

async function processPushOp(op: PushOp): Promise<
  | { status: "applied"; seq?: string; snapshot: Record<string, unknown> | null }
  | { status: "dedup"; seq?: string }
  | { status: "conflict"; conflict: OpConflict["conflict"] }
  | { status: "error"; error: string }
> {
  try {
    const outcome = await withTransaction<TxOutcome>(async (client) => {
      // Claim the op_uuid FIRST inside the same transaction. Race-safe via
      // sync_op_log's UNIQUE constraint on op_uuid. If the claim conflicts
      // (someone else's push landed first), we return a dedup marker and let
      // the transaction commit as a no-op — nothing to roll back.
      const claim = await client.query<{ change_seq: string | null }>(
        `INSERT INTO sync_op_log (op_uuid, entity_type, entity_id, op)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (op_uuid) DO NOTHING
         RETURNING change_seq::text`,
        [op.op_uuid, op.entity_type, op.entity_id, op.op]
      );
      if (claim.rows.length === 0) {
        const existing = await client.query<{ change_seq: string | null }>(
          `SELECT change_seq::text FROM sync_op_log WHERE op_uuid = $1`,
          [op.op_uuid]
        );
        return {
          kind: "dedup",
          seq: existing.rows[0]?.change_seq ?? undefined,
        };
      }

      const result = await applyOp(op, client);
      if (result.status === "conflict") {
        // Throw so withTransaction rolls back; the claim we just inserted
        // vanishes with the rollback and the client can retry with a fresh
        // precondition. Sentinel is caught below to build the response.
        throw new OpConflict(result.conflict!);
      }

      // Applied — link the sync_op_log row to the change we just wrote so
      // future replays return the same seq.
      if (result.seq) {
        await client.query(
          `UPDATE sync_op_log SET change_seq = $1::bigint WHERE op_uuid = $2`,
          [result.seq, op.op_uuid]
        );
      }
      return {
        kind: "applied",
        seq: result.seq,
        snapshot: result.snapshot,
      };
    });

    if (outcome.kind === "dedup") {
      return { status: "dedup", seq: outcome.seq };
    }
    return {
      status: "applied",
      seq: outcome.seq,
      snapshot: outcome.snapshot,
    };
  } catch (err) {
    if (err instanceof OpConflict) {
      return { status: "conflict", conflict: err.conflict };
    }
    return { status: "error", error: (err as Error).message };
  }
}

/**
 * Register /sync/* routes on the app. All routes sit behind
 * syncAuthMiddleware; the MCP transport has its own upstream auth path.
 */
export function registerSyncRoutes(app: Hono): void {
  app.use("/sync/*", syncAuthMiddleware);

  // ── GET /sync/changes ─────────────────────────────────────────────
  app.get("/sync/changes", async (c) => {
    const cursorRaw = c.req.query("cursor") ?? "0";
    const limitRaw = c.req.query("limit");
    const cursor = /^\d+$/.test(cursorRaw) ? cursorRaw : "0";
    const parsedLimit = limitRaw ? parseInt(limitRaw, 10) : NaN;
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, config.syncChangesMaxLimit)
      : config.syncChangesDefaultLimit;

    // Ordered pull: `seq > cursor` guarantees strict progress even if the
    // client replays with the same cursor (idempotent). Snapshot loading
    // happens per unique (entity_type, entity_id) so a single entity that
    // changed N times in the window only re-materialises once.
    const changesRes = await query<ChangeRow>(
      `SELECT seq::text, entity_type, entity_id, op, changed_at
       FROM changes
       WHERE seq > $1::bigint
       ORDER BY seq ASC
       LIMIT $2`,
      [cursor, limit]
    );

    const snapshots: Record<string, Record<string, unknown> | null> = {};
    const uniq = new Map<string, { type: EntityType; id: string }>();
    for (const row of changesRes.rows) {
      const key = `${row.entity_type}:${row.entity_id}`;
      if (!uniq.has(key)) {
        uniq.set(key, { type: row.entity_type as EntityType, id: row.entity_id });
      }
    }
    for (const [key, ref] of uniq) {
      const loader = SNAPSHOT_LOADERS[ref.type];
      if (!loader) {
        snapshots[key] = null;
        continue;
      }
      try {
        snapshots[key] = await loader(ref.id);
      } catch (err) {
        console.warn(
          `[sync] Failed to load snapshot for ${key}: ${(err as Error).message}`
        );
        snapshots[key] = null;
      }
    }

    const nextCursor = changesRes.rows.length > 0
      ? changesRes.rows[changesRes.rows.length - 1].seq
      : cursor;
    const hasMore = changesRes.rows.length === limit;

    return c.json({
      changes: changesRes.rows.map((r) => ({
        seq: r.seq,
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        op: r.op,
        changed_at: r.changed_at,
      })),
      snapshots,
      next_cursor: nextCursor,
      has_more: hasMore,
      limit,
      idempotency:
        "Applying the returned changes+snapshots is idempotent; the puller may re-run this response any number of times and reach the same end state.",
    });
  });

  // ── POST /sync/push ───────────────────────────────────────────────
  app.post("/sync/push", async (c) => {
    // Body-size ceiling before we parse. `pushBodySchema.max(200)` bounds op
    // count but each `payload` / `precondition` is `z.unknown()`, so without
    // this a bearer-authenticated caller could push a 200-op batch of multi-MB
    // artifact content — DoS-adjacent. Content-Length can lie (chunked
    // encoding), so we also cap the actual bytes we read.
    const contentLength = c.req.header("content-length");
    if (contentLength) {
      const declared = parseInt(contentLength, 10);
      if (Number.isFinite(declared) && declared > config.syncPushMaxBytes) {
        return c.json(
          {
            error: "push body too large",
            code: "PAYLOAD_TOO_LARGE",
            max_bytes: config.syncPushMaxBytes,
            declared_bytes: declared,
          },
          413
        );
      }
    }

    let bodyText: string;
    try {
      bodyText = await c.req.text();
    } catch {
      return c.json({ error: "invalid body", code: "INVALID_BODY" }, 400);
    }
    const actualBytes = Buffer.byteLength(bodyText, "utf-8");
    if (actualBytes > config.syncPushMaxBytes) {
      return c.json(
        {
          error: "push body too large",
          code: "PAYLOAD_TOO_LARGE",
          max_bytes: config.syncPushMaxBytes,
          actual_bytes: actualBytes,
        },
        413
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return c.json({ error: "invalid JSON", code: "INVALID_BODY" }, 400);
    }
    const parsed = pushBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "invalid push body",
          code: "INVALID_BODY",
          issues: parsed.error.issues,
        },
        400
      );
    }

    // Per-op payload cap catches the pathological "one huge op" pattern before
    // it reaches the entity appliers. Chosen so a batch of 200 max-sized ops
    // still fits comfortably under syncPushMaxBytes.
    for (const op of parsed.data.ops) {
      const opBytes = Buffer.byteLength(JSON.stringify(op), "utf-8");
      if (opBytes > config.syncPushMaxOpBytes) {
        return c.json(
          {
            error: "individual op too large",
            code: "PAYLOAD_TOO_LARGE",
            op_uuid: op.op_uuid,
            actual_bytes: opBytes,
            max_bytes: config.syncPushMaxOpBytes,
          },
          413
        );
      }
    }

    const results: Array<{
      op_uuid: string;
      status: "applied" | "dedup" | "conflict" | "error";
      entity_type: string;
      entity_id: string;
      op: ChangeOp;
      seq?: string;
      snapshot?: Record<string, unknown> | null;
      conflict?: { reason: string; current: Record<string, unknown> | null };
      error?: string;
    }> = [];

    // Individual op processing — one failed op MUST NOT poison the batch
    // (design-doc §3, "reject stale ops INDIVIDUALLY"). Each op runs in its
    // own transaction so its state changes are isolated.
    for (const op of parsed.data.ops) {
      const outcome = await processPushOp(op);
      const base = {
        op_uuid: op.op_uuid,
        entity_type: op.entity_type,
        entity_id: op.entity_id,
        op: op.op as ChangeOp,
      };
      if (outcome.status === "applied") {
        results.push({
          ...base,
          status: "applied",
          seq: outcome.seq,
          snapshot: outcome.snapshot,
        });
      } else if (outcome.status === "dedup") {
        results.push({ ...base, status: "dedup", seq: outcome.seq });
      } else if (outcome.status === "conflict") {
        results.push({ ...base, status: "conflict", conflict: outcome.conflict });
      } else {
        results.push({ ...base, status: "error", error: outcome.error });
      }
    }

    return c.json({ results });
  });
}
