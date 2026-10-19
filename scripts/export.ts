#!/usr/bin/env tsx
/**
 * export — deployment-portable backup of a Context Library instance.
 *
 * Produces a single .tar.gz that contains:
 *   - `manifest.json` — app version, applied migrations, embedding model +
 *     dimensions, per-table row counts, handoff schema versions
 *   - `tables/*.jsonl` — one JSON line per row per Postgres table, sorted
 *     deterministically so consecutive exports of an unchanged database
 *     produce byte-identical output (this is what makes a nightly-commit
 *     backup pattern diff cleanly). Every table is read from one
 *     REPEATABLE READ snapshot, so the files are mutually consistent even
 *     when the export races a write (see exportAllTables)
 *   - `handoffs/*.json` — verbatim copy of the handoff file tree
 *
 * The database schema must be at least as new as this checkout: the SELECTs
 * name every column in the table registry (scripts/portability/tables.ts), so
 * exporting from a checkout newer than the schema fails fast with
 * `column ... does not exist` (SQLSTATE 42703). That is by design — a tarball
 * quietly missing the new columns would be a lossy backup. Start the server
 * once (it migrates at startup) or run the migration runner, then export. Only
 * a wholly missing TABLE (42P01) is tolerated: it is written as an empty file.
 *
 * Embeddings are excluded by default because they are recomputable — a
 * re-embed on import is cheaper than paying to ship the vectors around and
 * they inflate the tarball by ~2 KiB per chunk. `--include-embeddings` opts
 * back in for exact-restore scenarios.
 *
 * Usage:
 *   npm run export
 *   npm run export -- --out /path/to/exports/
 *   npm run export -- --include-embeddings
 *
 * The output tarball is named:
 *   context-library-<app_version>-<YYYYMMDDTHHmmssZ>.tar.gz
 * so the same operator running two exports in quick succession never
 * overwrites the previous file.
 *
 * Environment:
 *   DATA_DIR        Root data dir (default: ./data). Handoffs live in DATA_DIR/handoffs.
 *   PG*             Standard Postgres env vars (host/port/user/password/database).
 *   APP_VERSION     Injected by Docker; falls back to package.json.
 */

import { mkdtemp, cp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { PoolClient } from "pg";

import { config } from "../src/config.js";
import { ARCHIVE_DIRNAME } from "../src/storage/json-store.js";
import { pool, getClient } from "../src/db/client.js";
import {
  TABLES,
  type TableSpec,
} from "./portability/tables.js";
import {
  rowToJsonLine,
  writeJsonlFile,
  createTarball,
  ensureDir,
  writeJsonFile,
} from "./portability/io.js";
import { MANIFEST_VERSION, type ExportManifest } from "./portability/manifest.js";

// ── Args ──────────────────────────────────────────────────────────

interface Args {
  outDir: string;
  includeEmbeddings: boolean;
}

function parseArgs(argv: string[]): Args {
  let outDir = resolve(process.cwd(), config.dataDir, "exports");
  let includeEmbeddings = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out" || arg === "-o") {
      const next = argv[i + 1];
      if (!next) {
        console.error("Error: --out requires a path argument");
        process.exit(2);
      }
      outDir = resolve(process.cwd(), next);
      i++;
    } else if (arg === "--include-embeddings") {
      includeEmbeddings = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      console.error(usage());
      process.exit(2);
    }
  }
  return { outDir, includeEmbeddings };
}

function usage(): string {
  return `Usage: npm run export -- [--out <dir>] [--include-embeddings]

Options:
  --out, -o <dir>          Output directory for the tarball (default: <DATA_DIR>/exports/)
  --include-embeddings     Include the embeddings table in the export
  --help, -h               Show this help
`;
}

// ── Version resolution ────────────────────────────────────────────

