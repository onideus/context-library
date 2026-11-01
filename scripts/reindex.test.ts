import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  parseReindexArgs,
  runReindex,
  DEFAULT_TYPES,
  HANDOFF_WARNING,
  type ReindexDeps,
} from "./reindex.js";
import { runScriptSync } from "../src/__tests__/helpers/spawn-server.js";

/**
 * Unit level: every database / embedding-server touch goes through injected
 * deps that record their calls. No Postgres or embedding server needed.
 */

function fakeDeps(opts: { embeddingUp?: boolean; handoffErrors?: number } = {}) {
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: ReindexDeps = {
    isEmbeddingAvailable: async () => {
      calls.push("isEmbeddingAvailable");
      return opts.embeddingUp ?? true;
    },
    drainPendingEmbeddings: async () => {
      calls.push("drainPendingEmbeddings");
      return { processed: 1, remaining: 0, errors: 0 };
    },
    indexAllHandoffs: async () => {
      calls.push("indexAllHandoffs");
      return { indexed: 2, skipped: 0, errors: opts.handoffErrors ?? 0 };
    },
    indexAllTasks: async () => {
      calls.push("indexAllTasks");
      return 3;
    },
    indexAllNotes: async () => {
      calls.push("indexAllNotes");
      return 4;
    },
    indexAllArtifacts: async () => {
      calls.push("indexAllArtifacts");
      return 5;
    },
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  };
  return { deps, calls, out, err };
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
        pending_drain: { processed: 1, remaining: 0, errors: 0 },
        tasks: { indexed: 3 },
        notes: { indexed: 4 },
        artifacts: { indexed: 5 },
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
    expect(ok.calls).toEqual(["isEmbeddingAvailable", "drainPendingEmbeddings", "indexAllHandoffs"]);

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
});
