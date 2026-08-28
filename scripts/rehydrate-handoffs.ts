#!/usr/bin/env tsx
/**
 * rehydrate-handoffs — reconstruct the text of compacted handoffs from the
 * chunks that were embedded before compaction ran.
 *
 * Run `scripts/audit-compaction.ts` first. This script only touches files that
 * audit classifies RECOVERABLE.
 *
 * WHAT THIS CAN AND CANNOT RESTORE
 * --------------------------------
 * The embeddings index does not hold the original JSON. indexHandoffRaw called
 * extractHandoffText(), which FLATTENS the handoff into `key: value` prose
 * lines, then chunkText() split that prose. So what comes back is the TEXT of
 * active_context, not its key structure. Nested objects, array boundaries, and
 * the exact field layout are gone and cannot be inferred. This script writes
 * the recovered prose and says so; it does not reconstruct plausible-looking
 * JSON that no longer exists.
 *
 * chunkText() splits without overlap, and the separator it split on (paragraph
 * break, line break, or sentence boundary) is not recorded. Rejoining is
 * therefore lossy at the seams: `recovered_text` marks each seam explicitly
 * rather than guessing, and `chunks` carries the raw ordered pieces so a reader
 * can rejoin them differently.
 *
 * SAFETY
 * ------
 * - The compacted handoff files are never read-modify-written. Recovery output
 *   goes to DATA_DIR/handoffs/archive/<filename>.recovered.json — a sidecar,
 *   outside retention and invisible to handoff listing.
 * - --dry-run is the DEFAULT. Nothing is written without --write.
 * - Existing .recovered.json sidecars are left alone unless --force.
 * - Read-only against Postgres. Never call reindex/indexAllHandoffs before
 *   recovery is complete — it overwrites the very chunks this script reads.
 *
 * Usage:
 *   npx tsx scripts/rehydrate-handoffs.ts             # dry run (default)
 *   npx tsx scripts/rehydrate-handoffs.ts --write     # emit sidecars
 *   npx tsx scripts/rehydrate-handoffs.ts --write --force   # regenerate existing
 *
 * Environment:
 *   DATA_DIR  Root data dir (default: ./data).
 */

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../src/config.js";
import { ARCHIVE_DIRNAME } from "../src/storage/json-store.js";
import type { Handoff } from "../src/storage/schemas.js";
import {
  scanHandoffDir,
  assessViability,
  fetchChunksFromPostgres,
  type ChunkFetcher,
  type ChunkRow,
} from "./audit-compaction.js";

/** Inserted where two chunks meet, because the original separator is unrecoverable. */
export const CHUNK_BOUNDARY_MARKER = "\n\n[--- chunk boundary (original separator not recorded) ---]\n\n";

export const RECOVERY_METHOD = "embeddings-chunks";

export interface RecoveryRecord {
  source_file: string;
  recovered_at: string;
  recovery_method: typeof RECOVERY_METHOD;
  stored_at: string | null;
  /**
   * Honest description of what the text is, carried in the artifact itself so
   * a future reader is not misled by it.
   */
  limitation: string;
  chunk_count: number;
  recovered_chars: number;
  recovered_text: string;
  /** Raw ordered chunks, so the seam markers can be re-joined differently. */
  chunks: string[];
  /** Fields that survived compaction, copied verbatim from the compacted file. */
  preserved: {
    operational_state?: unknown;
    tone_notes?: unknown;
    session_meta?: unknown;
  };
}

const LIMITATION =
  "Recovered from embeddings.content_text. extractHandoffText() flattened the " +
  "handoff to `key: value` prose before chunking, so this restores the TEXT of " +
  "active_context, not its original key structure. Chunk seams are marked; the " +
  "separator chunkText() split on was not recorded.";

// ── Pure helpers ──────────────────────────────────────────────────

/** Order chunks by index — metadata first, falling back to the `#chunk_N` id suffix. */
export function orderChunks(chunks: ChunkRow[]): ChunkRow[] {
  const indexOf = (c: ChunkRow): number => {
    if (typeof c.chunk_index === "number" && Number.isFinite(c.chunk_index)) {
      return c.chunk_index;
    }
    const m = /#chunk_(\d+)$/.exec(c.content_id);
    // A legacy single-row embedding (no `#chunk_N` suffix) sorts first.
    return m ? Number(m[1]) : -1;
  };
  return [...chunks].sort((a, b) => indexOf(a) - indexOf(b));
}

/** Join ordered chunks with an explicit seam marker rather than a guessed separator. */
export function joinChunks(chunks: ChunkRow[]): string {
  return orderChunks(chunks)
    .map((c) => c.content_text)
    .join(CHUNK_BOUNDARY_MARKER);
}

