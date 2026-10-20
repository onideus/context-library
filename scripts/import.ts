#!/usr/bin/env tsx
/**
 * import — restore a Context Library instance from an export tarball.
 *
 * Intended flow:
 *   1. Set up a fresh deployment (Postgres up, schema empty or new)
 *   2. Point env vars at it (PG*, DATA_DIR)
 *   3. `npm run import path/to/context-library-<ver>-<stamp>.tar.gz`
 *
 * Order of operations (each step happens only if every earlier one passed):
 *   1. Check the tarball itself: every JSONL row count must match the
 *      manifest; every note_versions row must belong to a note in notes.jsonl
 *      with a version strictly below the note's current one (otherwise a
 *      restored note could never be edited again); every notes.superseded_by
 *      must name a note in notes.jsonl. All fatal, all before any database
 *      access.
 *   2. Check the destination is empty; refuse unless `--force` is passed. A
 *      refused import leaves the destination exactly as it was — its schema
 *      included.
 *   3. Verify the destination's migration state is at or beyond the manifest,
 *      and apply any migration this checkout ships that the destination lacks.
 *   4. With `--force`, truncate; then load each table in a per-table
 *      transaction, copy handoff files into `DATA_DIR/handoffs`, and enqueue
 *      re-embedding through `pending_embeddings` whenever embeddings are
 *      absent from the tarball OR the manifest's model/dimensions disagree
 *      with the current config.
 *
 * Tarballs written before a column or table existed still restore: an absent
 * column loads as its column DEFAULT and a missing JSONL file loads as zero
 * rows.
 *
 * `--dry-run` prints what would happen — planned actions, pending migrations,
 * per-table row counts, and re-embed plan — without modifying Postgres or the
 * filesystem (beyond the extraction tempdir, which is cleaned up
 * unconditionally).
 *
 * `--force` allows importing into a non-empty database. `--force` truncates
 * every export-managed table first (TRUNCATE ... CASCADE) and clears
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
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "../src/config.js";
import { ARCHIVE_DIRNAME } from "../src/storage/json-store.js";
import { pool, query, getClient } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { TABLES, type TableSpec } from "./portability/tables.js";
import { buildInsert, checkNotesConsistency } from "./portability/rows.js";
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

/**
 * Fail fast, before any database access, when the tarball's notes cannot be
 * restored consistently (see checkNotesConsistency): a note_versions row whose
 * note is missing from notes.jsonl or whose version is not strictly below the
 * note's current version (the restored note would be permanently uneditable),
 * or a notes.superseded_by naming a note that is not in the file (the FK would
 * fail at COMMIT, after a --force truncate). Same class of error as "Tarball
 * corrupt".
 *
 * An absent file is an empty set, not a reason to skip: history rows with no
 * notes.jsonl are history for notes that do not exist. Only a tarball with
 * neither file is skipped; one written before migration 013 has no
 * note_versions.jsonl, which simply means no history to check.
 */
async function verifyNoteHistory(tablesDir: string): Promise<void> {
  const rowsIfPresent = async (name: string) => {
    const path = join(tablesDir, name);
    try {
      await stat(path);
    } catch {
      return null;
    }
    return readJsonlFile(path);
  };
  const notes = await rowsIfPresent("notes.jsonl");
  const history = await rowsIfPresent("note_versions.jsonl");
  if (notes === null && history === null) return;
  await checkNotesConsistency(notes ?? [], history ?? []);
}

/**
 * Postgres SQLSTATE 42P01 = undefined_table. Only this code should be
 * interpreted as "table not present yet" during preflight. Every other
 * error (permission denied, connection lost, syntax) must propagate — a
 * catch-all here would misclassify a real problem as "empty" and let a
 * `--force` wipe proceed against a database the import can't safely touch.
 */
const PG_UNDEFINED_TABLE = "42P01";

function isUndefinedTableError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNDEFINED_TABLE
  );
}

