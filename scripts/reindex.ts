#!/usr/bin/env tsx
/**
 * reindex — rebuild the semantic search index (operator script).
 *
 * Re-embeds every task, note and artifact (and, only on explicit request,
 * every handoff file) into the `embeddings` table. This used to be the
 * `reindex` MCP tool; it is an operator action, not something a model should
 * trigger mid-conversation, so it now runs from a source checkout like
 * `export` and `import`. The production image ships `dist/` only (no
 * `scripts/`, no tsx), so run it from a checkout pointed at the deployment.
 *
 * Order of work:
 *   1. When handoffs are requested: check that DATA_DIR/handoffs is a readable
 *      directory holding at least one *.json file. Otherwise exit 1, before
 *      any network or database access.
 *   2. Check the embedding server's /health. Unreachable → exit 1, before the
 *      database is touched.
 *   3. Check the database (`SELECT 1`). Unreachable → exit 1, before any
 *      drain or index work.
 *   4. Drain `pending_embeddings` (one batch, oldest first), so items queued
 *      during an outage are not re-processed by the full pass below. The
 *      drain never touches handoff rows from this script, whatever the flags:
 *      they are excluded in its select, so they are neither read nor deleted.
 *   5. Re-embed the selected types and print the counts.
 *
 * Why the drain skips handoff rows, and why DATA_DIR matters: the drain reads
 * a queued handoff from DATA_DIR/handoffs/<file> and deletes the row when the
 * read fails ("source missing"). This script runs from a checkout, where
 * DATA_DIR defaults to ./data (or whatever the checkout's .env says), so a
 * wrong DATA_DIR would delete queued handoff rows — and a queued row is what
 * stops compaction of a handoff that was never embedded. With
 * --include-handoffs every file on disk is re-embedded anyway; leftover queued
 * handoff rows are drained later by the server, which has the right DATA_DIR.
 * Handoff files are read only when handoffs are requested.
 *
 * Handoffs are skipped unless asked for twice. Reindexing a handoff deletes
 * its `<filename>#%` rows from `embeddings` and re-inserts from the file as it
 * is on disk now; for a compacted handoff that overwrites the pre-compaction
 * chunk text, which is the only recovery source scripts/rehydrate-handoffs.ts
 * has. Run `npm run audit-compaction` (and rehydration, if it reports
 * RECOVERABLE files) before reindexing handoffs.
 *
 * Usage:
 *   npm run reindex                                      # tasks, notes, artifacts
 *   npm run reindex -- --types note,artifact             # a subset
 *   npm run reindex -- --types handoff --include-handoffs
 *
 * Exit codes:
 *   0  Every item of every requested type was embedded, and the drain left no
 *      failed row behind. Rows the drain dropped because their source no longer
 *      exists (normal when something is deleted before the next drain) are
 *      printed as warnings and do not fail the run.
 *   1  Any of:
 *        - handoffs requested and DATA_DIR/handoffs is missing, unreadable or
 *          holds no *.json file (checked before any network or database access);
 *        - the embedding server is unreachable (before any database access);
 *        - the database is unreachable (before any drain or index work);
 *        - the drain could not read pending_embeddings, or a queued row failed
 *          to embed (each is printed with content_type, content_id and error);
 *        - for any requested type, an item was queued instead of embedded
 *          (the embedding server failed mid-run) or failed outright (a 4xx
 *          from the embedding server, a database error, an enqueue that
 *          failed); for handoffs, any queued file or error;
 *        - a step threw.
 *      The JSON summary then has `success: false` and a `failures` list.
 *   2  Usage error (including `--types handoff` without `--include-handoffs`),
 *      refused before any file, database or embedding-server access.
 *
 * A row that keeps failing at drain time stays queued (there is no retry cap)
 * and fails every run. Once you have read its last_error and decided it should
 * go, clear it by hand:
 *   DELETE FROM pending_embeddings WHERE content_type = '<type>' AND content_id = '<id>';
 *
 * Environment (must point at the deployment, not at compose-internal names;
 * a checkout's .env is loaded and can set any of these):
 *   EMBEDDING_URL   The embedding server, e.g. http://localhost:<port> using the
 *                   host port your compose file publishes for it.
 *   PG*             Standard Postgres env vars (host/port/user/password/database),
 *                   e.g. PGHOST=localhost with the host port your compose file
 *                   publishes for Postgres.
 *   DATA_DIR        Root data dir (default: ./data). Must be the deployment's
 *                   data directory when reindexing handoffs: they are read from
 *                   DATA_DIR/handoffs, and only then.
 */

import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { config } from "../src/config.js";
import { pool, query } from "../src/db/client.js";
import { isEmbeddingAvailable } from "../src/embeddings/client.js";
import {
  drainPendingEmbeddings,
  indexAllHandoffs,
  indexAllTasks,
  indexAllNotes,
  indexAllArtifacts,
  type DrainOptions,
  type DrainResult,
  type IndexAllResult,
} from "../src/embeddings/indexer.js";

export const REINDEX_TYPES = ["handoff", "task", "note", "artifact"] as const;
export type ReindexType = (typeof REINDEX_TYPES)[number];

