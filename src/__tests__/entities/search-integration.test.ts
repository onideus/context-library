import { describe, it, expect } from "vitest";
import { fuseRrf, type GraphRankEntry, type SearchResultRow } from "../../tools/search.js";
import type { GraphCandidate } from "../../entities/store.js";

/**
 * Tests for the weighted RRF fusion that combines vector, full-text, and
 * entity-graph rank signals. These exercise the pure logic that drives
 * search_context's ranking — no DB or embedding server required.
 */

function makeRow(overrides: {
  content_id: string;
  content_type?: string;
  semantic_rank?: number | null;
  fulltext_rank?: number | null;
}): SearchResultRow {
  return {
    content_type: overrides.content_type ?? "note",
    content_id: overrides.content_id,
    content_text: `text for ${overrides.content_id}`,
    metadata: {},
    similarity: 0.8,
    semantic_rank: overrides.semantic_rank ?? null,
    fulltext_rank: overrides.fulltext_rank ?? null,
  };
}

function makeGraphRank(rank: number, contentType: string, contentId: string): GraphRankEntry {
  const cand: GraphCandidate = {
    contentType,
    contentId,
    score: 0.5,
    path: [{ entityName: "Project Alpha", relation: "uses", hops: 1 }],
  };
  return { rank, cand };
}

describe("fuseRrf — weighted three-signal fusion", () => {
  it("reproduces unweighted-equivalent score when only vector+fts apply (no graph)", () => {
    const rows = [makeRow({ content_id: "a", semantic_rank: 1, fulltext_rank: 2 })];
    const { contributed } = fuseRrf(rows, new Map(), {
      vector: 1,
      fulltext: 1,
      graph: 0.3,
    });
    expect(contributed).toBe(false);
    const expected = 1 / (60 + 1) + 1 / (60 + 2);
    expect(rows[0].rrf_score).toBeCloseTo(expected, 6);
  });

  it("ignores graph weight when no graph candidates supplied", () => {
    const rows = [makeRow({ content_id: "a", semantic_rank: 5, fulltext_rank: null })];
    fuseRrf(rows, new Map(), { vector: 1, fulltext: 1, graph: 0.9 });
    expect(rows[0].rrf_score).toBeCloseTo(1 / (60 + 5), 6);
  });

  it("adds a weighted graph contribution when a row matches the graph map", () => {
    const rows = [makeRow({ content_id: "a", semantic_rank: 1, fulltext_rank: 1 })];
    const graphMap = new Map([[`note::a`, makeGraphRank(1, "note", "a")]]);
    const { contributed } = fuseRrf(rows, graphMap, {
      vector: 1,
      fulltext: 1,
      graph: 0.5,
    });
    expect(contributed).toBe(true);
    const expected = 1 / 61 + 1 / 61 + 0.5 * (1 / 61);
    expect(rows[0].rrf_score).toBeCloseTo(expected, 6);
    expect(rows[0].graph_rank).toBe(1);
    expect(rows[0].graph_path?.[0].entityName).toBe("Project Alpha");
  });

  it("scales each signal independently via its weight", () => {
    const rows = [makeRow({ content_id: "a", semantic_rank: 1, fulltext_rank: 1 })];
    const graphMap = new Map([[`note::a`, makeGraphRank(1, "note", "a")]]);
    fuseRrf(rows, graphMap, { vector: 0, fulltext: 0, graph: 1 });
    // Only the graph contribution should remain
    expect(rows[0].rrf_score).toBeCloseTo(1 / 61, 6);
  });

  it("does not attach graph metadata for rows that don't match the graph map", () => {
    const rows = [
      makeRow({ content_id: "a", semantic_rank: 1, fulltext_rank: 1 }),
      makeRow({ content_id: "b", semantic_rank: 2, fulltext_rank: 2 }),
    ];
    const graphMap = new Map([[`note::a`, makeGraphRank(1, "note", "a")]]);
    fuseRrf(rows, graphMap, { vector: 1, fulltext: 1, graph: 0.3 });
    expect(rows[0].graph_rank).toBe(1);
    expect(rows[1].graph_rank).toBeUndefined();
  });

  it("reports contributed=false when graph map is empty", () => {
    const rows = [makeRow({ content_id: "a", semantic_rank: 1, fulltext_rank: 2 })];
    const out = fuseRrf(rows, new Map(), { vector: 1, fulltext: 1, graph: 0.3 });
    expect(out.contributed).toBe(false);
    expect(out.matchedKeys.has("note::a")).toBe(true);
  });

  it("graph-only rows (no semantic/fulltext rank) get score = w_graph / (60 + g_rank)", () => {
    // Simulates a row pushed into the result set because graph surfaced it.
    const rows = [
      makeRow({ content_id: "x", semantic_rank: null, fulltext_rank: null }),
    ];
    const graphMap = new Map([[`note::x`, makeGraphRank(3, "note", "x")]]);
    fuseRrf(rows, graphMap, { vector: 1, fulltext: 1, graph: 0.5 });
    expect(rows[0].rrf_score).toBeCloseTo(0.5 * (1 / 63), 6);
  });

  it("higher graph weight can promote a graph-only row above a vector-only row", () => {
    const rows = [
      makeRow({ content_id: "vec_only", semantic_rank: 50, fulltext_rank: null }),
      makeRow({ content_id: "graph_only", semantic_rank: null, fulltext_rank: null }),
    ];
    const graphMap = new Map([[`note::graph_only`, makeGraphRank(1, "note", "graph_only")]]);
    fuseRrf(rows, graphMap, { vector: 1, fulltext: 1, graph: 1 });
    // vec_only: 1/110 ≈ 0.0091
    // graph_only: 1/61 ≈ 0.0164
    expect(rows[1].rrf_score!).toBeGreaterThan(rows[0].rrf_score!);
  });
});
