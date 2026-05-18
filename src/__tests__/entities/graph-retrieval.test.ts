import { describe, it, expect, vi, beforeEach } from "vitest";
import { getGraphCandidates } from "../../entities/store.js";

const queryMock = vi.fn();
vi.mock("../../db/client.js", () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

beforeEach(() => {
  queryMock.mockReset();
});

function makeCandidateRow(overrides: Partial<{
  source_content_type: string;
  source_content_id: string;
  min_hops: number;
  max_confidence: number;
  path_count: number;
  total_score: number;
  example_entity_name: string;
  example_relation_type: string;
}> = {}) {
  return {
    source_content_type: overrides.source_content_type ?? "handoff",
    source_content_id: overrides.source_content_id ?? "content-001",
    min_hops: overrides.min_hops ?? 1,
    max_confidence: overrides.max_confidence ?? 0.9,
    path_count: overrides.path_count ?? 1,
    total_score: overrides.total_score ?? 0.5,
    example_entity_name: overrides.example_entity_name ?? "Project Alpha",
    example_relation_type: overrides.example_relation_type ?? "uses",
  };
}

describe("getGraphCandidates", () => {
  it("returns [] when entityIds is empty (no query)", async () => {
    const out = await getGraphCandidates([], 1, 50);
    expect(out).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns [] when limit is zero or negative", async () => {
    const out = await getGraphCandidates(["e1"], 1, 0);
    expect(out).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("issues a single recursive query with depth clamped to [1,3]", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await getGraphCandidates(["e1", "e2"], 99, 25);
    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    // params: [entityIds, depth, limit]
    expect(params[0]).toEqual(["e1", "e2"]);
    expect(params[1]).toBe(3);
    expect(params[2]).toBe(25);
  });

  it("clamps hops upward when caller passes 0 or negative", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await getGraphCandidates(["e1"], 0, 10);
    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBe(1);
  });

  it("clamps limit to a sane maximum (500)", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await getGraphCandidates(["e1"], 1, 99_999);
    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params[2]).toBe(500);
  });

  it("uses WITH RECURSIVE for traversal", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await getGraphCandidates(["e1"], 2, 10);
    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("WITH RECURSIVE");
  });

  it("maps DB rows into GraphCandidate shape", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        makeCandidateRow({
          source_content_type: "note",
          source_content_id: "note-001",
          min_hops: 1,
          max_confidence: 0.95,
          path_count: 2,
          total_score: 1.6,
          example_entity_name: "Project Alpha",
          example_relation_type: "uses",
        }),
        makeCandidateRow({
          source_content_type: "handoff",
          source_content_id: "handoff-002",
          min_hops: 2,
          max_confidence: 0.7,
          path_count: 1,
          total_score: 0.35,
          example_entity_name: "PostgreSQL",
          example_relation_type: "depends_on",
        }),
      ],
    });
    const out = await getGraphCandidates(["e1"], 2, 50);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      contentType: "note",
      contentId: "note-001",
      score: 0.8, // total_score / path_count = 1.6 / 2
    });
    expect(out[0].path[0]).toMatchObject({
      entityName: "Project Alpha",
      relation: "uses",
      hops: 1,
    });
    expect(out[1].contentId).toBe("handoff-002");
    expect(out[1].score).toBeCloseTo(0.35);
  });

  it("returns [] gracefully when the DB query fails", async () => {
    queryMock.mockRejectedValueOnce(new Error("relation does not exist"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await getGraphCandidates(["e1"], 1, 10);
    expect(out).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("handles null path_count / total_score without NaN", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          source_content_type: "task",
          source_content_id: "task-001",
          min_hops: 1,
          max_confidence: 0,
          path_count: 0,
          total_score: null,
          example_entity_name: null,
          example_relation_type: null,
        },
      ],
    });
    const out = await getGraphCandidates(["e1"], 1, 10);
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(0);
    expect(Number.isNaN(out[0].score)).toBe(false);
  });
});