/** What a run without --types reindexes. Handoffs are deliberately absent. */
export const DEFAULT_TYPES: ReindexType[] = ["task", "note", "artifact"];

export const HANDOFF_WARNING =
  "Reindexing handoffs is refused without --include-handoffs.\n" +
  "Do not reindex handoffs while compacted files are still awaiting recovery: reindexing a\n" +
  "handoff deletes its <filename>#% rows from embeddings and re-inserts from what is on disk\n" +
  "now. For an already-compacted file that overwrites the pre-compaction chunk text, which is\n" +
  "the only recovery source scripts/rehydrate-handoffs.ts has. Run the audit and rehydration\n" +
  "scripts first (npm run audit-compaction, npm run rehydrate-handoffs), then re-run with\n" +
  "--types handoff --include-handoffs.";

const USAGE =
  "Usage: npm run reindex -- [--types task,note,artifact,handoff] [--include-handoffs]\n" +
  "  With no flags: reindexes tasks, notes and artifacts; skips handoffs.\n" +
  "  Handoffs need BOTH --types including 'handoff' AND --include-handoffs.";

export type ParsedArgs =
  | { ok: true; help: boolean; types: ReindexType[] }
  | { ok: false; message: string };

export function parseReindexArgs(argv: string[]): ParsedArgs {
  let typesArg: string | undefined;
  let includeHandoffs = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { ok: true, help: true, types: [] };
    if (arg === "--include-handoffs") {
      includeHandoffs = true;
    } else if (arg === "--types") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { ok: false, message: "--types needs a value, e.g. --types task,note" };
      }
      typesArg = next;
      i++;
    } else if (arg.startsWith("--types=")) {
      typesArg = arg.slice("--types=".length);
    } else {
      return { ok: false, message: `Unknown argument: ${arg}` };
    }
  }

  let types: ReindexType[];
  if (typesArg === undefined) {
    types = [...DEFAULT_TYPES];
  } else {
    const requested = typesArg.split(",").map((t) => t.trim()).filter(Boolean);
    if (requested.length === 0) {
      return { ok: false, message: "--types needs at least one of: " + REINDEX_TYPES.join(", ") };
    }
    const unknown = requested.filter((t) => !(REINDEX_TYPES as readonly string[]).includes(t));
    if (unknown.length > 0) {
      return {
        ok: false,
        message: `Unknown type(s): ${unknown.join(", ")}. Valid: ${REINDEX_TYPES.join(", ")}`,
      };
    }
    types = REINDEX_TYPES.filter((t) => requested.includes(t));
  }

  if (types.includes("handoff") && !includeHandoffs) {
    return { ok: false, message: HANDOFF_WARNING };
  }
  if (includeHandoffs && !types.includes("handoff")) {
    return {
      ok: false,
      message: "--include-handoffs only applies together with --types including 'handoff'.",
    };
  }
  return { ok: true, help: false, types };
}

/** Everything run() touches outside itself, injectable for tests. */
export interface ReindexDeps {
  /** Is DATA_DIR/handoffs a readable directory with at least one *.json file? */
  checkHandoffsDir: () => Promise<{ ok: boolean; path: string; reason?: string }>;
  isEmbeddingAvailable: () => Promise<boolean>;
  /** `SELECT 1` against the configured database. */
  checkDatabase: () => Promise<{ ok: boolean; reason?: string }>;
  drainPendingEmbeddings: (opts: DrainOptions) => Promise<DrainResult>;
  indexAllHandoffs: () => Promise<{ indexed: number; skipped: number; queued: number; errors: number }>;
  indexAllTasks: () => Promise<IndexAllResult>;
  indexAllNotes: () => Promise<IndexAllResult>;
  indexAllArtifacts: () => Promise<IndexAllResult>;
  log: (line: string) => void;
  error: (line: string) => void;
}

/** config.dataDir is read once at import, so this is the path the indexer will use. */
async function checkHandoffsDir(): Promise<{ ok: boolean; path: string; reason?: string }> {
  const path = resolve(config.dataDir, "handoffs");
  try {
    if (!(await stat(path)).isDirectory()) {
      return { ok: false, path, reason: "is not a directory" };
    }
  } catch (err) {
    return { ok: false, path, reason: `does not exist or cannot be read (${(err as Error).message})` };
  }
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch (err) {
    return { ok: false, path, reason: `cannot be read (${(err as Error).message})` };
  }
  if (!entries.some((f) => f.endsWith(".json"))) {
    return { ok: false, path, reason: "holds no *.json handoff files" };
  }
  return { ok: true, path };
}