async function resolveAppVersion(): Promise<string> {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  try {
    // Resolve package.json relative to this script's compiled location.
    const here = dirname(fileURLToPath(import.meta.url));
    // scripts/export.ts → ../package.json
    const pkgPath = resolve(here, "..", "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch (err) {
    // A silent 0.0.0 fallback would mislabel the tarball filename and the
    // manifest — surface the problem so the operator can set APP_VERSION
    // or fix the package.json read rather than shipping a wrong version.
    console.warn(
      `[export] Could not read package.json to resolve app version (${(err as Error).message}); ` +
        "falling back to 0.0.0. Set APP_VERSION to override."
    );
    return "0.0.0";
  }
}

// ── Table export ──────────────────────────────────────────────────

async function exportTable(
  client: PoolClient,
  spec: TableSpec,
  stagingDir: string
): Promise<number> {
  const sql = `SELECT ${spec.columns.join(", ")} FROM ${spec.name} ORDER BY ${spec.orderBy}`;
  const res = await client.query<Record<string, unknown>>(sql);
  const lines = res.rows.map((row) => rowToJsonLine(row, spec.columns));
  await writeJsonlFile(join(stagingDir, "tables", `${spec.name}.jsonl`), lines);
  return lines.length;
}

// ── Handoff scan ──────────────────────────────────────────────────

/**
 * Copies `handoffs/archive/` verbatim. Under COMPACTION_MODE=archive (the
 * default) this holds the byte-exact original of every compacted handoff —
 * for those handoffs, the only full copy that survives — plus any sidecars
 * written by `rehydrate-handoffs`. The top-level scan below only picks up
 * `*.json` files, so without this the archive would never be backed up.
 */
async function copyHandoffArchive(handoffsSrc: string, stagingDir: string): Promise<number> {
  const src = join(handoffsSrc, ARCHIVE_DIRNAME);
  let entries;
  try {
    entries = await readdir(src, { recursive: true, withFileTypes: true });
  } catch {
    return 0; // No archive directory — nothing was ever compacted in archive mode.
  }
  const count = entries.filter((e) => e.isFile() && !e.name.startsWith(".tmp-")).length;
  if (count > 0) {
    await cp(src, join(stagingDir, "handoffs", ARCHIVE_DIRNAME), {
      recursive: true,
      filter: (path) => !path.split(/[\\/]/).pop()!.startsWith(".tmp-"),
    });
  }
  return count;
}


async function copyHandoffs(
  handoffsSrc: string,
  stagingDir: string
): Promise<{ count: number; schema_versions: number[] }> {
  const dest = join(stagingDir, "handoffs");
  await ensureDir(dest);

  let files: string[];
  try {
    files = (await readdir(handoffsSrc))
      .filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"))
      .sort();
  } catch {
    return { count: 0, schema_versions: [] };
  }

  const schemaVersions = new Set<number>();
  for (const filename of files) {
    const src = join(handoffsSrc, filename);
    const dst = join(dest, filename);
    await cp(src, dst);
    try {
      const raw = await readFile(src, "utf-8");
      const parsed = JSON.parse(raw) as { schema_version?: unknown };
      if (typeof parsed.schema_version === "number") {
        schemaVersions.add(parsed.schema_version);
      }
    } catch (err) {
      // Corrupt handoff file — count it (it's already been copied) but
      // surface a warning so the operator finds out at export time rather
      // than on restore.
      console.warn(
        `[export] handoffs/${filename}: could not parse — copied verbatim, ` +
          `schema_version not recorded (${(err as Error).message})`
      );
    }
  }

  return {
    count: files.length,
    schema_versions: Array.from(schemaVersions).sort((a, b) => a - b),
  };
}

// ── Migration inventory ───────────────────────────────────────────

/**
 * SQLSTATE 42P01 = undefined_table. See import.ts for the same guard —
 * a bare catch-all here would silently swallow permission/connection
 * errors and ship a manifest with `applied_migrations: []`, defeating
 * the deterministic-diff promise on the next successful export and
 * making `verifyMigrations` on import a no-op (nothing is "missing"
 * from an empty list).
 */
const PG_UNDEFINED_TABLE = "42P01";

function isUndefinedTableError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === PG_UNDEFINED_TABLE
  );
}

/**
 * Run `fn` inside a savepoint so an undefined_table error (42P01) does not
 * poison the surrounding snapshot transaction. On 42P01 the savepoint is
 * rolled back — the transaction stays usable and keeps its snapshot — and
 * `undefined` is returned; any other error re-throws and fails the export.
 */
async function orIfTableMissing<T>(
  client: PoolClient,
  fn: () => Promise<T>
): Promise<T | undefined> {
  await client.query("SAVEPOINT export_step");
  try {
    const value = await fn();
    await client.query("RELEASE SAVEPOINT export_step");
    return value;
  } catch (err) {
    if (!isUndefinedTableError(err)) throw err;
    await client.query("ROLLBACK TO SAVEPOINT export_step");
    return undefined;
  }
}

async function readAppliedMigrations(client: PoolClient): Promise<string[]> {
  const rows = await orIfTableMissing(client, async () => {
    const res = await client.query<{ filename: string }>(
      "SELECT filename FROM _migrations ORDER BY filename"
    );
    return res.rows.map((r) => r.filename);
  });
  return rows ?? [];
}

// ── Snapshot export ───────────────────────────────────────────────

