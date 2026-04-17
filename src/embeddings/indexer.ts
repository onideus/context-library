import { query } from "../db/client.js";
import { generateEmbedding } from "./client.js";
import { config } from "../config.js";
import { extractHandoffText, chunkText } from "./text.js";

// Re-export for existing consumers
export { extractHandoffText, chunkText } from "./text.js";

function toPgVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
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

/** Index a handoff file with chunking. */
export async function indexHandoff(
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

/** Index a single task. */
export async function indexTask(
  id: string,
  title: string,
  context: string | null,
  scope: string,
  tags: string[],
  status: string
): Promise<void> {
  const text = [title, context].filter(Boolean).join("\n");
  await indexContent("task", id, text, { scope, tags, status });
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
  }>("SELECT id, title, context, scope, tags, status FROM tasks");

  let indexed = 0;
  for (const row of result.rows) {
    try {
      await indexTask(
        row.id,
        row.title,
        row.context,
        row.scope,
        row.tags,
        row.status
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
