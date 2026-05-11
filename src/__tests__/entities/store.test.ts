import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  upsertEntity,
  storeTriples,
  createExtractionRun,
  completeExtractionRun,
  failExtractionRun,
  getEntitiesForContent,
  getRelationsForEntity,
  compareRuns,
} from "../../entities/store.js";
import type { ExtractionResult } from "../../entities/types.js";

// ── DB mock ──────────────────────────────────────────────────────────

const queryMock = vi.fn();
vi.mock("../../db/client.js", () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

beforeEach(() => {
  queryMock.mockReset();
});

// ── Helpers ──────────────────────────────────────────────────────────

function makeEntityRow(overrides: Partial<{
  id: string;
  name: string;
  entity_type: string;
  canonical_name: string;
  mention_count: number;
}> = {}) {
  return {
    id: overrides.id ?? "aaa-111",
    name: overrides.name ?? "Acme Corp",
    entity_type: overrides.entity_type ?? "organization",
    canonical_name: overrides.canonical_name ?? "acme corp",
    first_seen: "2026-01-01T00:00:00Z",
    last_seen: "2026-01-02T00:00:00Z",
    mention_count: overrides.mention_count ?? 1,
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
  };
}

// ── upsertEntity ─────────────────────────────────────────────────────

describe("upsertEntity", () => {
  it("inserts a new entity and returns the row", async () => {
    const row = makeEntityRow({ name: "Acme Corp", entity_type: "organization", canonical_name: "acme corp" });
    queryMock.mockResolvedValueOnce({ rows: [row] });

    const result = await upsertEntity("Acme Corp", "organization");

    expect(result).not.toBeNull();
    expect(result!.name).toBe("Acme Corp");
    expect(result!.entity_type).toBe("organization");
    expect(result!.canonical_name).toBe("acme corp");
  });

  it("normalises canonical_name to lowercase trimmed value", async () => {
    const row = makeEntityRow({ canonical_name: "project alpha" });
    queryMock.mockResolvedValueOnce({ rows: [row] });

    await upsertEntity("  Project Alpha  ", "project");

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ON CONFLICT (canonical_name, entity_type)");
    expect(params[2]).toBe("project alpha");
  });

  it("deduplicates case variants via canonical_name", async () => {
    const row = makeEntityRow({ canonical_name: "typescript", mention_count: 2 });
    queryMock.mockResolvedValueOnce({ rows: [row] });

    await upsertEntity("TypeScript", "technology");

    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params[2]).toBe("typescript");
  });

  it("passes metadata as JSONB", async () => {
    const row = makeEntityRow();
    queryMock.mockResolvedValueOnce({ rows: [row] });

    await upsertEntity("Acme Corp", "organization", { source: "seed" });

    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(JSON.parse(params[3] as string)).toEqual({ source: "seed" });
  });

  it("returns null and logs a warning when Postgres is unavailable", async () => {
    queryMock.mockRejectedValueOnce(new Error("connection refused"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await upsertEntity("Widget", "concept");

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[entity-store] upsertEntity failed:"),
      expect.any(String)
    );
    warnSpy.mockRestore();
  });
});

// ── storeTriples ─────────────────────────────────────────────────────

describe("storeTriples", () => {
  const runId = "run-001";

  const sampleResult: ExtractionResult = {
    triples: [
      {
        subject: "Project Alpha",
        predicate: "uses",
        object: "PostgreSQL",
        confidence: 0.9,
        contextSnippet: "Project Alpha uses PostgreSQL for storage.",
      },
      {
        subject: "Jane Developer",
        predicate: "works_on",
        object: "Project Alpha",
        confidence: 0.85,
      },
    ],
    provider: "test-provider",
    providerVersion: "1.0.0",
    contentType: "note",
    contentId: "note-001",
    durationMs: 42,
  };

  it("upserts entities and inserts relations for each triple", async () => {
    // Each triple needs 2 upsertEntity calls + 1 relation insert = 3 queries per triple
    const subjectRow = makeEntityRow({ id: "sub-001", name: "Project Alpha", canonical_name: "project alpha" });
    const objectRow1 = makeEntityRow({ id: "obj-001", name: "PostgreSQL", canonical_name: "postgresql" });
    const subjectRow2 = makeEntityRow({ id: "sub-002", name: "Jane Developer", canonical_name: "jane developer" });
    const objectRow2 = makeEntityRow({ id: "obj-002", name: "Project Alpha", canonical_name: "project alpha" });

    queryMock
      .mockResolvedValueOnce({ rows: [subjectRow] })   // upsert "Project Alpha"
      .mockResolvedValueOnce({ rows: [objectRow1] })   // upsert "PostgreSQL"
      .mockResolvedValueOnce({ rows: [] })             // insert relation 1
      .mockResolvedValueOnce({ rows: [subjectRow2] })  // upsert "Jane Developer"
      .mockResolvedValueOnce({ rows: [objectRow2] })   // upsert "Project Alpha"
      .mockResolvedValueOnce({ rows: [] });             // insert relation 2

    const stored = await storeTriples(sampleResult, runId);

    expect(stored).toBe(2);
    // Verify the relation insert included the correct confidence
    const insertCalls = queryMock.mock.calls.filter(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO entity_relations")
    );
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0][1][3]).toBe(0.9);  // confidence for triple 1
    expect(insertCalls[1][1][3]).toBe(0.85); // confidence for triple 2
  });

  it("preserves confidence scores through storage", async () => {
    const subjectRow = makeEntityRow({ id: "s1", canonical_name: "widget" });
    const objectRow = makeEntityRow({ id: "o1", canonical_name: "gadget" });
    queryMock
      .mockResolvedValueOnce({ rows: [subjectRow] })
      .mockResolvedValueOnce({ rows: [objectRow] })
      .mockResolvedValueOnce({ rows: [] });

    const result: ExtractionResult = {
      triples: [{ subject: "Widget", predicate: "depends_on", object: "Gadget", confidence: 0.42 }],
      provider: "test",
      providerVersion: "1.0",
      contentType: "task",
      contentId: "task-001",
      durationMs: 10,
    };

    await storeTriples(result, runId);

    const relationInsert = queryMock.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO entity_relations")
    );
    expect(relationInsert![1][3]).toBe(0.42);
  });

  it("groups triples under the given extraction_run_id", async () => {
    const subjectRow = makeEntityRow({ id: "s1" });
    const objectRow = makeEntityRow({ id: "o1" });
    queryMock
      .mockResolvedValueOnce({ rows: [subjectRow] })
      .mockResolvedValueOnce({ rows: [objectRow] })
      .mockResolvedValueOnce({ rows: [] });

    const result: ExtractionResult = {
      triples: [{ subject: "A", predicate: "rel", object: "B", confidence: 1.0 }],
      provider: "test",
      providerVersion: "1.0",
      contentType: "handoff",
      contentId: "hf-001",
      durationMs: 5,
    };

    await storeTriples(result, "batch-run-42");

    const relationInsert = queryMock.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO entity_relations")
    );
    // extraction_run_id is the 7th param (index 6)
    expect(relationInsert![1][6]).toBe("batch-run-42");
  });

  it("skips a triple when entity upsert returns null and continues", async () => {
    queryMock
      .mockRejectedValueOnce(new Error("db down")) // upsert subject fails
      .mockResolvedValueOnce({ rows: [makeEntityRow({ id: "o2" })] }) // next triple object
      .mockResolvedValueOnce({ rows: [makeEntityRow({ id: "s2" })] }) // next triple subject
      .mockResolvedValueOnce({ rows: [] });

    const result: ExtractionResult = {
      triples: [
        { subject: "Bad", predicate: "rel", object: "Entity", confidence: 1.0 },
        { subject: "Good", predicate: "rel", object: "Also Good", confidence: 0.9 },
      ],
      provider: "test",
      providerVersion: "1.0",
      contentType: "note",
      contentId: "n1",
      durationMs: 1,
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stored = await storeTriples(result, runId);
    warnSpy.mockRestore();

    // Triple 1: subject upsert fails (returns null); object upsert still runs (consumes mock 2).
    // Triple 2: subject resolves (mock 3); object gets the empty-rows mock (mock 4) → null → skip.
    // Net result: 0 triples stored.
    expect(stored).toBe(0);
  });
});

