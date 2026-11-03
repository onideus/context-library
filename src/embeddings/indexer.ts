import { query } from "../db/client.js";
import { generateEmbedding } from "./client.js";
import { config } from "../config.js";
import { extractHandoffText, chunkText } from "./text.js";

// Re-export for existing consumers
export { extractHandoffText, chunkText } from "./text.js";

function toPgVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/**
 * Classify an embedding failure as TEI connectivity (transient) vs malformed-content (permanent).
 * Connectivity failures are worth queueing for later retry; malformed-content failures aren't.
 * Heuristic: TEI 4xx responses indicate bad request content; everything else (5xx, network error,
 * timeout, missing config) is treated as connectivity.
 */
function isTeiConnectivityError(err: unknown): boolean {
  const msg = (err as Error | undefined)?.message ?? "";
  if (/Embedding server error \(4\d\d\)/.test(msg)) return false;
  return true;
}

/**
 * Insert a pending embedding entry for later drain. Best-effort — tolerates missing table/DB.
 * Resolves to true when the item is queued (an ON CONFLICT no-op counts: it was already
 * queued) and false when the insert itself failed. Never throws.
 */
async function enqueuePending(
  contentType: "handoff" | "task" | "note" | "artifact",
  contentId: string
): Promise<boolean> {
  try {
    await query(
      `INSERT INTO pending_embeddings (content_type, content_id)
       VALUES ($1, $2)
       ON CONFLICT (content_type, content_id) DO NOTHING`,
      [contentType, contentId]
    );
    console.log(`[indexer] Queued pending embedding: ${contentType} ${contentId}`);
    return true;
  } catch (err) {
    console.warn(
      `[indexer] Failed to enqueue pending embedding for ${contentType} ${contentId}: ${(err as Error).message}`
    );
    return false;
  }
}

/**
 * What a single-item index call did: embedded the item, queued it in pending_embeddings
 * after a connectivity error, or neither (the enqueue failed too). Server call sites
 * ignore this; the bulk indexAll* functions count it.
 */
export type IndexOutcome = "indexed" | "queued" | "lost";

/** Index a single piece of content. Upserts by content_type + content_id. */
export async function indexContent(
  contentType: string,
  contentId: string,
  text: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  // Prepend nomic search_document prefix for indexing
  const prefixedText = `search_document: ${text}`;
  const embedding = await generateEmbedding(prefixedText);

  await query(
    `INSERT INTO embeddings (content_type, content_id, content_text, embedding, metadata)
     VALUES ($1, $2, $3, $4::vector, $5::jsonb)
     ON CONFLICT (content_type, content_id) DO UPDATE SET
       content_text = EXCLUDED.content_text,
       embedding = EXCLUDED.embedding,
       metadata = EXCLUDED.metadata,
       updated_at = now()`,
    [contentType, contentId, text, toPgVector(embedding), JSON.stringify(metadata)]
  );
}

// ── Handoff indexing ──────────────────────────────────────────

/** Raw handoff indexing — throws on failure. Used by drain path to avoid re-enqueueing. */
async function indexHandoffRaw(
  filename: string,
  handoff: Record<string, unknown>
): Promise<void> {
  const text = extractHandoffText(handoff);
  if (!text.trim()) return;

  const ctx = handoff.active_context as Record<string, unknown> | undefined;
  const chunks = chunkText(text);

  // Delete any existing embeddings for this handoff (old single-row or old chunks)
  await query(
    `DELETE FROM embeddings WHERE content_type = 'handoff' AND (content_id = $1 OR content_id LIKE $2)`,
    [filename, `${filename}#%`]
  );

  for (let i = 0; i < chunks.length; i++) {
    const chunkId = `${filename}#chunk_${i}`;
    const metadata: Record<string, unknown> = {
      stored_at: handoff.stored_at,
      session: ctx?.session,
      chunk_index: i,
      total_chunks: chunks.length,
      source_file: filename,
    };
    await indexContent("handoff", chunkId, chunks[i], metadata);
  }
}

/** Index a handoff file with chunking. On TEI connectivity failure, queues for later drain. */
export async function indexHandoff(
  filename: string,
  handoff: Record<string, unknown>
): Promise<IndexOutcome> {
  try {
    await indexHandoffRaw(filename, handoff);
    return "indexed";
  } catch (err) {
    if (isTeiConnectivityError(err)) {
      return (await enqueuePending("handoff", filename)) ? "queued" : "lost";
    }
    throw err;
  }
}

