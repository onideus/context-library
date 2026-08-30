#!/usr/bin/env tsx
/**
 * audit-compaction — READ-ONLY blast-radius audit of handoff compaction.
 *
 * Answers three questions about a deployment's handoff corpus:
 *
 *   1. How many handoffs have been compacted, and how many are still intact?
 *   2. When did it happen? A wall of compacted files sharing an old date means
 *      the compact-history.ts batch script was run at some point; a thin
 *      trickle across the timeline means only the per-store path ever fired.
 *   3. For each compacted file, is the pre-compaction text still recoverable?
 *
 * (3) works because indexContent() stores the raw chunk text it embedded in
 * embeddings.content_text, keyed `<filename>#chunk_<n>`. For a file compacted
 * after it was indexed, those chunks still hold the ORIGINAL prose. The
 * exception is a reindex/indexAllHandoffs run performed AFTER the compaction:
 * indexHandoffRaw deletes `<filename>#%` and re-inserts from the gutted file,
 * destroying the recovery source. The verdicts distinguish the two cases:
 *
 *   RECOVERABLE  Indexed text is substantially larger than what a re-index of
 *                the current (compacted) file would produce — pre-compaction
 *                prose survives in the index.
 *   LOST         Indexed text matches what the compacted file would produce —
 *                the index was overwritten after compaction. Recovery must
 *                come from backup snapshots instead.
 *   NO_ROWS      No embedding rows at all — never indexed, or pruned.
 *   UNKNOWN      Postgres was unreachable; file-side stats only.
 *
 * This script never writes to the handoffs directory and never issues anything
 * but SELECTs. It does not call reindex, and must not be changed to.
 *
 * Usage:
 *   npx tsx scripts/audit-compaction.ts [--no-report]
 *
 * Environment:
 *   DATA_DIR  Root data dir (default: ./data). Handoffs live in DATA_DIR/handoffs.
 *
 * Output:
 *   Summary table to stdout, plus a full JSON report at
 *   DATA_DIR/audit/compaction-audit-<timestamp>.json (a gitignored path —
 *   audit output describes real content and must never enter the repo).
 */