/**
 * Reads every table (and the migration inventory) from ONE snapshot and
 * returns the per-table row counts the manifest declares. The counts are the
 * lengths of the very result sets that were written, so they cannot disagree
 * with the JSONL files.
 *
 * Why a single REPEATABLE READ transaction rather than one autocommit SELECT
 * per table: note_versions is written in the same transaction as every note
 * edit (a trigger), so reading `notes` and `note_versions` at two different
 * instants can capture a note at version N alongside a history row (id, N) —
 * the restored note would then collide with its own history on the next edit
 * and be permanently uneditable — or a history row whose note the earlier read
 * missed, which fails the restore half-way through. The same skew existed
 * latently between entity_nodes and entity_relations. READ ONLY guarantees the
 * export cannot write. The snapshot lives only as long as the table reads
 * (JSONL is staged to disk while it is open), not the handoff copy or the tar
 * step.
 */
async function exportAllTables(
  includeEmbeddings: boolean,
  staging: string
): Promise<{ rowCounts: Record<string, number>; appliedMigrations: string[] }> {
  const tablesStaging = join(staging, "tables");
  const rowCounts: Record<string, number> = {};
  const client = await getClient();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

    for (const spec of TABLES) {
      if (spec.embeddingsOnly && !includeEmbeddings) continue;
      // A missing table (fresh install that has never applied a given
      // migration) is not fatal — record zero and keep going. Only PG's
      // undefined_table (42P01) is treated this way. Any other error
      // re-throws to fail fast.
      const n = await orIfTableMissing(client, () =>
        exportTable(client, spec, staging)
      );
      if (n !== undefined) {
        rowCounts[spec.name] = n;
        console.log(`[export] tables/${spec.name}.jsonl: ${n} row(s)`);
        continue;
      }
      rowCounts[spec.name] = 0;
      await writeJsonlFile(join(tablesStaging, `${spec.name}.jsonl`), []);
      if (spec.embeddingsOnly && includeEmbeddings) {
        console.warn(
          `[export] --include-embeddings requested but ${spec.name} table is absent; ` +
            "wrote empty JSONL. Import will queue every row for re-embed as usual."
        );
      } else {
        console.warn(`[export] tables/${spec.name}.jsonl: table missing, wrote empty file`);
      }
    }

    const appliedMigrations = await readAppliedMigrations(client);
    await client.query("COMMIT");
    return { rowCounts, appliedMigrations };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const appVersion = await resolveAppVersion();

  // Format as YYYYMMDDTHHmmssZ (no milliseconds) — matches the shape
  // documented in the file-header comment and docs/backup-restore.md.
  const stamp = new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
  const tarballName = `context-library-${appVersion}-${stamp}.tar.gz`;
  await ensureDir(args.outDir);
  const tarballPath = join(args.outDir, tarballName);

  console.log(`[export] Target tarball: ${tarballPath}`);
  if (args.includeEmbeddings) {
    console.log("[export] --include-embeddings: embeddings table will be shipped");
  }

  const staging = await mkdtemp(join(tmpdir(), "cl-export-"));
  const tablesStaging = join(staging, "tables");
  await ensureDir(tablesStaging);

  try {
    // Every table read and the migration inventory come from one snapshot.
    const { rowCounts, appliedMigrations } = await exportAllTables(
      args.includeEmbeddings,
      staging
    );

    const handoffsSrc = join(config.dataDir, "handoffs");
    const handoffs = await copyHandoffs(handoffsSrc, staging);
    console.log(`[export] handoffs/: ${handoffs.count} file(s)`);
    const archiveCount = await copyHandoffArchive(handoffsSrc, staging);
    console.log(`[export] handoffs/${ARCHIVE_DIRNAME}/: ${archiveCount} file(s)`);

    // NOTE: `exported_at` is deliberately omitted. Its ever-changing value
    // was defeating the deterministic-diff promise of the nightly-commit
    // backup pattern documented in docs/backup-restore.md — a manifest that
    // differs on every run means a git commit is generated even when the
    // underlying data has not changed. The tarball filename still carries
    // the timestamp for human-scale bookkeeping.
    const manifest: ExportManifest = {
      manifest_version: MANIFEST_VERSION,
      app_version: appVersion,
      applied_migrations: appliedMigrations,
      handoff_schema_versions: handoffs.schema_versions,
      handoff_file_count: handoffs.count,
      handoff_archive_file_count: archiveCount,
      embedding_model: config.embeddingModel,
      embedding_dimensions: config.embeddingDimensions,
      includes_embeddings: args.includeEmbeddings,
      row_counts: rowCounts,
    };

    await writeJsonFile(join(staging, "manifest.json"), manifest);
    console.log(
      `[export] manifest.json: ${manifest.applied_migrations.length} migration(s), ` +
        `model=${manifest.embedding_model}, dims=${manifest.embedding_dimensions}`
    );

    await createTarball(staging, tarballPath);
    console.log(`[export] Wrote ${tarballPath}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

main()
  .catch((err) => {
    console.error("[export] Fatal:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
