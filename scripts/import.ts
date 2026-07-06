#!/usr/bin/env tsx
/**
 * import — restore a Context Library instance from an export tarball.
 *
 * Intended flow:
 *   1. Set up a fresh deployment (Postgres up, schema empty or new)
 *   2. Point env vars at it (PG*, DATA_DIR)
 *   3. `npm run import path/to/context-library-<ver>-<stamp>.tar.gz`
 *
 * The import verifies the destination database's migration state is at or
 * beyond the manifest, refuses to overwrite non-empty databases unless
 * `--force` is passed, loads each table in a per-table transaction, copies
 * handoff files into `DATA_DIR/handoffs`, and enqueues re-embedding through
 * `pending_embeddings` whenever embeddings are absent from the tarball OR
 * the manifest's model/dimensions disagree with the current config.
 *
 * `--dry-run` prints what would happen — planned actions, per-table row
 * counts, and re-embed plan — without touching Postgres or the filesystem
 * (beyond the extraction tempdir, which is cleaned up unconditionally).
 *
 * `--force` allows importing into a non-empty database. `--force` truncates
 * every export-managed table first (in FK-safe order) and clears
 * DATA_DIR/handoffs before restoring. This is a destructive operation on
 * the destination — the operator is expected to have taken their own
 * snapshot first if they need one.
 *
 * The restore rebuilds `changes` and `sync_op_log` with fresh BIGSERIAL
 * values, which invalidates every paired sync client's cursor. See
 * docs/backup-restore.md — the client-side action is to re-pair or perform
 * a full resync. The server does not attempt to hide this from clients.
 *
 * Usage:
 *   npm run import path/to/backup.tar.gz
 *   npm run import path/to/backup.tar.gz -- --dry-run
 *   npm run import path/to/backup.tar.gz -- --force
 */

import { mkdtemp, cp, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { config } from "../src/config.js";
import { pool, query, getClient } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { TABLES, type TableSpec } from "./portability/tables.js";
import {
  ensureDir,
  extractTarball,
  readJsonFile,
  readJsonlFile,
  countJsonlRows,
} from "./portability/io.js";
import type { ExportManifest } from "./portability/manifest.js";

// ── Args ──────────────────────────────────────────────────────────

interface Args {
  tarball: string;
  dryRun: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  let tarball: string | undefined;
  let dryRun = false;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--force") force = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg.startsWith("--")) {
      console.error(`Unknown flag: ${arg}`);
      console.error(usage());
      process.exit(2);
    } else if (!tarball) {
      tarball = resolve(process.cwd(), arg);
    } else {
      console.error(`Unexpected extra argument: ${arg}`);
      console.error(usage());
      process.exit(2);
    }
  }

  if (!tarball) {
    console.error("Error: tarball path is required");
    console.error(usage());
    process.exit(2);
  }
  return { tarball, dryRun, force };
}

function usage(): string {
  return `Usage: npm run import <tarball> [--dry-run] [--force]

Arguments:
  <tarball>    Path to the .tar.gz produced by \`npm run export\`

Options:
  --dry-run    Print what would happen without modifying the database or filesystem
  --force      Import into a non-empty database (truncates existing content
               in tasks/notes/artifacts/entities/... and clears DATA_DIR/handoffs)
  --help, -h   Show this help
`;
}

// ── Preflight ─────────────────────────────────────────────────────

async function readAppliedMigrations(): Promise<Set<string>> {
  try {
    const res = await query<{ filename: string }>(
      "SELECT filename FROM _migrations"
    );
    return new Set(res.rows.map((r) => r.filename));
  } catch {
    return new Set();
  }
}

