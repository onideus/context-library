import { config } from "../config.js";
import { getActiveProvider, getProvider } from "./registry.js";
import { createExtractionRun, completeExtractionRun, failExtractionRun, storeTriples } from "./store.js";
import { extractHandoffText } from "../embeddings/indexer.js";
import { query } from "../db/client.js";

// ── Single-item extraction ────────────────────────────────────────────

/**
 * Extract entities from a single content item and persist to Postgres.
 * Does NOT throw — all errors are logged. Intended as fire-and-forget.
 */
export async function extractAndStore(
  contentType: "handoff" | "note" | "task",
  contentId: string,
  content: string,
  runId?: string
): Promise<void> {
  if (!config.entityExtractionEnabled) return;
  if (!content.trim()) return;

  const provider = getActiveProvider();
  if (!provider) {
    console.warn("[entity-pipeline] No active provider configured — skipping extraction");
    return;
  }

  const isAvailable = await provider.available().catch(() => false);
  if (!isAvailable) {
    console.warn(
      `[entity-pipeline] Provider '${provider.provider}' unavailable — skipping extraction for ${contentType} ${contentId}`
    );
    return;
  }

  const ownRun = !runId;
  let activeRunId = runId ?? null;

  try {
    if (ownRun) {
      activeRunId = await createExtractionRun(provider.provider, provider.version, {
        contentType,
        contentId,
        model: config.ollamaExtractionModel,
      });
    }

    const result = await provider.extract(content, contentType, contentId);

    const stored = activeRunId ? await storeTriples(result, activeRunId) : 0;

    if (ownRun && activeRunId) {
      await completeExtractionRun(activeRunId, stored);
    }

    console.log(
      `[entity-pipeline] Extracted ${result.triples.length} triples (stored ${stored}) ` +
        `from ${contentType} ${contentId} in ${result.durationMs}ms`
    );
  } catch (err) {
    console.warn(
      `[entity-pipeline] Extraction failed for ${contentType} ${contentId}:`,
      (err as Error).message
    );
    if (ownRun && activeRunId) {
      await failExtractionRun(activeRunId, (err as Error).message).catch(() => {});
    }
  }
}

// ── Batch extraction ──────────────────────────────────────────────────

/**
 * Process multiple content items sequentially under a single extraction run.
 * Sequential (not parallel) to avoid hammering the GPU.
 */
export async function extractBatch(
  contentType: "handoff" | "note" | "task",
  items: Array<{ id: string; content: string }>
): Promise<{ runId: string | null; processed: number; totalTriples: number }> {
  if (!config.entityExtractionEnabled) {
    return { runId: null, processed: 0, totalTriples: 0 };
  }

  const provider = getActiveProvider();
  if (!provider) {
    console.warn("[entity-pipeline] No active provider — skipping batch");
    return { runId: null, processed: 0, totalTriples: 0 };
  }

  const isAvailable = await provider.available().catch(() => false);
  if (!isAvailable) {
    console.warn(`[entity-pipeline] Provider '${provider.provider}' unavailable — skipping batch`);
    return { runId: null, processed: 0, totalTriples: 0 };
  }

  const runId = await createExtractionRun(provider.provider, provider.version, {
    contentType,
    contentCount: items.length,
    model: config.ollamaExtractionModel,
  });

  let processed = 0;
  let totalTriples = 0;

  for (const item of items) {
    if (!item.content.trim()) continue;
    try {
      const result = await provider.extract(item.content, contentType, item.id);
      const stored = runId ? await storeTriples(result, runId) : 0;
      totalTriples += stored;
      processed++;
      console.log(
        `[entity-pipeline] Batch: ${contentType} ${item.id} → ${result.triples.length} triples (${stored} stored)`
      );
    } catch (err) {
      console.warn(
        `[entity-pipeline] Batch item failed (${contentType} ${item.id}):`,
        (err as Error).message
      );
    }
  }

  if (runId) {
    await completeExtractionRun(runId, totalTriples);
  }

  return { runId, processed, totalTriples };
}

// ── Re-extraction ─────────────────────────────────────────────────────

/**
 * Re-run extraction for all handoffs and notes using the specified provider
 * (or the active provider from config). Creates a fresh run per content type.
 */
export async function reextractAll(providerName?: string): Promise<{
  handoffs: { runId: string | null; processed: number };
  notes: { runId: string | null; processed: number };
}> {
  const provider = providerName ? getProvider(providerName) : getActiveProvider();
  if (!provider) {
    console.warn("[entity-pipeline] reextractAll: no provider available");
    return {
      handoffs: { runId: null, processed: 0 },
      notes: { runId: null, processed: 0 },
    };
  }

  const isAvailable = await provider.available().catch(() => false);
  if (!isAvailable) {
    console.warn(`[entity-pipeline] reextractAll: provider '${provider.provider}' unavailable`);
    return {
      handoffs: { runId: null, processed: 0 },
      notes: { runId: null, processed: 0 },
    };
  }

  // ── Handoffs ──────────────────────────────────────────────────────
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const handoffsDir = join(config.dataDir, "handoffs");
  let handoffFiles: string[] = [];
  try {
    handoffFiles = (await readdir(handoffsDir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    // Directory missing or unreadable — proceed with empty list
  }

  let handoffRunId: string | null = null;
  let handoffsProcessed = 0;

  if (handoffFiles.length > 0) {
    handoffRunId = await createExtractionRun(provider.provider, provider.version, {
      scope: "all-handoffs",
      contentCount: handoffFiles.length,
      model: config.ollamaExtractionModel,
    });

    let handoffTriples = 0;

    for (const file of handoffFiles) {
      try {
        const raw = await readFile(join(handoffsDir, file), "utf-8");
        const handoff = JSON.parse(raw) as Record<string, unknown>;
        const text = extractHandoffText(handoff);
        if (!text.trim()) continue;
        const result = await provider.extract(text, "handoff", file);
        const stored = await storeTriples(result, handoffRunId!);
        handoffTriples += stored;
        handoffsProcessed++;
      } catch (err) {
        console.warn(`[entity-pipeline] reextractAll handoff ${file}:`, (err as Error).message);
      }
    }

    await completeExtractionRun(handoffRunId, handoffTriples);
  }

  // ── Notes ─────────────────────────────────────────────────────────
  let noteRows: Array<{ id: string; title: string; content: string }> = [];
  try {
    const result = await query<{ id: string; title: string; content: string }>(
      "SELECT id, title, content FROM notes ORDER BY created_at ASC"
    );
    noteRows = result.rows;
  } catch (err) {
    console.warn("[entity-pipeline] reextractAll: failed to fetch notes:", (err as Error).message);
  }

  let noteRunId: string | null = null;
  let notesProcessed = 0;

  if (noteRows.length > 0) {
    noteRunId = await createExtractionRun(provider.provider, provider.version, {
      scope: "all-notes",
      contentCount: noteRows.length,
      model: config.ollamaExtractionModel,
    });

    let noteTriples = 0;

    for (const note of noteRows) {
      try {
        const text = [note.title, note.content].filter(Boolean).join("\n");
        const result = await provider.extract(text, "note", note.id);
        const stored = await storeTriples(result, noteRunId!);
        noteTriples += stored;
        notesProcessed++;
      } catch (err) {
        console.warn(`[entity-pipeline] reextractAll note ${note.id}:`, (err as Error).message);
      }
    }

    await completeExtractionRun(noteRunId, noteTriples);
  }

  return {
    handoffs: { runId: handoffRunId, processed: handoffsProcessed },
    notes: { runId: noteRunId, processed: notesProcessed },
  };
}
