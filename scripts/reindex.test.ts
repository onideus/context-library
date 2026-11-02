import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseReindexArgs,
  runReindex,
  DEFAULT_TYPES,
  HANDOFF_WARNING,
  type ReindexDeps,
} from "./reindex.js";
import type { DrainOptions, DrainResult } from "../src/embeddings/indexer.js";
import { runScriptSync } from "../src/__tests__/helpers/spawn-server.js";

/**
 * Unit level: every database / embedding-server touch goes through injected
 * deps that record their calls. No Postgres or embedding server needed; the
 * "as a process" tests spawn the script against ports nothing listens on.
 */

type Counts = { indexed: number; queued: number; failed: number };

function fakeDeps(
  opts: {
    embeddingUp?: boolean;
    handoffErrors?: number;
    handoffQueued?: number;
    handoffsDirOk?: boolean;
    databaseUp?: boolean;
    drain?: Partial<DrainResult>;
    notes?: Partial<Counts>;
  } = {}
) {
  const calls: string[] = [];
  const drainOpts: DrainOptions[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: ReindexDeps = {
    checkHandoffsDir: async () => {
      calls.push("checkHandoffsDir");
      return opts.handoffsDirOk === false
        ? { ok: false, path: "/deploy/data/handoffs", reason: "holds no *.json handoff files" }
        : { ok: true, path: "/deploy/data/handoffs" };
    },
    isEmbeddingAvailable: async () => {
      calls.push("isEmbeddingAvailable");
      return opts.embeddingUp ?? true;
    },
    checkDatabase: async () => {
      calls.push("checkDatabase");
      return opts.databaseUp === false ? { ok: false, reason: "connect ECONNREFUSED" } : { ok: true };
    },
    drainPendingEmbeddings: async (o) => {
      calls.push("drainPendingEmbeddings");
      drainOpts.push(o);
      return { processed: 1, remaining: 0, errors: 0, dropped: 0, failures: [], ...opts.drain };
    },
    indexAllHandoffs: async () => {
      calls.push("indexAllHandoffs");
      return {
        indexed: 2,
        skipped: 0,
        queued: opts.handoffQueued ?? 0,
        errors: opts.handoffErrors ?? 0,
      };
    },
    indexAllTasks: async () => {
      calls.push("indexAllTasks");
      return { indexed: 3, queued: 0, failed: 0 };
    },
    indexAllNotes: async () => {
      calls.push("indexAllNotes");
      return { indexed: 4, queued: 0, failed: 0, ...opts.notes };
    },
    indexAllArtifacts: async () => {
      calls.push("indexAllArtifacts");
      return { indexed: 5, queued: 0, failed: 0 };
    },
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  };
  return { deps, calls, drainOpts, out, err };
}

describe("parseReindexArgs", () => {
  it("defaults to tasks, notes and artifacts", () => {
    expect(parseReindexArgs([])).toEqual({ ok: true, help: false, types: DEFAULT_TYPES });
    expect(DEFAULT_TYPES).not.toContain("handoff");
  });

  it("narrows with --types, in either spelling", () => {
    expect(parseReindexArgs(["--types", "note,artifact"])).toEqual({
      ok: true,
      help: false,
      types: ["note", "artifact"],
    });
    expect(parseReindexArgs(["--types=task"])).toEqual({ ok: true, help: false, types: ["task"] });
  });

  it("rejects unknown types and arguments", () => {
    expect(parseReindexArgs(["--types", "task,bogus"]).ok).toBe(false);
    expect(parseReindexArgs(["--everything"]).ok).toBe(false);
    expect(parseReindexArgs(["--types"]).ok).toBe(false);
  });

  it("refuses handoffs without --include-handoffs, with the recovery warning", () => {
    const parsed = parseReindexArgs(["--types", "handoff"]);
    expect(parsed).toEqual({ ok: false, message: HANDOFF_WARNING });
    expect(HANDOFF_WARNING).toContain("rehydrate-handoffs");
  });

  it("accepts handoffs only with both flags", () => {
    expect(parseReindexArgs(["--types", "handoff", "--include-handoffs"])).toEqual({
      ok: true,
      help: false,
      types: ["handoff"],
    });
    expect(parseReindexArgs(["--include-handoffs"]).ok).toBe(false);
  });
});

describe("runReindex", () => {
  it("--types handoff without --include-handoffs exits 2 and touches nothing", async () => {
    const { deps, calls, err } = fakeDeps();
    expect(await runReindex(["--types", "handoff"], deps)).toBe(2);
    expect(calls).toEqual([]);
    expect(err.join("\n")).toContain("pre-compaction chunk text");
  });

  it("a no-flag run skips handoffs and says so", async () => {
    const { deps, calls, out } = fakeDeps();
    expect(await runReindex([], deps)).toBe(0);
    expect(calls).toEqual([
      "isEmbeddingAvailable",
      "checkDatabase",
      "drainPendingEmbeddings",
      "indexAllTasks",
      "indexAllNotes",
      "indexAllArtifacts",
    ]);
    expect(out.join("\n")).toContain("Skipping handoffs");
    const summary = JSON.parse(out[out.length - 1]);
    expect(summary).toEqual({
      success: true,
      reindexed: {
        pending_drain: { processed: 1, remaining: 0, errors: 0, dropped: 0 },
        tasks: { indexed: 3, queued: 0, failed: 0 },
        notes: { indexed: 4, queued: 0, failed: 0 },
        artifacts: { indexed: 5, queued: 0, failed: 0 },
      },
    });
  });

  it("exits 1 before any database work when the embedding server is unreachable", async () => {
    const { deps, calls } = fakeDeps({ embeddingUp: false });
    expect(await runReindex([], deps)).toBe(1);
    expect(calls).toEqual(["isEmbeddingAvailable"]);
  });

  it("reindexes handoffs with both flags, and fails on handoff errors", async () => {
    const ok = fakeDeps();
    expect(await runReindex(["--types", "handoff", "--include-handoffs"], ok.deps)).toBe(0);
    expect(ok.calls).toEqual([
      "checkHandoffsDir",
      "isEmbeddingAvailable",
      "checkDatabase",
      "drainPendingEmbeddings",
      "indexAllHandoffs",
    ]);

    const bad = fakeDeps({ handoffErrors: 1 });
    expect(await runReindex(["--types", "handoff", "--include-handoffs"], bad.deps)).toBe(1);
  });

  it("propagates a thrown step so the entry point exits non-zero", async () => {
    const { deps } = fakeDeps();
    deps.indexAllNotes = async () => {
      throw new Error("boom");
    };
    await expect(runReindex([], deps)).rejects.toThrow("boom");
  });

  it("always drains with skipHandoffs, with and without the handoff flags", async () => {
    for (const argv of [[], ["--types", "note"], ["--types", "handoff,task", "--include-handoffs"]]) {
      const { deps, drainOpts } = fakeDeps();
      expect(await runReindex(argv, deps)).toBe(0);
      expect(drainOpts).toEqual([{ skipHandoffs: true }]);
    }
  });

  it("checks the handoff directory first and exits 1 when it is unusable", async () => {
    const { deps, calls, err } = fakeDeps({ handoffsDirOk: false });
    expect(await runReindex(["--types", "handoff", "--include-handoffs"], deps)).toBe(1);
    expect(calls).toEqual(["checkHandoffsDir"]);
    expect(err.join("\n")).toContain("/deploy/data/handoffs");
    expect(err.join("\n")).toContain("DATA_DIR");
  });

  it("does not check the handoff directory when handoffs are not requested", async () => {
    const { deps, calls } = fakeDeps({ handoffsDirOk: false });
    expect(await runReindex([], deps)).toBe(0);
    expect(calls).not.toContain("checkHandoffsDir");
  });

  it("exits 1 before the drain when the database is unreachable", async () => {
    const { deps, calls, err } = fakeDeps({ databaseUp: false });
    expect(await runReindex([], deps)).toBe(1);
    expect(calls).toEqual(["isEmbeddingAvailable", "checkDatabase"]);
    expect(err.join("\n")).toContain("PGHOST");
  });

  it("exits 1 with per-type counts when items were queued instead of embedded", async () => {
    const { deps, out, err } = fakeDeps({ notes: { indexed: 1, queued: 3 } });
    expect(await runReindex([], deps)).toBe(1);
    expect(out.join("\n")).toContain("[reindex] notes: indexed=1 queued=3 failed=0");
    const summary = JSON.parse(out[out.length - 1]);
    expect(summary.success).toBe(false);
    expect(summary.reindexed.notes).toEqual({ indexed: 1, queued: 3, failed: 0 });
    expect(summary.reindexed.tasks).toEqual({ indexed: 3, queued: 0, failed: 0 });
    expect(summary.failures).toEqual(["notes: queued=3 failed=0"]);
    expect(err.join("\n")).toContain("FAILED notes: queued=3 failed=0");
  });

  it("exits 1 when items failed outright", async () => {
    const { deps, out } = fakeDeps({ notes: { indexed: 3, failed: 1 } });
    expect(await runReindex([], deps)).toBe(1);
    const summary = JSON.parse(out[out.length - 1]);
    expect(summary.success).toBe(false);
    expect(summary.failures).toEqual(["notes: queued=0 failed=1"]);
  });

  it("exits 1 when handoffs were queued instead of embedded", async () => {
    const { deps, out } = fakeDeps({ handoffQueued: 2 });
    expect(await runReindex(["--types", "handoff", "--include-handoffs"], deps)).toBe(1);
    const summary = JSON.parse(out[out.length - 1]);
    expect(summary.success).toBe(false);
    expect(summary.reindexed.handoffs).toEqual({ indexed: 2, skipped: 0, queued: 2, errors: 0 });
    expect(summary.failures).toEqual(["handoffs: queued=2 errors=0"]);
  });

  it("exits 1 when a drained row failed to embed, naming the row", async () => {
    const { deps, out, err } = fakeDeps({
      drain: {
        processed: 0,
        remaining: 2,
        errors: 2,
        dropped: 1,
        failures: [{ content_type: "note", content_id: "note-1", error: "Embedding server error (500)" }],
      },
    });
    expect(await runReindex([], deps)).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("content_type=note content_id=note-1 last_error=Embedding server error (500)");
    expect(text).toContain("DELETE FROM pending_embeddings WHERE content_type =");
    const summary = JSON.parse(out[out.length - 1]);
    expect(summary.success).toBe(false);
    expect(summary.reindexed.pending_drain).toEqual({ processed: 0, remaining: 2, errors: 2, dropped: 1 });
    expect(summary.failures).toEqual(["pending_drain: 1 queued row(s) failed to embed and stay queued"]);
  });

  it("exits 0 with a warning when the drain only dropped orphaned rows", async () => {
    const { deps, out, err } = fakeDeps({ drain: { processed: 0, errors: 2, dropped: 2 } });
    expect(await runReindex([], deps)).toBe(0);
    expect(err.join("\n")).toContain("warning: the drain dropped 2 queued row(s)");
    expect(JSON.parse(out[out.length - 1]).success).toBe(true);
  });

  it("exits 1 when the drain could not read the queue", async () => {
    const { deps, out } = fakeDeps({
      drain: { processed: 0, select_error: 'relation "pending_embeddings" does not exist' },
    });
    expect(await runReindex([], deps)).toBe(1);
    const summary = JSON.parse(out[out.length - 1]);
    expect(summary.success).toBe(false);
    expect(summary.failures[0]).toContain("could not read pending_embeddings");
  });
});

describe("scripts/reindex.ts as a process", () => {
  // Nothing listens on these ports: a run that got past argument checks would
  // fail on the embedding server (exit 1), never exit 2.
  const env = {
    ...process.env,
    EMBEDDING_URL: "http://127.0.0.1:9",
    PGHOST: "127.0.0.1",
    PGPORT: "9",
    DATA_DIR: join(process.cwd(), "data", "test-reindex-script"),
  };

  it("exits 2 for --types handoff without --include-handoffs", () => {
    const res = runScriptSync("scripts/reindex.ts", ["--types", "handoff"], env);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("--include-handoffs");
    expect(res.stderr).not.toContain("Embedding server");
  });

  it("exits non-zero when the embedding server is unreachable", () => {
    const res = runScriptSync("scripts/reindex.ts", [], env);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Embedding server is not available");
  });

  it("exits 1 for handoffs when DATA_DIR has no handoff files, before the embedding server", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cl-reindex-"));
    try {
      mkdirSync(join(dataDir, "handoffs"));
      const res = runScriptSync("scripts/reindex.ts", ["--types", "handoff", "--include-handoffs"], {
        ...env,
        DATA_DIR: dataDir,
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(resolve(dataDir, "handoffs"));
      expect(res.stderr).toContain("DATA_DIR");
      expect(res.stderr).not.toContain("Embedding server");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
