#!/usr/bin/env tsx
/**
 * compact-history — one-shot backfill that compacts every stored handoff
 * except the most recent one. Safe to re-run; the compaction function is
 * idempotent.
 *
 * Skips handoffs whose embedding is still queued in pending_embeddings —
 * compacting those before they're indexed would make their content
 * unsearchable. They'll be compacted naturally on the next store_handoff
 * after the queue drains.
 *
 * Honours COMPACTION_MODE:
 *   off       Refuses to run. The deployment has opted out of rewriting
 *             handoffs; a batch pass would contradict that.
 *   archive   (default) Copies each original byte-exact to
 *             DATA_DIR/handoffs/archive/ before rewriting it.
 *   in-place  Legacy. Rewrites with no copy — LOSSY for active_context.
 *
 * Usage:
 *   npm run compact-history
 *
 * Environment:
 *   DATA_DIR         Root data dir (default: ./data). Handoffs live in DATA_DIR/handoffs.
 *   COMPACTION_MODE  archive | in-place | off (default: archive).
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../src/config.js";
import { writeHandoffInPlace, archiveHandoff, ARCHIVE_DIRNAME } from "../src/storage/json-store.js";
import { compactHandoff, COMPACTED_FLAG } from "../src/tools/compaction.js";
import { hasPendingEmbedding } from "../src/embeddings/indexer.js";
import type { Handoff } from "../src/storage/schemas.js";

interface Summary {
  scanned: number;
  compacted: number;
  already_compacted: number;
  skipped_pending: number;
  archived: number;
  archive_already_present: number;
  errors: number;
  bytes_before: number;
  bytes_after: number;
}

async function main(): Promise<void> {
  const mode = config.compactionMode;

  if (mode === "off") {
    console.log(
      "[compact-history] COMPACTION_MODE=off — refusing to run.\n" +
        "  This deployment has opted out of rewriting stored handoffs; a batch\n" +
        "  compaction pass would contradict that setting. Set COMPACTION_MODE to\n" +
        "  archive (lossless — keeps a byte-exact original) or in-place (lossy)\n" +
        "  if you actually want to compact history."
    );
    return;
  }

  console.log(`[compact-history] mode=${mode}`);
  if (mode === "in-place") {
    console.log(
      "[compact-history] WARNING: in-place mode is LOSSY — each file's active_context\n" +
        "  is collapsed to a one-line summary with no copy of the original kept on disk."
    );
  }

  const handoffsDir = join(config.dataDir, "handoffs");
  let files: string[];
  try {
    files = (await readdir(handoffsDir))
      .filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"))
      .sort();
  } catch (err) {
    console.error(`[compact-history] Could not read ${handoffsDir}: ${(err as Error).message}`);
    process.exit(1);
  }

  if (files.length <= 1) {
    console.log(`[compact-history] Nothing to do — ${files.length} handoff(s) found.`);
    return;
  }

  // Latest handoff stays full-fidelity.
  const targets = files.slice(0, -1);
  const latest = files[files.length - 1];
  console.log(
    `[compact-history] Scanning ${targets.length} handoff(s); preserving latest: ${latest}`
  );

  const summary: Summary = {
    scanned: 0,
    compacted: 0,
    already_compacted: 0,
    skipped_pending: 0,
    archived: 0,
    archive_already_present: 0,
    errors: 0,
    bytes_before: 0,
    bytes_after: 0,
  };

  for (const filename of targets) {
    summary.scanned++;
    const path = join(handoffsDir, filename);
    try {
      const raw = await readFile(path, "utf-8");
      const handoff = JSON.parse(raw) as Handoff;

      if ((handoff as Record<string, unknown>)[COMPACTED_FLAG] === true) {
        summary.already_compacted++;
        continue;
      }

      const pending = await hasPendingEmbedding("handoff", filename);
      if (pending) {
        summary.skipped_pending++;
        console.log(`[compact-history] Skipped ${filename}: embedding pending`);
        continue;
      }

      const { compacted, original_size, compacted_size, archived_keys } = compactHandoff(handoff);
      if (original_size === compacted_size) {
        summary.already_compacted++;
        continue;
      }

      // Archive first. A throw here is caught below and counted as an error
      // for this file — the rewrite is skipped, which is the correct outcome:
      // in archive mode the original must outlive the rewrite.
      let archiveNote = "";
      if (mode === "archive") {
        const outcome = await archiveHandoff(filename);
        if (outcome === "archived") {
          summary.archived++;
          archiveNote = `, original saved to ${ARCHIVE_DIRNAME}/`;
        } else {
          summary.archive_already_present++;
          archiveNote = `, ${ARCHIVE_DIRNAME}/ copy already present (kept)`;
        }
      }

      await writeHandoffInPlace(filename, compacted);
      summary.compacted++;
      summary.bytes_before += original_size;
      summary.bytes_after += compacted_size;

      const reduction = Math.round((1 - compacted_size / original_size) * 100);
      console.log(
        `[compact-history] ${filename}: ${original_size} → ${compacted_size} bytes ` +
          `(${reduction}%, archived: ${archived_keys.join(", ") || "none"}${archiveNote})`
      );
    } catch (err) {
      summary.errors++;
      console.error(
        `[compact-history] Failed on ${filename}: ${(err as Error).message}`
      );
    }
  }

  const totalReduction =
    summary.bytes_before > 0
      ? Math.round((1 - summary.bytes_after / summary.bytes_before) * 100)
      : 0;

  console.log("");
  console.log("[compact-history] Summary:");
  console.log(`  Mode:              ${mode}`);
  console.log(`  Scanned:           ${summary.scanned}`);
  console.log(`  Compacted:         ${summary.compacted}`);
  console.log(`  Already compacted: ${summary.already_compacted}`);
  console.log(`  Skipped (pending): ${summary.skipped_pending}`);
  if (mode === "archive") {
    console.log(`  Originals archived: ${summary.archived}`);
    console.log(`  Archive pre-existing: ${summary.archive_already_present}`);
  }
  console.log(`  Errors:            ${summary.errors}`);
  if (summary.compacted > 0) {
    console.log(
      `  Bytes:             ${summary.bytes_before} → ${summary.bytes_after} (${totalReduction}% reduction)`
    );
  }
}

main().catch((err) => {
  console.error("[compact-history] Fatal:", err);
  process.exit(1);
});