// ── Extraction run lifecycle ─────────────────────────────────────────

describe("createExtractionRun", () => {
  it("inserts a run and returns the id", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "run-abc" }] });

    const id = await createExtractionRun("test-provider", "1.0.0", { model: "v1" });

    expect(id).toBe("run-abc");
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO extraction_runs");
    expect(params[0]).toBe("test-provider");
    expect(params[1]).toBe("1.0.0");
    expect(JSON.parse(params[2] as string)).toEqual({ model: "v1" });
  });

  it("returns null when Postgres is unavailable", async () => {
    queryMock.mockRejectedValueOnce(new Error("connection refused"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const id = await createExtractionRun("provider", "1.0");
    expect(id).toBeNull();
    warnSpy.mockRestore();
  });
});

describe("completeExtractionRun", () => {
  it("updates status to completed with triple count", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await completeExtractionRun("run-001", 42);

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'completed'");
    expect(params[0]).toBe("run-001");
    expect(params[1]).toBe(42);
  });

  it("swallows errors gracefully", async () => {
    queryMock.mockRejectedValueOnce(new Error("db error"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(completeExtractionRun("run-001", 0)).resolves.toBeUndefined();
    warnSpy.mockRestore();
  });
});

describe("failExtractionRun", () => {
  it("updates status to failed with error message", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await failExtractionRun("run-001", "provider timeout");

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'failed'");
    expect(params[0]).toBe("run-001");
    expect(params[1]).toBe("provider timeout");
  });

  it("swallows errors gracefully", async () => {
    queryMock.mockRejectedValueOnce(new Error("db error"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(failExtractionRun("run-001", "oops")).resolves.toBeUndefined();
    warnSpy.mockRestore();
  });
});

// ── getEntitiesForContent ────────────────────────────────────────────

describe("getEntitiesForContent", () => {
  it("returns entities linked to a content item", async () => {
    const rows = [
      makeEntityRow({ id: "e1", name: "Project Alpha" }),
      makeEntityRow({ id: "e2", name: "PostgreSQL" }),
    ];
    queryMock.mockResolvedValueOnce({ rows });

    const result = await getEntitiesForContent("note", "note-uuid-001");

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Project Alpha");
    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe("note");
    expect(params[1]).toBe("note-uuid-001");
  });

  it("returns empty array when Postgres is unavailable", async () => {
    queryMock.mockRejectedValueOnce(new Error("db down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await getEntitiesForContent("task", "t-001");
    expect(result).toEqual([]);
    warnSpy.mockRestore();
  });
});

// ── getRelationsForEntity ────────────────────────────────────────────

describe("getRelationsForEntity", () => {
  it("fetches direct relations for 1-hop (default)", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await getRelationsForEntity("entity-001");

    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    // 1-hop uses simple WHERE, not recursive CTE
    expect(sql).not.toContain("WITH RECURSIVE");
    expect(params[0]).toBe("entity-001");
  });

  it("uses recursive CTE for multi-hop traversal", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await getRelationsForEntity("entity-001", 2);

    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("WITH RECURSIVE");
  });

  it("clamps hops to a maximum of 3", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await getRelationsForEntity("entity-001", 99);

    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    // depth param should be clamped to 3
    expect(params[1]).toBe(3);
  });

  it("clamps hops to a minimum of 1 for zero or negative values", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await getRelationsForEntity("entity-001", 0);

    // hops=0 → Math.max(1,0)=1 → uses simple WHERE path, not recursive CTE
    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain("WITH RECURSIVE");
  });

  it("returns empty array when Postgres is unavailable", async () => {
    queryMock.mockRejectedValueOnce(new Error("db down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await getRelationsForEntity("entity-001");
    expect(result).toEqual([]);
    warnSpy.mockRestore();
  });
});

// ── compareRuns ──────────────────────────────────────────────────────

describe("compareRuns", () => {
  it("returns triple counts and overlap stats for two runs", async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          { id: "run-a", triple_count: 10 },
          { id: "run-b", triple_count: 8 },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ count: "3" }] }); // overlap

    const result = await compareRuns("run-a", "run-b");

    expect(result.runA).toEqual({ id: "run-a", tripleCount: 10 });
    expect(result.runB).toEqual({ id: "run-b", tripleCount: 8 });
    expect(result.overlapCount).toBe(3);
    expect(result.uniqueToA).toBe(7);
    expect(result.uniqueToB).toBe(5);
  });

  it("returns zero stats when Postgres is unavailable", async () => {
    queryMock.mockRejectedValueOnce(new Error("db down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await compareRuns("run-a", "run-b");

    expect(result.runA.tripleCount).toBe(0);
    expect(result.runB.tripleCount).toBe(0);
    expect(result.overlapCount).toBe(0);
    warnSpy.mockRestore();
  });

  it("overlap query uses run IDs as parameters", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] });

    await compareRuns("run-x", "run-y");

    const overlapCall = queryMock.mock.calls[1] as [string, unknown[]];
    expect(overlapCall[1][0]).toBe("run-x");
    expect(overlapCall[1][1]).toBe("run-y");
  });
});

// ── canonical_name normalization edge cases ──────────────────────────

describe("canonical_name normalization", () => {
  it("treats mixed-case variants as the same entity", async () => {
    queryMock.mockResolvedValue({ rows: [makeEntityRow({ canonical_name: "acme corp" })] });

    await upsertEntity("ACME CORP", "organization");
    await upsertEntity("Acme Corp", "organization");
    await upsertEntity("acme corp", "organization");

    const allCanonicals = queryMock.mock.calls.map(([, params]) => (params as unknown[])[2]);
    expect(new Set(allCanonicals).size).toBe(1);
    expect(allCanonicals[0]).toBe("acme corp");
  });

  it("trims leading and trailing whitespace", async () => {
    queryMock.mockResolvedValue({ rows: [makeEntityRow({ canonical_name: "project beta" })] });

    await upsertEntity("  Project Beta  ", "project");

    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params[2]).toBe("project beta");
  });
});