import { readdir, readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../src/config.js";
import { query } from "../src/db/client.js";
import { COMPACTED_FLAG } from "../src/tools/compaction.js";
import { extractHandoffText } from "../src/embeddings/text.js";
import { ARCHIVE_DIRNAME } from "../src/storage/json-store.js";
import type { Handoff } from "../src/storage/schemas.js";

// ── Types ─────────────────────────────────────────────────────────

export type RecoveryVerdict = "RECOVERABLE" | "LOST" | "NO_ROWS" | "UNKNOWN";

export interface ChunkRow {
  content_id: string;
  content_text: string;
  chunk_index: number | null;
}

export interface FileRecord {
  filename: string;
  bytes: number;
  compacted: boolean;
  stored_at: string | null;
  /** Chars of searchable text the CURRENT on-disk file would yield if indexed. */
  current_text_chars: number;
  /** Whether a byte-exact original sits in handoffs/archive/. */
  archived: boolean;
  parse_error?: string;
}

export interface ViabilityRecord {
  filename: string;
  verdict: RecoveryVerdict;
  chunk_count: number;
  indexed_chars: number;
  current_text_chars: number;
  /** Indexed chars beyond what the compacted file itself would produce. */
  margin_chars: number;
}

export interface AuditReport {
  generated_at: string;
  data_dir: string;
  handoffs_dir: string;
  postgres_available: boolean;
  totals: {
    files: number;
    compacted: number;
    intact: number;
    unreadable: number;
    archived_originals: number;
    bytes_total: number;
    bytes_compacted_files: number;
    bytes_intact_files: number;
  };
  timeline: {
    earliest_compacted_stored_at: string | null;
    latest_compacted_stored_at: string | null;
    earliest_handoff_stored_at: string | null;
    latest_handoff_stored_at: string | null;
  };
  viability_counts: Record<RecoveryVerdict, number>;
  files: FileRecord[];
  viability: ViabilityRecord[];
}

// ── Classification (pure) ─────────────────────────────────────────

/**
 * A compacted file re-indexed today would yield `currentTextChars` of text.
 * Require the index to hold meaningfully MORE than that before calling a file
 * recoverable — both a ratio (catches large files) and an absolute margin
 * (catches small ones, where a 1.5x ratio is only a few dozen chars).
 */
export const RECOVERY_RATIO = 1.5;
export const RECOVERY_MIN_MARGIN_CHARS = 500;

export function classifyRecovery(
  chunkCount: number,
  indexedChars: number,
  currentTextChars: number
): RecoveryVerdict {
  if (chunkCount === 0) return "NO_ROWS";
  const threshold = Math.max(
    currentTextChars * RECOVERY_RATIO,
    currentTextChars + RECOVERY_MIN_MARGIN_CHARS
  );
  return indexedChars >= threshold ? "RECOVERABLE" : "LOST";
}

// ── Filesystem scan ───────────────────────────────────────────────

export async function listArchivedOriginals(handoffsDir: string): Promise<Set<string>> {
  try {
    const entries = await readdir(join(handoffsDir, ARCHIVE_DIRNAME));
    return new Set(entries.filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-")));
  } catch {
    return new Set();
  }
}

/** Read every handoff file and record its compaction state. Read-only. */
export async function scanHandoffDir(handoffsDir: string): Promise<FileRecord[]> {
  const entries = (await readdir(handoffsDir))
    .filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"))
    .sort();

  const archived = await listArchivedOriginals(handoffsDir);
  const records: FileRecord[] = [];

  for (const filename of entries) {
    const path = join(handoffsDir, filename);
    const { size } = await stat(path);
    try {
      const parsed = JSON.parse(await readFile(path, "utf-8")) as Handoff;
      const asRecord = parsed as Record<string, unknown>;
      records.push({
        filename,
        bytes: size,
        compacted: asRecord[COMPACTED_FLAG] === true,
        stored_at: typeof parsed.stored_at === "string" ? parsed.stored_at : null,
        current_text_chars: extractHandoffText(asRecord).length,
        archived: archived.has(filename),
      });
    } catch (err) {
      records.push({
        filename,
        bytes: size,
        compacted: false,
        stored_at: null,
        current_text_chars: 0,
        archived: archived.has(filename),
        parse_error: (err as Error).message,
      });
    }
  }

  return records;
}

// ── Recovery viability ────────────────────────────────────────────

export type ChunkFetcher = (filename: string) => Promise<ChunkRow[]>;

/** Default fetcher: SELECT-only against the embeddings table. */
export const fetchChunksFromPostgres: ChunkFetcher = async (filename) => {
  const res = await query<{
    content_id: string;
    content_text: string | null;
    chunk_index: string | null;
  }>(
    `SELECT content_id,
            content_text,
            metadata->>'chunk_index' AS chunk_index
       FROM embeddings
      WHERE content_type = 'handoff'
        AND (content_id = $1 OR content_id LIKE $2)`,
    [filename, `${filename}#%`]
  );
  return res.rows.map((r) => ({
    content_id: r.content_id,
    content_text: r.content_text ?? "",
    chunk_index: r.chunk_index === null ? null : Number(r.chunk_index),
  }));
};

/** Classify every compacted file. Injectable fetcher keeps this testable. */
export async function assessViability(
  files: FileRecord[],
  fetchChunks: ChunkFetcher
): Promise<ViabilityRecord[]> {
  const out: ViabilityRecord[] = [];
  for (const f of files.filter((f) => f.compacted)) {
    const chunks = await fetchChunks(f.filename);
    const indexedChars = chunks.reduce((n, c) => n + c.content_text.length, 0);
    out.push({
      filename: f.filename,
      verdict: classifyRecovery(chunks.length, indexedChars, f.current_text_chars),
      chunk_count: chunks.length,
      indexed_chars: indexedChars,
      current_text_chars: f.current_text_chars,
      margin_chars: indexedChars - f.current_text_chars,
    });
  }
  return out;
}

// ── Report assembly (pure) ────────────────────────────────────────

function minMax(values: string[]): [string | null, string | null] {
  const sorted = values.filter(Boolean).sort();
  return sorted.length ? [sorted[0], sorted[sorted.length - 1]] : [null, null];
}

export function buildReport(
  files: FileRecord[],
  viability: ViabilityRecord[],
  opts: { dataDir: string; handoffsDir: string; postgresAvailable: boolean }
): AuditReport {
  const compacted = files.filter((f) => f.compacted);
  const unreadable = files.filter((f) => f.parse_error);
  const intact = files.filter((f) => !f.compacted && !f.parse_error);

  const [earliestCompacted, latestCompacted] = minMax(
    compacted.map((f) => f.stored_at ?? "")
  );
  const [earliestAll, latestAll] = minMax(files.map((f) => f.stored_at ?? ""));

  const counts: Record<RecoveryVerdict, number> = {
    RECOVERABLE: 0,
    LOST: 0,
    NO_ROWS: 0,
    UNKNOWN: 0,
  };
  for (const v of viability) counts[v.verdict]++;

  return {
    generated_at: new Date().toISOString(),
    data_dir: opts.dataDir,
    handoffs_dir: opts.handoffsDir,
    postgres_available: opts.postgresAvailable,
    totals: {
      files: files.length,
      compacted: compacted.length,
      intact: intact.length,
      unreadable: unreadable.length,
      archived_originals: files.filter((f) => f.archived).length,
      bytes_total: files.reduce((n, f) => n + f.bytes, 0),
      bytes_compacted_files: compacted.reduce((n, f) => n + f.bytes, 0),
      bytes_intact_files: intact.reduce((n, f) => n + f.bytes, 0),
    },
    timeline: {
      earliest_compacted_stored_at: earliestCompacted,
      latest_compacted_stored_at: latestCompacted,
      earliest_handoff_stored_at: earliestAll,
      latest_handoff_stored_at: latestAll,
    },
    viability_counts: counts,
    files,
    viability,
  };
}

export function formatSummary(report: AuditReport): string {
  const t = report.totals;
  const c = report.viability_counts;
  const pad = (label: string, value: string | number) =>
    `  ${label.padEnd(26)} ${value}`;

  const lines = [
    "",
    "[audit-compaction] Handoff corpus",
    pad("Files:", t.files),
    pad("Compacted:", t.compacted),
    pad("Intact:", t.intact),
    pad("Unreadable:", t.unreadable),
    pad("Archived originals:", t.archived_originals),
    pad("Bytes (total):", t.bytes_total),
    pad("Bytes (compacted files):", t.bytes_compacted_files),
    "",
    "[audit-compaction] Timeline",
    pad("Earliest handoff:", report.timeline.earliest_handoff_stored_at ?? "—"),
    pad("Latest handoff:", report.timeline.latest_handoff_stored_at ?? "—"),
    pad("Earliest compacted:", report.timeline.earliest_compacted_stored_at ?? "—"),
    pad("Latest compacted:", report.timeline.latest_compacted_stored_at ?? "—"),
    "",
    "[audit-compaction] Recovery viability",
  ];

  if (!report.postgres_available) {
    lines.push(
      "  Postgres unreachable — viability UNKNOWN for every compacted file.",
      "  File-side stats above are still accurate."
    );
  } else {
    lines.push(
      pad("RECOVERABLE:", c.RECOVERABLE),
      pad("LOST:", c.LOST),
      pad("NO_ROWS:", c.NO_ROWS),
      pad("UNKNOWN:", c.UNKNOWN)
    );
  }

  return lines.join("\n");
}

// ── Entrypoint ────────────────────────────────────────────────────

async function main(): Promise<void> {
  const writeReport = !process.argv.includes("--no-report");
  const handoffsDir = join(config.dataDir, "handoffs");

  let files: FileRecord[];
  try {
    files = await scanHandoffDir(handoffsDir);
  } catch (err) {
    console.error(
      `[audit-compaction] Could not read ${handoffsDir}: ${(err as Error).message}`
    );
    process.exit(1);
  }

  let postgresAvailable = true;
  let viability: ViabilityRecord[] = [];
  try {
    viability = await assessViability(files, fetchChunksFromPostgres);
  } catch (err) {
    postgresAvailable = false;
    console.warn(
      `[audit-compaction] Postgres unreachable (${(err as Error).message}) — ` +
        "recovery viability reported as UNKNOWN."
    );
    viability = files
      .filter((f) => f.compacted)
      .map((f) => ({
        filename: f.filename,
        verdict: "UNKNOWN" as const,
        chunk_count: 0,
        indexed_chars: 0,
        current_text_chars: f.current_text_chars,
        margin_chars: 0,
      }));
  }

  const report = buildReport(files, viability, {
    dataDir: config.dataDir,
    handoffsDir,
    postgresAvailable,
  });

  console.log(formatSummary(report));

  if (writeReport) {
    const auditDir = join(config.dataDir, "audit");
    await mkdir(auditDir, { recursive: true });
    const stamp = report.generated_at.replace(/[:.]/g, "-");
    const outPath = join(auditDir, `compaction-audit-${stamp}.json`);
    await writeFile(outPath, JSON.stringify(report, null, 2), "utf-8");
    console.log(`\n[audit-compaction] Full report: ${outPath}`);
  }

  if (report.viability_counts.RECOVERABLE > 0) {
    console.log(
      `\n[audit-compaction] ${report.viability_counts.RECOVERABLE} file(s) look recoverable — ` +
        "next step is `npx tsx scripts/rehydrate-handoffs.ts` (dry-run by default)."
    );
  }
  console.log(
    "\n[audit-compaction] Do NOT run reindex / indexAllHandoffs until recovery is complete —\n" +
      "  re-indexing reads the compacted file and overwrites the surviving chunks."
  );
}

// Only run when invoked directly, so tests can import the pure helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[audit-compaction] Fatal:", err);
    process.exit(1);
  });
}
