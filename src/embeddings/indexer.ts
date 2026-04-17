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

/** Insert a pending embedding entry for later drain. Best-effort — tolerates missing table/DB. */
async function enqueuePending(
  contentType: "handoff" | "task",
  contentId: string
): Promise<void> {
  try {
    await query(
      `INSERT INTO pending_embeddings (content_type, content_id)
       VALUES ($1, $2)
       ON CONFLICT (content_type, content_id) DO NOTHING`,
      [contentType, contentId]
    );
    console.log(`[indexer] Queued pending embedding: ${contentType} ${contentId}`);
  } catch (err) {
    console.warn(
      `[indexer] Failed to enqueue pending embedding for ${contentType} ${contentId}: ${(err as Error).message}`
    );
  }
}

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
): Promise<void> {
  try {
    await indexHandoffRaw(filename, handoff);
  } catch (err) {
    if (isTeiConnectivityError(err)) {
      await enqueuePending("handoff", filename);
      return;
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

/** Index a single note. */
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

/** Index a single task. On TEI connectivity failure, queues for later drain. */
export async function indexTask(
  id: string,
  title: string,
  context: string | null,
  scope: string,
  tags: string[],
  status: string,
  createdAt?: Date | string | null
): Promise<void> {
  try {
    await indexTaskRaw(id, title, context, scope, tags, status, createdAt);
  } catch (err) {
    if (isTeiConnectivityError(err)) {
      await enqueuePending("task", id);
      return;
    }
    throw err;
  }
}

/** Bulk index all existing handoff files. For initial backfill. */
export async function indexAllHandoffs(): Promise<{
  indexed: number;
  skipped: number;
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
    return { indexed: 0, skipped: 0, errors: 0 };
  }

  let indexed = 0,
    skipped = 0,
    errors = 0;

  for (const file of files) {
    try {
      const raw = await readFile(join(handoffsDir, file), "utf-8");
      const handoff = JSON.parse(raw);
      const text = extractHandoffText(handoff);
      const chunkCount = chunkText(text).length;
      await indexHandoff(file, handoff);
      indexed++;
      console.log(`[indexer] Indexed handoff: ${file} (${chunkCount} chunks)`);
    } catch (err) {
      errors++;
      console.error(
        `[indexer] Failed to index ${file}:`,
        (err as Error).message
      );
    }
  }

  return { indexed, skipped, errors };
}

/** Bulk index all tasks from the tasks table. */
export async function indexAllTasks(): Promise<number> {
  const result = await query<{
    id: string;
    title: string;
    context: string | null;
    scope: string;
    tags: string[];
    status: string;
    created_at: Date;
  }>("SELECT id, title, context, scope, tags, status, created_at FROM tasks");

  let indexed = 0;
  for (const row of result.rows) {
    try {
      await indexTask(
        row.id,
        row.title,
        row.context,
        row.scope,
        row.tags,
        row.status,
        row.created_at
      );
      indexed++;
    } catch (err) {
      console.error(
        `[indexer] Failed to index task ${row.id}:`,
        (err as Error).message
      );
    }
  }

  return indexed;
}

/** Bulk index all notes from the notes table. */
export async function indexAllNotes(): Promise<number> {
  const result = await query<{
    id: string;
    title: string;
    content: string;
    domain: string | null;
    tags: string[];
    scope: string;
    created_at: string;
  }>("SELECT id, title, content, domain, tags, scope, created_at FROM notes");

  let indexed = 0;
  for (const row of result.rows) {
    try {
      await indexNote(row.id, {
        title: row.title,
        content: row.content,
        domain: row.domain,
        tags: row.tags,
        scope: row.scope,
        created_at: row.created_at,
      });
      indexed++;
    } catch (err) {
      console.error(
        `[indexer] Failed to index note ${row.id}:`,
        (err as Error).message
      );
    }
  }

  return indexed;
}

// ── Pending queue drain ───────────────────────────────────────

interface PendingRow {
  id: number;
  content_type: "handoff" | "task";
  content_id: string;
}

/**
 * Check whether a specific (content_type, content_id) pair is queued for
 * pending embedding. Returns true on query failure — callers (compaction,
 * backfill) should treat an unknown state as "still pending" and skip,
 * rather than archive content whose embedding we can't confirm.
 */
export async function hasPendingEmbedding(
  contentType: "handoff" | "task",
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
 * Process queued pending embeddings in FIFO order, re-embedding and removing each on success.
 * On a single failure, stops draining (TEI likely went back down) and bumps retry_count / last_error.
 * Returns counts of processed, remaining, and errors observed this pass.
 */
export async function drainPendingEmbeddings(
  batchSize = 20
): Promise<{ processed: number; remaining: number; errors: number }> {
  let pendingRows: PendingRow[];
  try {
    const result = await query<PendingRow>(
      `SELECT id, content_type, content_id
       FROM pending_embeddings
       ORDER BY created_at ASC
       LIMIT $1`,
      [batchSize]
    );
    pendingRows = result.rows;
  } catch {
    // Table doesn't exist yet or DB unavailable — nothing to drain.
    return { processed: 0, remaining: 0, errors: 0 };
  }

  if (pendingRows.length === 0) {
    return { processed: 0, remaining: 0, errors: 0 };
  }

  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  let processed = 0;
  let errors = 0;
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
          console.warn(
            `[indexer] Dropped pending handoff ${row.content_id} — source missing: ${(fsErr as Error).message}`
          );
          continue;
        }
        await indexHandoffRaw(row.content_id, handoff);
      } else {
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
      }

      await query(`DELETE FROM pending_embeddings WHERE id = $1`, [row.id]);
      processed++;
    } catch (err) {
      errors++;
      const message = (err as Error).message ?? "unknown error";
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

  const remaining = await getPendingEmbeddingsCount();
  return { processed, remaining, errors };
}