async function readAppliedMigrations(): Promise<Set<string>> {
  try {
    const res = await query<{ filename: string }>(
      "SELECT filename FROM _migrations"
    );
    return new Set(res.rows.map((r) => r.filename));
  } catch (err) {
    if (isUndefinedTableError(err)) return new Set();
    throw err;
  }
}

/**
 * The migration files this checkout ships, sorted — the same set
 * `runMigrations()` applies. Resolved the way migrate.ts resolves them: the
 * source tree first, then the compiled `dist/` copy.
 */
async function listLocalMigrations(): Promise<string[]> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "src", "db", "migrations"),
    join(here, "..", "dist", "db", "migrations"),
  ];
  for (const dir of candidates) {
    try {
      return (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    } catch {
      // Try the next location.
    }
  }
  return [];
}

async function verifyMigrations(
  manifest: ExportManifest,
  dryRun: boolean
): Promise<{ missing: string[] }> {
  // Called only once the import is known to proceed (the destination is empty,
  // or --force / --dry-run was given) — never for a refused import, which must
  // not touch the destination, its schema included. Two separate questions,
  // both settled BEFORE the --force truncate and any load:
  //
  //  1. Is the destination at LEAST at every migration the manifest names?
  //     If not, run the local migration set (idempotent). If the manifest
  //     names a migration this checkout does not ship, refuse below — the
  //     tarball is from newer code.
  //  2. Does this checkout ship any migration the destination has not applied,
  //     whatever the manifest names? The server runs migrations at startup, but
  //     a restore can run on a freshly upgraded checkout before the server has
  //     ever started. An older tarball then names nothing the destination is
  //     missing, yet the load INSERTs the current registry's columns (and
  //     --force has already truncated by the time a missing column fails) —
  //     a data-loss path. So pending local migrations are applied first.
  //
  // In dry-run mode we report what would run but do not touch the database.
  const applied = await readAppliedMigrations();
  const missing = manifest.applied_migrations.filter((m) => !applied.has(m));
  const pending = (await listLocalMigrations()).filter((f) => !applied.has(f));
  if (missing.length === 0 && pending.length === 0) return { missing: [] };

  if (dryRun) {
    console.log(
      `[import] (dry-run) Destination has ${pending.length} pending migration(s)` +
        (pending.length > 0 ? ` (${pending.join(", ")})` : "") +
        (missing.length > 0 ? `, ${missing.length} named by the manifest` : "") +
        "; would run runMigrations() before load"
    );
    return { missing };
  }

  console.log(
    `[import] Destination has ${pending.length} pending migration(s)` +
      (pending.length > 0 ? ` (${pending.join(", ")})` : "") +
      (missing.length > 0 ? `, ${missing.length} named by the manifest` : "") +
      " — running migrations…"
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
    } catch (err) {
      if (isUndefinedTableError(err)) {
        counts[spec.name] = 0;
        continue;
      }
      throw err;
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
  // TRUNCATE ... CASCADE handles cross-table FK dependencies, so iteration
  // order is not load-bearing. Every table is truncated with RESTART
  // IDENTITY so BIGSERIAL / SERIAL sequences reset — otherwise a stale
  // `changes.seq` peak would leave a gap in the fresh cursor space and
  // confuse any sync client that had already pulled beyond it.
  for (const spec of TABLES) {
    try {
      await query(`TRUNCATE TABLE ${spec.name} RESTART IDENTITY CASCADE`);
    } catch (err) {
      if (isUndefinedTableError(err)) continue;
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
      // Never wipe the compaction archive: it holds the only full copy of every
      // compacted handoff, and it is append-only by design. Clearing it would
      // make `--force` with a tarball that lacks an archive (any export written
      // before archives were exported) destroy those originals outright.
      // restoreHandoffArchive merges the tarball's archive in instead.
      if (name === ARCHIVE_DIRNAME) continue;
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
    // Defer DEFERRABLE constraints to COMMIT. notes.superseded_by is a
    // self-referencing FK (DEFERRABLE INITIALLY IMMEDIATE) and rows load in id
    // order, so a superseded note can precede its successor in the file. Deferred,
    // the FK is checked once at this table's COMMIT instead of per row. Constraints
    // that are not deferrable are unaffected.
    await client.query("SET CONSTRAINTS ALL DEFERRED");

    for await (const row of readJsonlFile(jsonlPath)) {
      // Columns absent from the row (older tarball) become DEFAULT; see rows.ts.
      const { sql, values } = buildInsert(spec, row);
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

/**
 * Merges the tarball's `handoffs/archive/` into the destination without
 * overwriting anything already there. Archived originals are byte-exact and
 * immutable, so an existing file is by definition the same original (or a
 * newer rehydration sidecar the operator produced); keeping it is always safe.
 */
async function restoreHandoffArchive(handoffsSrc: string): Promise<number> {
  const src = join(handoffsSrc, ARCHIVE_DIRNAME);
  let entries;
  try {
    entries = await readdir(src, { recursive: true, withFileTypes: true });
  } catch {
    return 0; // Tarball has no archive (pre-archive export, or nothing compacted).
  }
  await cp(src, join(config.dataDir, "handoffs", ARCHIVE_DIRNAME), {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
  return entries.filter((e) => e.isFile()).length;
}


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
    if (files.length > 0) {
      // Batch into a single multi-value INSERT — 216+ handoff datasets
      // would otherwise take 216+ round-trips.
      const placeholders = files.map((_, i) => `('handoff', $${i + 1})`).join(", ");
      await query(
        `INSERT INTO pending_embeddings (content_type, content_id)
         VALUES ${placeholders}
         ON CONFLICT (content_type, content_id) DO NOTHING`,
        files
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
      `[import] Manifest: app=${manifest.app_version}` +
        (manifest.exported_at ? `, exported_at=${manifest.exported_at}` : "")
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

    // Cross-table consistency of the notes and note_versions files, still
    // before any database write (including the --force truncate).
    await verifyNoteHistory(tablesDir);

    // Decide whether this import will proceed BEFORE touching the destination
    // in any way — including its schema. A refused import (non-empty
    // destination, no --force) must leave the database exactly as it found it:
    // if the operator's PG* env points at a live deployment by mistake, running
    // pending migrations first would modify it and only then refuse. These
    // reads are safe on an old schema: checkDatabaseEmpty counts a table the
    // schema lacks as zero rows (42P01).
    const { empty, counts } = await checkDatabaseEmpty();
    const existingHandoffs = await countHandoffFiles();

    if (!empty || existingHandoffs > 0) {
      if (!args.force && !args.dryRun) {
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
      if (args.force) {
        console.log(
          `[import] --force: pre-wipe found ${Object.values(counts).reduce((a, b) => a + b, 0)} row(s) ` +
            `across managed tables and ${existingHandoffs} handoff file(s)`
        );
      } else if (args.dryRun) {
        console.log(
          `[import] (dry-run) Destination is not empty ` +
            `(${Object.values(counts).reduce((a, b) => a + b, 0)} row(s) across managed tables, ` +
            `${existingHandoffs} handoff file(s)); a real run would require --force`
        );
      }
    }

    // The import will proceed (empty destination, --force, or dry-run): now
    // make sure the schema is current. Settled before the truncate and the load
    // so a missing column can never fail the load after the wipe. In dry-run
    // this only reports what would run.
    await verifyMigrations(manifest, args.dryRun);

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
      console.log(
        `  handoffs/${ARCHIVE_DIRNAME}/: merge ${manifest.handoff_archive_file_count ?? 0} file(s) ` +
          `from the tarball; existing archive files are kept, never overwritten or cleared`
      );
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
    const archiveLoaded = await restoreHandoffArchive(join(staging, "handoffs"));
    console.log(`[import] handoffs/${ARCHIVE_DIRNAME}/: ${archiveLoaded} file(s) merged (existing kept)`);

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