/** Raw task indexing — throws on failure. Used by drain path to avoid re-enqueueing. */
async function indexTaskRaw(
  id: string,
  title: string,
  context: string | null,
  scope: string,
  tags: string[],
  status: string,
  createdAt?: Date | string | null
): Promise<void> {
  const text = [title, context].filter(Boolean).join("\n");
  const metadata: Record<string, unknown> = { scope, tags, status };
  if (createdAt) {
    metadata.created_at =
      createdAt instanceof Date ? createdAt.toISOString() : createdAt;
  }
  await indexContent("task", id, text, metadata);
}

/** Raw note indexing — throws on failure. Used by drain path to avoid re-enqueueing. */
async function indexNoteRaw(
  id: string,
  note: {
    title: string;
    content: string;
    domain?: string | null;
    tags?: string[] | null;
    scope?: string;
    created_at?: string;
  }
): Promise<void> {
  const tagLine = note.tags?.length ? note.tags.join(", ") : "";
  const parts = [note.title, note.content, note.domain ?? "", tagLine];
  const text = parts.filter((p) => p && p.trim()).join("\n");
  await indexContent("note", id, text, {
    note_id: id,
    domain: note.domain ?? null,
    tags: note.tags ?? [],
    scope: note.scope ?? null,
    created_at: note.created_at ?? null,
  });
}

/** Index a single note. On TEI connectivity failure, queues for later drain. */
export async function indexNote(
  id: string,
  note: {
    title: string;
    content: string;
    domain?: string | null;
    tags?: string[] | null;
    scope?: string;
    created_at?: string;
  }
): Promise<IndexOutcome> {
  try {
    await indexNoteRaw(id, note);
    return "indexed";
  } catch (err) {
    if (isTeiConnectivityError(err)) {
      return (await enqueuePending("note", id)) ? "queued" : "lost";
    }
    throw err;
  }
}

/** Raw artifact indexing — throws on failure. Used by drain path to avoid re-enqueueing. */
async function indexArtifactRaw(
  id: string,
  artifact: {
    title: string;
    content: string | null;
    artifact_type: string;
    tags?: string[] | null;
    status?: string;
    scope?: string;
    created_at?: string;
  }
): Promise<void> {
  const tagLine = artifact.tags?.length ? artifact.tags.join(", ") : "";
  const parts = [artifact.title, artifact.content ?? "", artifact.artifact_type, tagLine];
  const text = parts.filter((p) => p && p.trim()).join("\n");
  if (!text.trim()) return;
  await indexContent("artifact", id, text, {
    artifact_id: id,
    artifact_type: artifact.artifact_type,
    tags: artifact.tags ?? [],
    status: artifact.status ?? null,
    scope: artifact.scope ?? null,
    created_at: artifact.created_at ?? null,
  });
}

/** Index a single artifact. On TEI connectivity failure, queues for later drain. */
export async function indexArtifact(
  id: string,
  artifact: {
    title: string;
    content: string | null;
    artifact_type: string;
    tags?: string[] | null;
    status?: string;
    scope?: string;
    created_at?: string;
  }
): Promise<IndexOutcome> {
  try {
    await indexArtifactRaw(id, artifact);
    return "indexed";
  } catch (err) {
    if (isTeiConnectivityError(err)) {
      return (await enqueuePending("artifact", id)) ? "queued" : "lost";
    }
    throw err;
  }
}

/** Index a single task. On TEI connectivity failure, queues for later drain. */
export async function indexTask(
  id: string,
  title: string,
  context: string | null,
  scope: string,
  tags: string[],
  status: string,
  createdAt?: Date | string | null
): Promise<IndexOutcome> {
  try {
    await indexTaskRaw(id, title, context, scope, tags, status, createdAt);
    return "indexed";
  } catch (err) {
    if (isTeiConnectivityError(err)) {
      return (await enqueuePending("task", id)) ? "queued" : "lost";
    }
    throw err;
  }
}

/** Per-item counts from a bulk index pass over one table. */
export interface IndexAllResult {
  /** Embedded and written to `embeddings`. */
  indexed: number;
  /** Queued in pending_embeddings after a connectivity error — not embedded yet. */
  queued: number;
  /** Neither embedded nor queued: indexing threw (e.g. a 4xx), or the enqueue failed. */
  failed: number;
}