async function checkDatabase(): Promise<{ ok: boolean; reason?: string }> {
  try {
    await query("SELECT 1");
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

const defaultDeps: ReindexDeps = {
  checkHandoffsDir,
  isEmbeddingAvailable,
  checkDatabase,
  drainPendingEmbeddings: (opts) => drainPendingEmbeddings(undefined, opts),
  indexAllHandoffs,
  indexAllTasks,
  indexAllNotes,
  indexAllArtifacts,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

/** Run a reindex. Resolves to the process exit code; never calls process.exit. */
export async function runReindex(argv: string[], deps: ReindexDeps = defaultDeps): Promise<number> {
  const parsed = parseReindexArgs(argv);
  if (!parsed.ok) {
    deps.error(`[reindex] ${parsed.message}`);
    deps.error(USAGE);
    return 2;
  }
  if (parsed.help) {
    deps.log(USAGE);
    return 0;
  }
  const { types } = parsed;
  if (!types.includes("handoff")) {
    deps.log(
      "[reindex] Skipping handoffs (reindex them only with --types handoff --include-handoffs, " +
        "after npm run audit-compaction)."
    );
  } else {
    // Before any network or database access: a wrong DATA_DIR here would
    // "reindex" nothing and report it as done.
    const dir = await deps.checkHandoffsDir();
    if (!dir.ok) {
      deps.error(
        `[reindex] Handoff directory ${dir.path} ${dir.reason ?? "is not usable"}. ` +
          "DATA_DIR must point at the deployment's data directory (the one holding handoffs/); " +
          "a checkout's .env can set it."
      );
      return 1;
    }
  }

  // Embedding server first: no point opening database connections otherwise.
  if (!(await deps.isEmbeddingAvailable())) {
    deps.error(
      "[reindex] Embedding server is not available (EMBEDDING_URL/health). Cannot reindex. " +
        "Point EMBEDDING_URL at the host port your compose file publishes for it."
    );
    return 1;
  }

  const db = await deps.checkDatabase();
  if (!db.ok) {
    deps.error(
      `[reindex] Database is not reachable (${db.reason ?? "SELECT 1 failed"}). Cannot reindex. ` +
        "Point PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE at the deployment's Postgres " +
        "(e.g. PGHOST=localhost with the host port your compose file publishes for it)."
    );
    return 1;
  }

  const results: Record<string, unknown> = {};
  const failures: string[] = [];

  // Drain the pending queue first so recovered items aren't re-processed by
  // the full reindex below. Never handoff rows: see the header.
  const drained = await deps.drainPendingEmbeddings({ skipHandoffs: true });
  results.pending_drain = {
    processed: drained.processed,
    remaining: drained.remaining,
    errors: drained.errors,
    dropped: drained.dropped,
  };
  deps.log(
    `[reindex] pending_embeddings drained (handoff rows left for the server): ` +
      `processed=${drained.processed} remaining=${drained.remaining} errors=${drained.errors} ` +
      `dropped=${drained.dropped}`
  );
  if (drained.select_error !== undefined) {
    deps.error(`[reindex] Could not read pending_embeddings: ${drained.select_error}`);
    failures.push(`pending_drain: could not read pending_embeddings (${drained.select_error})`);
  }
  if (drained.dropped > 0) {
    deps.error(
      `[reindex] warning: the drain dropped ${drained.dropped} queued row(s) whose source no longer exists.`
    );
  }
  for (const row of drained.failures) {
    deps.error(
      `[reindex] pending_embeddings row failed and stays queued: ` +
        `content_type=${row.content_type} content_id=${row.content_id} last_error=${row.error}`
    );
  }
  const drainFailed = drained.errors - drained.dropped;
  if (drainFailed > 0) {
    failures.push(`pending_drain: ${drainFailed} queued row(s) failed to embed and stay queued`);
    deps.error(
      "[reindex] To clear a row that keeps failing: " +
        "DELETE FROM pending_embeddings WHERE content_type = '<type>' AND content_id = '<id>';"
    );
  }

  if (types.includes("handoff")) {
    const handoffs = await deps.indexAllHandoffs();
    results.handoffs = handoffs;
    deps.log(
      `[reindex] handoffs: indexed=${handoffs.indexed} skipped=${handoffs.skipped} ` +
        `queued=${handoffs.queued} errors=${handoffs.errors}`
    );
    if (handoffs.queued + handoffs.errors > 0) {
      failures.push(`handoffs: queued=${handoffs.queued} errors=${handoffs.errors}`);
    }
  }
  const tables: Array<[ReindexType, string, () => Promise<IndexAllResult>]> = [
    ["task", "tasks", deps.indexAllTasks],
    ["note", "notes", deps.indexAllNotes],
    ["artifact", "artifacts", deps.indexAllArtifacts],
  ];
  for (const [type, label, indexAll] of tables) {
    if (!types.includes(type)) continue;
    const counts = await indexAll();
    results[label] = { indexed: counts.indexed, queued: counts.queued, failed: counts.failed };
    deps.log(
      `[reindex] ${label}: indexed=${counts.indexed} queued=${counts.queued} failed=${counts.failed}`
    );
    if (counts.queued + counts.failed > 0) {
      failures.push(`${label}: queued=${counts.queued} failed=${counts.failed}`);
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) deps.error(`[reindex] FAILED ${failure}`);
    deps.log(JSON.stringify({ success: false, reindexed: results, failures }, null, 2));
    return 1;
  }
  deps.log(JSON.stringify({ success: true, reindexed: results }, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReindex(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error("[reindex] Fatal:", err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