async function verifyMigrations(
  manifest: ExportManifest,
  dryRun: boolean
): Promise<{ missing: string[] }> {
  // Ensure the destination database has run at LEAST every migration named
  // in the manifest. If the destination is behind, try running the local
  // migration set — the runner is idempotent. In dry-run mode we report the
  // gap but do not touch the database.
  const applied = await readAppliedMigrations();
  const missing = manifest.applied_migrations.filter((m) => !applied.has(m));
  if (missing.length === 0) return { missing: [] };

  if (dryRun) {
    console.log(
      `[import] (dry-run) Destination is missing ${missing.length} migration(s); ` +
        "would run runMigrations() before load"
    );
    return { missing };
  }

  console.log(
    `[import] Destination is missing ${missing.length} migration(s) — running migrations…`
  );
  await runMigrations();

  const applied2 = await readAppliedMigrations();
  const stillMissing = manifest.applied_migrations.filter(
    (m) => !applied2.has(m)
  );
  if (stillMissing.length > 0) {
    throw new Error(
      "Destination is still missing migrations after running the runner: " +
        stillMissing.join(", ") +
        ". Update the codebase to a version whose src/db/migrations/ includes them, then retry."
    );
  }
  return { missing: [] };
}

async function checkDatabaseEmpty(): Promise<{
  empty: boolean;
  counts: Record<string, number>;
}> {
  const counts: Record<string, number> = {};
  for (const spec of TABLES) {
    try {
      const res = await query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${spec.name}`
      );
      counts[spec.name] = Number(res.rows[0]?.count ?? 0);
    } catch {
      counts[spec.name] = 0;
    }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { empty: total === 0, counts };
}

async function countHandoffFiles(): Promise<number> {
  try {
    const dir = join(config.dataDir, "handoffs");
    const entries = await readdir(dir);
    return entries.filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-")).length;
  } catch {
    return 0;
  }
}

// ── Wipe (only used with --force) ─────────────────────────────────

async function truncateAllTables(): Promise<void> {
  // Reverse order = FK-safe. Every table is truncated with CASCADE and
  // RESTART IDENTITY so BIGSERIAL / SERIAL sequences reset — otherwise a
  // stale `changes.seq` peak would leave a gap in the fresh cursor space
  // and confuse any sync client that had already pulled beyond it.
  for (const spec of [...TABLES].reverse()) {
    try {
      await query(`TRUNCATE TABLE ${spec.name} RESTART IDENTITY CASCADE`);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (/does not exist/i.test(msg)) continue;
      throw err;
    }
  }
}

async function clearHandoffDir(): Promise<void> {
  const dir = join(config.dataDir, "handoffs");
  try {
    const entries = await readdir(dir);
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      await rm(join(dir, name), { force: true, recursive: true });
    }
  } catch {
    // Directory does not exist yet — nothing to clear.
  }
}

// ── Table load ────────────────────────────────────────────────────

async function loadTable(
  spec: TableSpec,
  tablesDir: string,
  expectedCount: number
): Promise<number> {
  const jsonlPath = join(tablesDir, `${spec.name}.jsonl`);

  // File may not exist (older export missing a newer table). Treat as zero.
  try {
    await stat(jsonlPath);
  } catch {
    if (expectedCount > 0) {
      throw new Error(
        `Manifest reports ${expectedCount} rows for ${spec.name} but ${spec.name}.jsonl is missing`
      );
    }
    return 0;
  }

  const client = await getClient();
  let inserted = 0;
  try {
    await client.query("BEGIN");

    for await (const row of readJsonlFile(jsonlPath)) {
      const values: unknown[] = [];
      const placeholders: string[] = [];
      for (let i = 0; i < spec.columns.length; i++) {
        const col = spec.columns[i];
        const raw = row[col] ?? null;
        // JSONB casts require the value to be a JSON *string*.
        const cast = spec.casts?.[col];
        if (cast === "jsonb") {
          values.push(raw === null ? null : JSON.stringify(raw));
          placeholders.push(`$${i + 1}::jsonb`);
        } else if (cast) {
          values.push(raw);
          placeholders.push(`$${i + 1}::${cast}`);
        } else {
          values.push(raw);
          placeholders.push(`$${i + 1}`);
        }
      }
      const sql =
        `INSERT INTO ${spec.name} (${spec.columns.join(", ")}) ` +
        `VALUES (${placeholders.join(", ")})`;
      await client.query(sql, values);
      inserted++;
    }

    if (inserted !== expectedCount) {
      throw new Error(
        `Row count mismatch for ${spec.name}: manifest=${expectedCount}, loaded=${inserted}`
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return inserted;
}

// ── Handoff copy ──────────────────────────────────────────────────

async function copyHandoffs(handoffsSrc: string): Promise<number> {
  const destDir = join(config.dataDir, "handoffs");
  await ensureDir(destDir);

  let files: string[];
  try {
    files = (await readdir(handoffsSrc))
      .filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"))
      .sort();
  } catch {
    return 0;
  }

  for (const filename of files) {
    await cp(join(handoffsSrc, filename), join(destDir, filename));
  }
  return files.length;
}

// ── Re-embed plan ─────────────────────────────────────────────────

interface ReembedPlan {
  reason: string;
  handoffs: number;
  tasks: number;
  notes: number;
  artifacts: number;
}

function classifyReembed(
  manifest: ExportManifest,
  rowCounts: Record<string, number>,
  handoffCount: number
): ReembedPlan {
  const modelMismatch =
    manifest.embedding_model !== config.embeddingModel ||
    manifest.embedding_dimensions !== config.embeddingDimensions;

  const reason = !manifest.includes_embeddings
    ? "manifest excluded embeddings"
    : modelMismatch
      ? `model changed (was ${manifest.embedding_model} @ ${manifest.embedding_dimensions}, ` +
        `now ${config.embeddingModel} @ ${config.embeddingDimensions})`
      : "embeddings present and model unchanged — no re-embed queued";

  const shouldReembed = !manifest.includes_embeddings || modelMismatch;
  return {
    reason,
    handoffs: shouldReembed ? handoffCount : 0,
    tasks: shouldReembed ? rowCounts.tasks ?? 0 : 0,
    notes: shouldReembed ? rowCounts.notes ?? 0 : 0,
    artifacts: shouldReembed ? rowCounts.artifacts ?? 0 : 0,
  };
}

async function queueReembed(plan: ReembedPlan): Promise<void> {
  // Queue every present entity id / handoff filename into pending_embeddings.
  // The regular drain path (drainPendingEmbeddings) picks these up on the
  // next successful search_context / reindex once TEI is reachable.
  if (plan.handoffs > 0) {
    const handoffsDir = join(config.dataDir, "handoffs");
    const files = (await readdir(handoffsDir))
      .filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"));
    for (const filename of files) {
      await query(
        `INSERT INTO pending_embeddings (content_type, content_id)
         VALUES ('handoff', $1)
         ON CONFLICT (content_type, content_id) DO NOTHING`,
        [filename]
      );
    }
  }

  const rowTypes: Array<{ type: string; table: string }> = [
    { type: "task", table: "tasks" },
    { type: "note", table: "notes" },
    { type: "artifact", table: "artifacts" },
  ];
  for (const { type, table } of rowTypes) {
    // Guard: skip if the corresponding plan field is zero.
    if ((plan as Record<string, unknown>)[table] === 0) continue;
    await query(
      `INSERT INTO pending_embeddings (content_type, content_id)
       SELECT $1, id::text FROM ${table}
       ON CONFLICT (content_type, content_id) DO NOTHING`,
      [type]
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[import] Tarball:  ${args.tarball}`);
  console.log(`[import] Data dir: ${config.dataDir}`);
  if (args.dryRun) console.log("[import] DRY RUN — no changes will be made");
  if (args.force) console.log("[import] --force: existing content will be wiped");

  // Extract into a temp dir. Cleaned up unconditionally.
  const staging = await mkdtemp(join(tmpdir(), "cl-import-"));
  try {
    await extractTarball(args.tarball, staging);

    const manifest = await readJsonFile<ExportManifest>(
      join(staging, "manifest.json")
    );
    console.log(
      `[import] Manifest: app=${manifest.app_version}, exported_at=${manifest.exported_at}`
    );
    console.log(
      `[import] Manifest embedding: ${manifest.embedding_model} @ ${manifest.embedding_dimensions} ` +
        `(includes_embeddings=${manifest.includes_embeddings})`
    );

    // Verify JSONL row counts up front so a mismatch fails fast without
    // starting a transactional load.
    const tablesDir = join(staging, "tables");
    for (const spec of TABLES) {
      const expected = manifest.row_counts[spec.name] ?? 0;
      const jsonlPath = join(tablesDir, `${spec.name}.jsonl`);
      let observed = 0;
      try {
        observed = await countJsonlRows(jsonlPath);
      } catch {
        observed = 0;
      }
      if (observed !== expected) {
        throw new Error(
          `Tarball corrupt: ${spec.name}.jsonl has ${observed} row(s) but manifest declares ${expected}`
        );
      }
    }

    // Ensure schema is present before we touch it. In dry-run this just
    // reports the migration gap and returns without applying.
    await verifyMigrations(manifest, args.dryRun);

    const { empty, counts } = await checkDatabaseEmpty();
    const existingHandoffs = await countHandoffFiles();

    if (!empty || existingHandoffs > 0) {
      if (!args.force) {
        console.error("[import] Destination is not empty:");
        for (const [table, n] of Object.entries(counts)) {
          if (n > 0) console.error(`  ${table}: ${n} row(s)`);
        }
        if (existingHandoffs > 0) {
          console.error(`  handoffs on disk: ${existingHandoffs} file(s)`);
        }
        console.error(
          "\nRefusing to import into a non-empty destination. " +
            "Re-run with --force to truncate every export-managed table and " +
            "clear DATA_DIR/handoffs before restoring."
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        `[import] --force: pre-wipe found ${Object.values(counts).reduce((a, b) => a + b, 0)} row(s) ` +
          `across managed tables and ${existingHandoffs} handoff file(s)`
      );
    }

    // Compute the re-embed plan up front so it appears in the dry-run output.
    const plan = classifyReembed(manifest, manifest.row_counts, manifest.handoff_file_count);

    if (args.dryRun) {
      console.log("\n[import] DRY RUN plan:");
      for (const spec of TABLES) {
        const expected = manifest.row_counts[spec.name] ?? 0;
        const current = counts[spec.name] ?? 0;
        if (expected > 0 || current > 0) {
          console.log(`  ${spec.name}: ${current} → ${expected}`);
        }
      }
      console.log(`  handoffs: ${existingHandoffs} → ${manifest.handoff_file_count}`);
      console.log(`\n[import] Re-embed plan: ${plan.reason}`);
      if (plan.handoffs || plan.tasks || plan.notes || plan.artifacts) {
        console.log(
          `  pending_embeddings will queue: ` +
            `${plan.handoffs} handoff(s), ${plan.tasks} task(s), ` +
            `${plan.notes} note(s), ${plan.artifacts} artifact(s)`
        );
      }
      return;
    }

    if (!empty || existingHandoffs > 0) {
      await truncateAllTables();
      await clearHandoffDir();
      console.log("[import] Pre-wipe complete");
    }

    // Load each table in a per-table transaction.
    for (const spec of TABLES) {
      const expected = manifest.row_counts[spec.name] ?? 0;
      const loaded = await loadTable(spec, tablesDir, expected);
      console.log(`[import] tables/${spec.name}: ${loaded} row(s)`);
    }

    // Copy handoff files.
    const handoffsLoaded = await copyHandoffs(join(staging, "handoffs"));
    console.log(`[import] handoffs/: ${handoffsLoaded} file(s)`);

    // Enqueue re-embed if needed.
    if (plan.handoffs || plan.tasks || plan.notes || plan.artifacts) {
      await queueReembed(plan);
      console.log(
        `[import] Queued for re-embed (${plan.reason}): ` +
          `${plan.handoffs} handoff(s), ${plan.tasks} task(s), ` +
          `${plan.notes} note(s), ${plan.artifacts} artifact(s)`
      );
    } else {
      console.log(`[import] Re-embed: ${plan.reason}`);
    }

    console.log("[import] Restore complete.");
    console.log(
      "[import] Reminder: sync clients paired to this deployment must re-pair " +
        "or perform a full resync — the changes cursor has been rebuilt."
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

main()
  .catch((err) => {
    console.error("[import] Fatal:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
