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
 * Order of work, matching the old tool:
 *   1. Check the embedding server's /health. Unreachable → exit 1, before the
 *      database is touched.
 *   2. Drain `pending_embeddings` first, so items queued during an outage are
 *      not re-processed by the full pass below.
 *   3. Re-embed the selected types and print the counts.
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
 * Exit codes: 0 success; 1 embedding server unreachable, a reindex step threw,
 * or some handoff files failed to index; 2 usage error (including
 * `--types handoff` without `--include-handoffs`, refused before any database
 * or embedding-server access).
 *
 * Environment (must point at the deployment, not at compose-internal names):
 *   EMBEDDING_URL   The embedding server, e.g. http://localhost:<port> using the
 *                   host port your compose file publishes for it.
 *   PG*             Standard Postgres env vars (host/port/user/password/database),
 *                   e.g. PGHOST=localhost with the host port your compose file
 *                   publishes for Postgres.
 *   DATA_DIR        Root data dir (default: ./data). Handoffs live in
 *                   DATA_DIR/handoffs; only read with --include-handoffs.
 */

import { pathToFileURL } from "node:url";

import { pool } from "../src/db/client.js";
import { isEmbeddingAvailable } from "../src/embeddings/client.js";
import {
  drainPendingEmbeddings,
  indexAllHandoffs,
  indexAllTasks,
  indexAllNotes,
  indexAllArtifacts,
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
  isEmbeddingAvailable: () => Promise<boolean>;
  drainPendingEmbeddings: () => Promise<{ processed: number; remaining: number; errors: number }>;
  indexAllHandoffs: () => Promise<{ indexed: number; skipped: number; errors: number }>;
  indexAllTasks: () => Promise<number>;
  indexAllNotes: () => Promise<number>;
  indexAllArtifacts: () => Promise<number>;
  log: (line: string) => void;
  error: (line: string) => void;
}

const defaultDeps: ReindexDeps = {
  isEmbeddingAvailable,
  drainPendingEmbeddings: () => drainPendingEmbeddings(),
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
  }

  // Embedding server first: no point opening database connections otherwise.
  if (!(await deps.isEmbeddingAvailable())) {
    deps.error(
      "[reindex] Embedding server is not available (EMBEDDING_URL/health). Cannot reindex. " +
        "Point EMBEDDING_URL at the host port your compose file publishes for it."
    );
    return 1;
  }

  const results: Record<string, unknown> = {};
  let failed = false;

  // Drain the pending queue first so recovered items aren't re-processed by
  // the full reindex below.
  const drained = await deps.drainPendingEmbeddings();
  results.pending_drain = drained;
  deps.log(
    `[reindex] pending_embeddings drained: processed=${drained.processed} ` +
      `remaining=${drained.remaining} errors=${drained.errors}`
  );

  if (types.includes("handoff")) {
    const handoffs = await deps.indexAllHandoffs();
    results.handoffs = handoffs;
    deps.log(
      `[reindex] handoffs: indexed=${handoffs.indexed} skipped=${handoffs.skipped} errors=${handoffs.errors}`
    );
    if (handoffs.errors > 0) failed = true;
  }
  if (types.includes("task")) {
    const count = await deps.indexAllTasks();
    results.tasks = { indexed: count };
    deps.log(`[reindex] tasks: indexed=${count}`);
  }
  if (types.includes("note")) {
    const count = await deps.indexAllNotes();
    results.notes = { indexed: count };
    deps.log(`[reindex] notes: indexed=${count}`);
  }
  if (types.includes("artifact")) {
    const count = await deps.indexAllArtifacts();
    results.artifacts = { indexed: count };
    deps.log(`[reindex] artifacts: indexed=${count}`);
  }

  deps.log(JSON.stringify({ success: !failed, reindexed: results }, null, 2));
  return failed ? 1 : 0;
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