/** Bulk index all existing handoff files. For initial backfill. */
export async function indexAllHandoffs(): Promise<{
  indexed: number;
  skipped: number;
  /** Queued in pending_embeddings after a connectivity error — not embedded yet. */
  queued: number;
  /** Files that threw, or whose enqueue failed after a connectivity error. */
  errors: number;
}> {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const handoffsDir = join(config.dataDir, "handoffs");
  let files: string[];
  try {
    files = (await readdir(handoffsDir))
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return { indexed: 0, skipped: 0, queued: 0, errors: 0 };
  }

  let indexed = 0,
    skipped = 0,
    queued = 0,
    errors = 0;

  for (const file of files) {
    try {
      const raw = await readFile(join(handoffsDir, file), "utf-8");
      const handoff = JSON.parse(raw);
      const text = extractHandoffText(handoff);
      const chunkCount = chunkText(text).length;
      const outcome = await indexHandoff(file, handoff);
      if (outcome === "indexed") {
        indexed++;
        console.log(`[indexer] Indexed handoff: ${file} (${chunkCount} chunks)`);
      } else if (outcome === "queued") {
        queued++;
      } else {
        errors++;
        console.error(`[indexer] Failed to index ${file}: not embedded and could not be queued`);
      }
    } catch (err) {
      errors++;
      console.error(
        `[indexer] Failed to index ${file}:`,
        (err as Error).message
      );
    }
  }

  return { indexed, skipped, queued, errors };
}

/** Count one bulk-pass item into `counts`; a thrown error is logged and counted as failed. */
async function countOutcome(
  counts: IndexAllResult,
  label: string,
  run: () => Promise<IndexOutcome>
): Promise<void> {
  try {
    const outcome = await run();
    if (outcome === "indexed") {
      counts.indexed++;
    } else if (outcome === "queued") {
      counts.queued++;
    } else {
      counts.failed++;
      console.error(`[indexer] Failed to index ${label}: not embedded and could not be queued`);
    }
  } catch (err) {
    counts.failed++;
    console.error(`[indexer] Failed to index ${label}:`, (err as Error).message);
  }
}

/** Bulk index all tasks from the tasks table. */
export async function indexAllTasks(): Promise<IndexAllResult> {
  const result = await query<{
    id: string;
    title: string;
    context: string | null;
    scope: string;
    tags: string[];
    status: string;
    created_at: Date;
  }>("SELECT id, title, context, scope, tags, status, created_at FROM tasks");

  const counts: IndexAllResult = { indexed: 0, queued: 0, failed: 0 };
  for (const row of result.rows) {
    await countOutcome(counts, `task ${row.id}`, () =>
      indexTask(
        row.id,
        row.title,
        row.context,
        row.scope,
        row.tags,
        row.status,
        row.created_at
      )
    );
  }

  return counts;
}

/** Bulk index all notes from the notes table. */
export async function indexAllNotes(): Promise<IndexAllResult> {
  const result = await query<{
    id: string;
    title: string;
    content: string;
    domain: string | null;
    tags: string[];
    scope: string;
    created_at: string;
  }>("SELECT id, title, content, domain, tags, scope, created_at FROM notes");

  const counts: IndexAllResult = { indexed: 0, queued: 0, failed: 0 };
  for (const row of result.rows) {
    await countOutcome(counts, `note ${row.id}`, () =>
      indexNote(row.id, {
        title: row.title,
        content: row.content,
        domain: row.domain,
        tags: row.tags,
        scope: row.scope,
        created_at: row.created_at,
      })
    );
  }

  return counts;
}

/** Bulk index all artifacts from the artifacts table. */
export async function indexAllArtifacts(): Promise<IndexAllResult> {
  const result = await query<{
    id: string;
    title: string;
    content: string | null;
    artifact_type: string;
    tags: string[];
    status: string;
    scope: string;
    created_at: string;
  }>(
    "SELECT id, title, content, artifact_type, tags, status, scope, created_at FROM artifacts"
  );

  const counts: IndexAllResult = { indexed: 0, queued: 0, failed: 0 };
  for (const row of result.rows) {
    await countOutcome(counts, `artifact ${row.id}`, () =>
      indexArtifact(row.id, {
        title: row.title,
        content: row.content,
        artifact_type: row.artifact_type,
        tags: row.tags,
        status: row.status,
        scope: row.scope,
        created_at: row.created_at,
      })
    );
  }

  return counts;
}

// ── Pending queue drain ───────────────────────────────────────

interface PendingRow {
  id: number;
  content_type: "handoff" | "task" | "note" | "artifact";
  content_id: string;
}