export function buildRecoveryRecord(
  filename: string,
  compacted: Handoff,
  chunks: ChunkRow[],
  recoveredAt = new Date().toISOString()
): RecoveryRecord {
  const ordered = orderChunks(chunks);
  const text = ordered.map((c) => c.content_text).join(CHUNK_BOUNDARY_MARKER);
  const record = compacted as Record<string, unknown>;
  const ctx = (record.active_context ?? {}) as Record<string, unknown>;

  const preserved: RecoveryRecord["preserved"] = {};
  if (record.operational_state !== undefined) preserved.operational_state = record.operational_state;
  if (record.tone_notes !== undefined) preserved.tone_notes = record.tone_notes;
  if (ctx.session_meta !== undefined) preserved.session_meta = ctx.session_meta;

  return {
    source_file: filename,
    recovered_at: recoveredAt,
    recovery_method: RECOVERY_METHOD,
    stored_at: typeof compacted.stored_at === "string" ? compacted.stored_at : null,
    limitation: LIMITATION,
    chunk_count: ordered.length,
    recovered_chars: text.length,
    recovered_text: text,
    chunks: ordered.map((c) => c.content_text),
    preserved,
  };
}

export function recoveredSidecarName(filename: string): string {
  return `${filename}.recovered.json`;
}

// ── Orchestration ─────────────────────────────────────────────────

export interface RehydrateOptions {
  handoffsDir: string;
  fetchChunks: ChunkFetcher;
  write: boolean;
  force: boolean;
}

export interface RehydrateSummary {
  recoverable: number;
  recovered: number;
  skipped_existing: number;
  lost: number;
  no_rows: number;
  errors: number;
  bytes_restored: number;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function rehydrate(opts: RehydrateOptions): Promise<RehydrateSummary> {
  const files = await scanHandoffDir(opts.handoffsDir);
  const viability = await assessViability(files, opts.fetchChunks);

  const summary: RehydrateSummary = {
    recoverable: 0,
    recovered: 0,
    skipped_existing: 0,
    lost: 0,
    no_rows: 0,
    errors: 0,
    bytes_restored: 0,
  };

  const archiveDir = join(opts.handoffsDir, ARCHIVE_DIRNAME);
  if (opts.write) await mkdir(archiveDir, { recursive: true });

  for (const v of viability) {
    if (v.verdict === "LOST") {
      summary.lost++;
      console.log(
        `[rehydrate] LOST ${v.filename} — index holds only the compacted text ` +
          `(${v.indexed_chars} chars vs ${v.current_text_chars} on disk). Try backup snapshots.`
      );
      continue;
    }
    if (v.verdict === "NO_ROWS") {
      summary.no_rows++;
      console.log(`[rehydrate] NO_ROWS ${v.filename} — never indexed or pruned.`);
      continue;
    }
    if (v.verdict !== "RECOVERABLE") continue;

    summary.recoverable++;
    const sidecar = join(archiveDir, recoveredSidecarName(v.filename));

    try {
      if (!opts.force && (await pathExists(sidecar))) {
        summary.skipped_existing++;
        console.log(`[rehydrate] SKIP ${v.filename} — sidecar already exists (--force to redo).`);
        continue;
      }

      const compacted = JSON.parse(
        await readFile(join(opts.handoffsDir, v.filename), "utf-8")
      ) as Handoff;
      const chunks = await opts.fetchChunks(v.filename);
      const record = buildRecoveryRecord(v.filename, compacted, chunks);
      const body = JSON.stringify(record, null, 2);

      if (opts.write) {
        await writeFile(sidecar, body, "utf-8");
        summary.recovered++;
        summary.bytes_restored += record.recovered_chars;
        console.log(
          `[rehydrate] WROTE ${sidecar} (${record.chunk_count} chunks, ${record.recovered_chars} chars)`
        );
      } else {
        summary.bytes_restored += record.recovered_chars;
        console.log(
          `[rehydrate] would write ${sidecar} (${record.chunk_count} chunks, ${record.recovered_chars} chars)`
        );
      }
    } catch (err) {
      summary.errors++;
      console.error(`[rehydrate] Failed on ${v.filename}: ${(err as Error).message}`);
    }
  }

  return summary;
}

// ── Entrypoint ────────────────────────────────────────────────────

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const force = process.argv.includes("--force");
  const handoffsDir = join(config.dataDir, "handoffs");

  console.log(
    write
      ? "[rehydrate] WRITE mode — recovery sidecars will be created."
      : "[rehydrate] DRY RUN (default) — nothing will be written. Pass --write to emit."
  );

  const summary = await rehydrate({
    handoffsDir,
    fetchChunks: fetchChunksFromPostgres,
    write,
    force,
  });

  console.log("");
  console.log("[rehydrate] Summary:");
  console.log(`  Recoverable:       ${summary.recoverable}`);
  console.log(
    write
      ? `  Recovered:         ${summary.recovered}`
      : `  Would recover:     ${summary.recoverable - summary.skipped_existing}`
  );
  console.log(`  Skipped (exists):  ${summary.skipped_existing}`);
  console.log(`  Lost:              ${summary.lost}`);
  console.log(`  No rows:           ${summary.no_rows}`);
  console.log(`  Errors:            ${summary.errors}`);
  console.log(`  Chars restored:    ${summary.bytes_restored}`);

  if (!write) {
    console.log("\n[rehydrate] Dry run only. Re-run with --write to create the sidecars.");
  }
  console.log(
    "\n[rehydrate] Recovery is text-only: the original active_context key structure\n" +
      "  cannot be reconstructed from flattened chunks. Reindex only after this completes."
  );
}

// Only run when invoked directly — importing this module must never write files.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[rehydrate] Fatal:", err);
    process.exit(1);
  });
}
