import { describe, it, expect, vi, beforeEach } from "vitest";
import { recognizeEntities } from "../../entities/recognizer.js";

const queryMock = vi.fn();
vi.mock("../../db/client.js", () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

beforeEach(() => {
  queryMock.mockReset();
});

describe("recognizeEntities", () => {
  it("fast path: returns empty when query is empty or whitespace", async () => {
    const out = await recognizeEntities("   ");
    expect(out).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("fast path: returns empty array when entity_nodes is empty", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const out = await recognizeEntities("anything goes here");
    expect(out).toEqual([]);
  });

  it("matches a canonical name as a standalone word (case-insensitive)", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: "ent-1",
          canonical_name: "Project Alpha",
          entity_type: "project",
          mention_count: 5,
        },
      ],
    });
    const out = await recognizeEntities("Working on project alpha today");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "ent-1",
      canonicalName: "Project Alpha",
      entityType: "project",
      mentionCount: 5,
    });
  });

  it("uses word boundaries — does not match substrings", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { id: "ent-1", canonical_name: "Ian", entity_type: "person", mention_count: 3 },
      ],
    });
    // "Ian" is a substring of "Iranian" and "guardian", should not match
    const out = await recognizeEntities("Investigating guardian RBAC and Iranian timezones");
    expect(out).toEqual([]);
  });

  it("skips single-character canonical names (too ambiguous)", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { id: "ent-1", canonical_name: "A", entity_type: "concept", mention_count: 1 },
      ],
    });
    const out = await recognizeEntities("A short test of the system");
    expect(out).toEqual([]);
  });

  it("returns multiple entities when query mentions several", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { id: "ent-1", canonical_name: "PostgreSQL", entity_type: "technology", mention_count: 10 },
        { id: "ent-2", canonical_name: "Hono", entity_type: "technology", mention_count: 4 },
        { id: "ent-3", canonical_name: "Acme Corp", entity_type: "organization", mention_count: 1 },
      ],
    });
    const out = await recognizeEntities("Migrating from Express to Hono on PostgreSQL");
    const names = out.map((e) => e.canonicalName).sort();
    expect(names).toEqual(["Hono", "PostgreSQL"]);
  });

  it("deduplicates identical (canonical_name, entity_type) pairs", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { id: "ent-1", canonical_name: "Python", entity_type: "language", mention_count: 5 },
        // simulate a stray dup row with same canonical+type but different id
        { id: "ent-1b", canonical_name: "Python", entity_type: "language", mention_count: 2 },
      ],
    });
    const out = await recognizeEntities("Python rewrite ongoing");
    expect(out).toHaveLength(1);
    expect(out[0].canonicalName).toBe("Python");
  });

  it("keeps multiple types for the same canonical name", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { id: "ent-lang", canonical_name: "Python", entity_type: "language", mention_count: 8 },
        { id: "ent-proj", canonical_name: "Python", entity_type: "project", mention_count: 2 },
      ],
    });
    const out = await recognizeEntities("Looking at Python code");
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.entityType).sort()).toEqual(["language", "project"]);
  });

  it("returns empty array when DB query fails", async () => {
    queryMock.mockRejectedValueOnce(new Error("connection refused"));
    const out = await recognizeEntities("Working on Project Alpha");
    expect(out).toEqual([]);
  });
});
