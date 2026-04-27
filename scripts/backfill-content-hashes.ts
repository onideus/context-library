#!/usr/bin/env tsx
/**
 * backfill-content-hashes — one-shot script that adds content_hash to the
 * metadata of all artifacts with status 'ready', 'executing', or 'completed'
 * that are missing it.
 *
 * Safe to re-run: already-hashed artifacts are skipped without modification.
 *
 * Pointer-only artifacts (null/empty content) receive the sha256 of the empty
 * string — this is a known gap documented in the spec.
 *
 * Usage:
 *   npx tsx scripts/backfill-content-hashes.ts
 */

import { createHash } from "node:crypto";
import { pool, query } from "../src/db/client.js";

function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

interface ArtifactRow {
  id: string;
  content: string | null;
  metadata: Record<string, unknown>;
}

async function backfill(): Promise<void> {
  console.log("Scanning artifacts with status in ('ready', 'executing', 'completed')...");

  const result = await query<ArtifactRow>(
    "SELECT id, content, metadata FROM artifacts WHERE status IN ('ready', 'executing', 'completed')"
  );

  console.log(`Found ${result.rows.length} locked artifact(s).`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of result.rows) {
    const metadata = row.metadata ?? {};
    if (Object.prototype.hasOwnProperty.call(metadata, "content_hash")) {
      skipped++;
      continue;
    }

    const hash = computeContentHash(row.content ?? "");
    try {
      await query(
        "UPDATE artifacts SET metadata = metadata || $1::jsonb WHERE id = $2",
        [JSON.stringify({ content_hash: hash }), row.id]
      );
      updated++;
      console.log(`  [updated] ${row.id}  hash=${hash}`);
    } catch (err) {
      errors++;
      console.error(`  [error]   ${row.id}  ${(err as Error).message}`);
    }
  }

  console.log(
    `\nBackfill complete: ${updated} updated, ${skipped} skipped (already had hash), ${errors} errors`
  );

  // Per spec: "Logs gaps but does not fail" — errors are counted and logged
  // above but do not produce a failing exit code so CI/operator workflows can
  // distinguish between a complete failure and a partial backfill.
}

backfill()
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
