import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Unit level: what the single-item indexers resolve to, and how the bulk
 * indexAll* passes count it. The database and the embedding server are mocked;
 * no Postgres or embedding server needed.
 */

const TEST_DATA_DIR = join(process.cwd(), "data", "test-indexer-outcomes");

/** Content ids (or handoff filenames) whose embed fails, and how. */
const embedFailures = new Map<string, Error>();
/** Content ids whose INSERT INTO pending_embeddings fails. */
const enqueueFailures = new Set<string>();
/** Rows the SELECT ... FROM <table> of a bulk pass returns. */
const tableRows: Record<string, Array<Record<string, unknown>>> = {};

const connectivity = () => new Error("fetch failed: connect ECONNREFUSED");
const badRequest = () => new Error("Embedding server error (413): input too long");

vi.mock("../embeddings/client.js", () => ({
  generateEmbedding: vi.fn(async (text: string) => {
    for (const [id, err] of embedFailures) {
      if (text.includes(`marker-${id}`)) throw err;
    }
    return [0.1, 0.2, 0.3];
  }),
}));

vi.mock("../db/client.js", () => ({
  pool: { query: async () => ({ rows: [] }), end: async () => {} },
  getClient: async () => ({}),
  query: vi.fn(async (text: string, params: unknown[] = []) => {
    if (text.includes("INSERT INTO pending_embeddings")) {
      const contentId = String(params[1]);
      if (enqueueFailures.has(contentId)) throw new Error("connect ECONNREFUSED (postgres)");
      return { rows: [], rowCount: 1 };
    }
    const table = /FROM (tasks|notes|artifacts)\b/.exec(text)?.[1];
    if (text.trimStart().startsWith("SELECT") && table) {
      return { rows: tableRows[table] ?? [], rowCount: (tableRows[table] ?? []).length };
    }
    return { rows: [], rowCount: 0 };
  }),
}));

type Indexer = typeof import("../embeddings/indexer.js");
let indexer: Indexer;

beforeAll(async () => {
  process.env.DATA_DIR = TEST_DATA_DIR;
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
  await mkdir(join(TEST_DATA_DIR, "handoffs"), { recursive: true });
  indexer = await import("../embeddings/indexer.js");
});

afterAll(async () => {
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  embedFailures.clear();
  enqueueFailures.clear();
  for (const key of Object.keys(tableRows)) delete tableRows[key];
});

const note = (id: string) => ({ title: `Note marker-${id}`, content: "Some decision." });
const artifact = (id: string) => ({ title: `Artifact marker-${id}`, content: "Body.", artifact_type: "research" });

/** One call per single-item indexer, keyed by the id it enqueues under. */
const singles: Array<[string, (id: string) => Promise<string>]> = [
  ["indexNote", (id) => indexer.indexNote(id, note(id))],
  ["indexArtifact", (id) => indexer.indexArtifact(id, artifact(id))],
  ["indexTask", (id) => indexer.indexTask(id, `Task marker-${id}`, null, "personal", [], "open")],
  ["indexHandoff", (id) => indexer.indexHandoff(id, { tone_notes: `Handoff marker-${id}` })],
];

describe("single-item indexer outcomes", () => {
  for (const [name, run] of singles) {
    it(`${name} resolves "indexed" when the embed succeeds`, async () => {
      expect(await run("item-1")).toBe("indexed");
    });

    it(`${name} resolves "queued" after a connectivity error`, async () => {
      embedFailures.set("item-2", connectivity());
      expect(await run("item-2")).toBe("queued");
    });

    it(`${name} resolves "lost" when the enqueue fails too`, async () => {
      embedFailures.set("item-3", connectivity());
      enqueueFailures.add("item-3");
      expect(await run("item-3")).toBe("lost");
    });

    it(`${name} still throws on a 4xx`, async () => {
      embedFailures.set("item-4", badRequest());
      await expect(run("item-4")).rejects.toThrow("Embedding server error (413)");
    });
  }
});

describe("bulk indexAll* counts", () => {
  const ids = ["ok-1", "ok-2", "queued-1", "bad-1", "lost-1"];
  function failSome() {
    embedFailures.set("queued-1", connectivity());
    embedFailures.set("bad-1", badRequest());
    embedFailures.set("lost-1", connectivity());
    enqueueFailures.add("lost-1");
  }

  it("indexAllNotes counts indexed, queued and failed (a thrown 4xx and a lost item)", async () => {
    tableRows.notes = ids.map((id) => ({ id, ...note(id), domain: null, tags: [], scope: "personal" }));
    failSome();
    expect(await indexer.indexAllNotes()).toEqual({ indexed: 2, queued: 1, failed: 2 });
  });

  it("indexAllArtifacts counts indexed, queued and failed", async () => {
    tableRows.artifacts = ids.map((id) => ({ id, ...artifact(id), tags: [], status: "draft", scope: "personal" }));
    failSome();
    expect(await indexer.indexAllArtifacts()).toEqual({ indexed: 2, queued: 1, failed: 2 });
  });

  it("indexAllTasks counts indexed, queued and failed", async () => {
    tableRows.tasks = ids.map((id) => ({
      id,
      title: `Task marker-${id}`,
      context: null,
      scope: "personal",
      tags: [],
      status: "open",
      created_at: new Date("2026-01-01T00:00:00Z"),
    }));
    failSome();
    expect(await indexer.indexAllTasks()).toEqual({ indexed: 2, queued: 1, failed: 2 });
  });

  it("indexAllTasks reports all zeros for an empty table", async () => {
    expect(await indexer.indexAllTasks()).toEqual({ indexed: 0, queued: 0, failed: 0 });
  });

  it("indexAllHandoffs counts queued files separately and lost files as errors", async () => {
    for (const id of ids) {
      await writeFile(
        join(TEST_DATA_DIR, "handoffs", `${id}.json`),
        JSON.stringify({ tone_notes: `Handoff marker-${id}.json` }),
        "utf-8"
      );
    }
    embedFailures.set("queued-1.json", connectivity());
    embedFailures.set("bad-1.json", badRequest());
    embedFailures.set("lost-1.json", connectivity());
    enqueueFailures.add("lost-1.json");
    expect(await indexer.indexAllHandoffs()).toEqual({ indexed: 2, skipped: 0, queued: 1, errors: 2 });
  });
});