/**
 * Check whether a specific (content_type, content_id) pair is queued for
 * pending embedding. Returns true on query failure — callers (compaction,
 * backfill) should treat an unknown state as "still pending" and skip,
 * rather than archive content whose embedding we can't confirm.
 */
export async function hasPendingEmbedding(
  contentType: "handoff" | "task" | "note" | "artifact",
  contentId: string
): Promise<boolean> {
  try {
    const result = await query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pending_embeddings
         WHERE content_type = $1 AND content_id = $2
       ) AS exists`,
      [contentType, contentId]
    );
    return Boolean(result.rows[0]?.exists);
  } catch (err) {
    console.warn(
      "[hasPendingEmbedding] Postgres check failed — assuming pending (conservative):",
      (err as Error).message
    );
    return true;
  }
}

/**
 * Count rows currently in the pending_embeddings queue.
 * Returns 0 if the table doesn't exist yet or Postgres is unavailable.
 */
export async function getPendingEmbeddingsCount(): Promise<number> {
  try {
    const result = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pending_embeddings`
    );
    return Number(result.rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Count queued rows other than handoffs. Used for `remaining` when a drain runs with
 * `skipHandoffs`. Returns 0 if the table doesn't exist yet or Postgres is unavailable,
 * like getPendingEmbeddingsCount, but logs a warning so a failed count is not mistaken
 * for an empty queue.
 */
async function getPendingNonHandoffCount(): Promise<number> {
  try {
    const result = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pending_embeddings WHERE content_type <> 'handoff'`
    );
    return Number(result.rows[0]?.count ?? 0);
  } catch (err) {
    console.warn(
      "[indexer] Could not count pending embeddings, reporting remaining=0:",
      (err as Error).message
    );
    return 0;
  }
}

export interface DrainOptions {
  /**
   * Leave handoff rows alone: they are excluded in the select, so they are neither read,
   * re-embedded nor deleted, and do not use up the batch. `remaining` then counts
   * non-handoff rows only. For callers whose DATA_DIR may not be the deployment's
   * (scripts/reindex.ts); the server's own drains use the default.
   */
  skipHandoffs?: boolean;
}

export interface DrainResult {
  /** Rows re-embedded and removed from the queue. */
  processed: number;
  /** Rows still queued after this pass (non-handoff rows only under `skipHandoffs`). */
  remaining: number;
  /** Rows that were not embedded this pass, drops included. */
  errors: number;
  /**
   * Rows deleted without being embedded because there is nothing to embed: the source
   * file or row no longer exists (or the content_type is unsupported). Counted in
   * `errors` too, so `errors - dropped` is the number of rows that failed and stay queued.
   */
  dropped: number;
  /** The rows that failed to embed and stay queued (retry_count bumped), with the error. */
  failures: Array<{ content_type: string; content_id: string; error: string }>;
  /** Set when the queue itself could not be read (table missing, database unavailable). */
  select_error?: string;
}

/**
 * Process queued pending embeddings in FIFO order, re-embedding and removing each on success.
 * On a single failure, stops draining (TEI likely went back down) and bumps retry_count / last_error.
 * Returns counts of processed, remaining, errors and dropped rows observed this pass.
 */
export async function drainPendingEmbeddings(
  batchSize = 20,
  opts: DrainOptions = {}
): Promise<DrainResult> {
  const skipHandoffs = opts.skipHandoffs === true;
  let pendingRows: PendingRow[];
  try {
    const result = await query<PendingRow>(
      `SELECT id, content_type, content_id
       FROM pending_embeddings
       ${skipHandoffs ? "WHERE content_type <> 'handoff'" : ""}
       ORDER BY created_at ASC
       LIMIT $1`,
      [batchSize]
    );
    pendingRows = result.rows;
  } catch (err) {
    // Table doesn't exist yet or DB unavailable — nothing to drain.
    return {
      processed: 0,
      remaining: 0,
      errors: 0,
      dropped: 0,
      failures: [],
      select_error: (err as Error).message ?? "unknown error",
    };
  }

  if (pendingRows.length === 0) {
    const remaining = skipHandoffs ? await getPendingNonHandoffCount() : 0;
    return { processed: 0, remaining, errors: 0, dropped: 0, failures: [] };
  }

  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  let processed = 0;
  let errors = 0;
  let dropped = 0;
  const failures: DrainResult["failures"] = [];
  let stop = false;

  for (const row of pendingRows) {
    if (stop) break;
    try {
      if (row.content_type === "handoff") {
        const path = join(config.dataDir, "handoffs", row.content_id);
        let handoff: Record<string, unknown>;
        try {
          const raw = await readFile(path, "utf-8");
          handoff = JSON.parse(raw);
        } catch (fsErr) {
          // Source file is gone — drop from queue, count as error, keep draining.
          await query(`DELETE FROM pending_embeddings WHERE id = $1`, [row.id]);
          errors++;
          dropped++;
          console.warn(
            `[indexer] Dropped pending handoff ${row.content_id} — source missing: ${(fsErr as Error).message}`
          );
          continue;
        }
        await indexHandoffRaw(row.content_id, handoff);
      } else if (row.content_type === "task") {
        const taskResult = await query<{
          id: string;
          title: string;
          context: string | null;
          scope: string;
          tags: string[];
          status: string;
          created_at: Date;
        }>(
          `SELECT id, title, context, scope, tags, status, created_at
           FROM tasks WHERE id = $1`,
          [row.content_id]
        );
        const task = taskResult.rows[0];
        if (!task) {
          await query(`DELETE FROM pending_embeddings WHERE id = $1`, [row.id]);
          errors++;
          dropped++;
          console.warn(
            `[indexer] Dropped pending task ${row.content_id} — source missing`
          );
          continue;
        }
        await indexTaskRaw(
          task.id,
          task.title,
          task.context,
          task.scope,
          task.tags,
          task.status,
          task.created_at
        );
      } else if (row.content_type === "note") {
        const noteResult = await query<{
          id: string;
          title: string;
          content: string;
          domain: string | null;
          tags: string[];
          scope: string;
          created_at: string;
        }>(
          `SELECT id, title, content, domain, tags, scope, created_at
           FROM notes WHERE id = $1`,
          [row.content_id]
        );
        const note = noteResult.rows[0];
        if (!note) {
          await query(`DELETE FROM pending_embeddings WHERE id = $1`, [row.id]);
          errors++;
          dropped++;
          console.warn(
            `[indexer] Dropped pending note ${row.content_id} — source missing`
          );
          continue;
        }
        await indexNoteRaw(note.id, {
          title: note.title,
          content: note.content,
          domain: note.domain,
          tags: note.tags,
          scope: note.scope,
          created_at: note.created_at,
        });
      } else if (row.content_type === "artifact") {
        const artifactResult = await query<{
          id: string;
          title: string;
          content: string | null;
          artifact_type: string;
          tags: string[];
          status: string;
          scope: string;
          created_at: string;
        }>(
          `SELECT id, title, content, artifact_type, tags, status, scope, created_at
           FROM artifacts WHERE id = $1`,
          [row.content_id]
        );
        const artifact = artifactResult.rows[0];
        if (!artifact) {
          await query(`DELETE FROM pending_embeddings WHERE id = $1`, [row.id]);
          errors++;
          dropped++;
          console.warn(
            `[indexer] Dropped pending artifact ${row.content_id} — source missing`
          );
          continue;
        }
        await indexArtifactRaw(artifact.id, {
          title: artifact.title,
          content: artifact.content,
          artifact_type: artifact.artifact_type,
          tags: artifact.tags,
          status: artifact.status,
          scope: artifact.scope,
          created_at: artifact.created_at,
        });
      } else {
        // Unknown content_type — drop and move on so the queue can drain.
        await query(`DELETE FROM pending_embeddings WHERE id = $1`, [row.id]);
        errors++;
        dropped++;
        console.warn(
          `[indexer] Dropped pending ${row.content_type} ${row.content_id} — unsupported content_type`
        );
        continue;
      }

      await query(`DELETE FROM pending_embeddings WHERE id = $1`, [row.id]);
      processed++;
    } catch (err) {
      errors++;
      const message = (err as Error).message ?? "unknown error";
      failures.push({ content_type: row.content_type, content_id: row.content_id, error: message });
      try {
        await query(
          `UPDATE pending_embeddings
           SET retry_count = retry_count + 1, last_error = $1
           WHERE id = $2`,
          [message.slice(0, 1000), row.id]
        );
      } catch {
        // best-effort
      }
      // If TEI connectivity failed, stop — no point hammering it this cycle.
      if (isTeiConnectivityError(err)) {
        stop = true;
      }
    }
  }

  const remaining = skipHandoffs
    ? await getPendingNonHandoffCount()
    : await getPendingEmbeddingsCount();
  return { processed, remaining, errors, dropped, failures };
}
