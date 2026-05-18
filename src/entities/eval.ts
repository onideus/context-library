/**
 * Retrieval-quality measurement for graph-augmented search.
 *
 * `measureGraphImpact` runs each query twice — once with the entity-graph
 * signal threaded in and once without — then reports per-query and aggregate
 * precision@k, recall@k, and mean reciprocal rank. The caller supplies a
 * ground-truth map of query -> relevant content IDs, derived from manual
 * labeling or from synthetic test data.
 *
 * Implementation note: the harness owns a local `runSearch` that mirrors the
 * SQL and weighting in src/tools/search.ts. This duplication is a known
 * drift risk — if production search changes, this file must be updated in
 * lockstep. Failures in any single query are captured per-query so the rest
 * of the suite still produces a comparison.
 */

import { config } from "../config.js";
import { recognizeEntities } from "./recognizer.js";
import { getGraphCandidates } from "./store.js";
import { generateEmbedding, isEmbeddingAvailable } from "../embeddings/client.js";
import { query as dbQuery } from "../db/client.js";
import { expandQuery } from "../tools/search-aliases.js";

export interface RetrievalMetrics {
  perQuery: PerQueryMetric[];
  aggregate: {
    enabled: AggregateMetric;
    disabled: AggregateMetric;
    delta: AggregateMetric;
    improvedCount: number;
    degradedCount: number;
    unchangedCount: number;
  };
  k: number;
}

export interface AggregateMetric {
  precisionAtK: number;
  recallAtK: number;
  mrr: number;
}

export interface PerQueryMetric {
  query: string;
  expected: string[];
  enabled: { ids: string[]; metrics: AggregateMetric };
  disabled: { ids: string[]; metrics: AggregateMetric };
  delta: AggregateMetric;
  improved: boolean;
}

export interface MeasureOptions {
  k?: number;
  limit?: number;
  similarityThreshold?: number;
}

interface HybridRow {
  content_id: string;
  semantic_rank: number | null;
  fulltext_rank: number | null;
}

function precisionAtK(retrievedIds: string[], relevantIds: Set<string>, k: number): number {
  if (k === 0) return 0;
  const slice = retrievedIds.slice(0, k);
  if (slice.length === 0) return 0;
  const hits = slice.filter((id) => relevantIds.has(id)).length;
  return hits / k;
}

function recallAtK(retrievedIds: string[], relevantIds: Set<string>, k: number): number {
  if (relevantIds.size === 0) return 0;
  const slice = retrievedIds.slice(0, k);
  const hits = slice.filter((id) => relevantIds.has(id)).length;
  return hits / relevantIds.size;
}

function reciprocalRank(retrievedIds: string[], relevantIds: Set<string>): number {
  for (let i = 0; i < retrievedIds.length; i++) {
    if (relevantIds.has(retrievedIds[i])) return 1 / (i + 1);
  }
  return 0;
}

function emptyAggregate(): AggregateMetric {
  return { precisionAtK: 0, recallAtK: 0, mrr: 0 };
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Run the hybrid retrieval pipeline directly (vector + FTS + optional graph)
 * and return content IDs in ranked order. This bypasses the MCP tool layer
 * but uses the same SQL and graph functions, making the eval representative
 * of production search behavior.
 */
async function runSearch(
  queryText: string,
  graphEnabled: boolean,
  limit: number,
  similarityThreshold: number
): Promise<string[]> {
  const expanded = expandQuery(queryText);
  const embedding = await generateEmbedding(`search_query: ${expanded}`);
  const pgVector = `[${embedding.join(",")}]`;

  const sql = `
    WITH semantic AS (
      SELECT id, content_id,
             ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
      FROM embeddings
      WHERE 1 - (embedding <=> $1::vector) >= $2
      ORDER BY embedding <=> $1::vector
      LIMIT 100
    ),
    fulltext AS (
      SELECT id,
             ROW_NUMBER() OVER (
               ORDER BY ts_rank(to_tsvector('english', content_text),
                                websearch_to_tsquery('english', $3)) DESC
             ) AS rank
      FROM embeddings
      WHERE to_tsvector('english', content_text) @@ websearch_to_tsquery('english', $3)
      LIMIT 100
    )
    SELECT s.content_id::text AS content_id,
           s.rank AS semantic_rank,
           f.rank AS fulltext_rank
    FROM semantic s
    LEFT JOIN fulltext f ON s.id = f.id
  `;

  const result = await dbQuery<HybridRow>(sql, [pgVector, similarityThreshold, expanded]);
  const rows = result.rows;

  // Weighted RRF (vector + fts always, graph only when enabled)
  const wVec = config.entityGraphVectorWeight;
  const wFts = config.entityGraphFtsWeight;
  const wGraph = config.entityGraphRrfWeight;

  const graphRankMap = new Map<string, number>();
  if (graphEnabled) {
    const recognized = await recognizeEntities(queryText);
    if (recognized.length > 0) {
      const cands = await getGraphCandidates(
        recognized.map((r) => r.id),
        config.entityGraphHops,
        config.entityGraphMaxCandidates
      );
      cands.forEach((c, idx) => {
        graphRankMap.set(c.contentId, idx + 1);
      });
    }
  }

  const scored = rows.map((r) => {
    const semTerm = r.semantic_rank != null ? wVec * (1 / (60 + Number(r.semantic_rank))) : 0;
    const ftsTerm = r.fulltext_rank != null ? wFts * (1 / (60 + Number(r.fulltext_rank))) : 0;
    const gRank = graphRankMap.get(r.content_id);
    const graphTerm = gRank ? wGraph * (1 / (60 + gRank)) : 0;
    return { id: r.content_id, score: semTerm + ftsTerm + graphTerm };
  });

  // Include graph-only candidates not in the FTS/vector set so they can compete
  if (graphEnabled) {
    const seen = new Set(scored.map((s) => s.id));
    for (const [cid, rank] of graphRankMap) {
      if (!seen.has(cid)) {
        scored.push({ id: cid, score: wGraph * (1 / (60 + rank)) });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.id);
}

export async function measureGraphImpact(
  queries: string[],
  groundTruth: Map<string, string[]>,
  options: MeasureOptions = {}
): Promise<RetrievalMetrics> {
  const k = options.k ?? 5;
  const limit = options.limit ?? Math.max(k, 10);
  const similarityThreshold = options.similarityThreshold ?? 0.15;

  if (!(await isEmbeddingAvailable())) {
    throw new Error(
      "measureGraphImpact: embedding server unavailable — eval requires a working TEI endpoint"
    );
  }

  const perQuery: PerQueryMetric[] = [];

  for (const q of queries) {
    const expected = groundTruth.get(q) ?? [];
    const relevant = new Set(expected);

    let enabledIds: string[] = [];
    let disabledIds: string[] = [];
    try {
      enabledIds = await runSearch(q, true, limit, similarityThreshold);
    } catch (err) {
      console.warn(`[eval] query "${q}" failed (enabled):`, (err as Error).message);
    }
    try {
      disabledIds = await runSearch(q, false, limit, similarityThreshold);
    } catch (err) {
      console.warn(`[eval] query "${q}" failed (disabled):`, (err as Error).message);
    }

    const enabledMetrics: AggregateMetric = {
      precisionAtK: precisionAtK(enabledIds, relevant, k),
      recallAtK: recallAtK(enabledIds, relevant, k),
      mrr: reciprocalRank(enabledIds, relevant),
    };
    const disabledMetrics: AggregateMetric = {
      precisionAtK: precisionAtK(disabledIds, relevant, k),
      recallAtK: recallAtK(disabledIds, relevant, k),
      mrr: reciprocalRank(disabledIds, relevant),
    };
    const delta: AggregateMetric = {
      precisionAtK: enabledMetrics.precisionAtK - disabledMetrics.precisionAtK,
      recallAtK: enabledMetrics.recallAtK - disabledMetrics.recallAtK,
      mrr: enabledMetrics.mrr - disabledMetrics.mrr,
    };

    const improved =
      delta.precisionAtK > 0 || delta.recallAtK > 0 || delta.mrr > 0;

    perQuery.push({
      query: q,
      expected,
      enabled: { ids: enabledIds, metrics: enabledMetrics },
      disabled: { ids: disabledIds, metrics: disabledMetrics },
      delta,
      improved,
    });
  }

  if (perQuery.length === 0) {
    return {
      perQuery,
      aggregate: {
        enabled: emptyAggregate(),
        disabled: emptyAggregate(),
        delta: emptyAggregate(),
        improvedCount: 0,
        degradedCount: 0,
        unchangedCount: 0,
      },
      k,
    };
  }

  const enabledAgg: AggregateMetric = {
    precisionAtK: mean(perQuery.map((q) => q.enabled.metrics.precisionAtK)),
    recallAtK: mean(perQuery.map((q) => q.enabled.metrics.recallAtK)),
    mrr: mean(perQuery.map((q) => q.enabled.metrics.mrr)),
  };
  const disabledAgg: AggregateMetric = {
    precisionAtK: mean(perQuery.map((q) => q.disabled.metrics.precisionAtK)),
    recallAtK: mean(perQuery.map((q) => q.disabled.metrics.recallAtK)),
    mrr: mean(perQuery.map((q) => q.disabled.metrics.mrr)),
  };
  const aggDelta: AggregateMetric = {
    precisionAtK: enabledAgg.precisionAtK - disabledAgg.precisionAtK,
    recallAtK: enabledAgg.recallAtK - disabledAgg.recallAtK,
    mrr: enabledAgg.mrr - disabledAgg.mrr,
  };

  let improvedCount = 0;
  let degradedCount = 0;
  let unchangedCount = 0;
  for (const q of perQuery) {
    const sumDelta = q.delta.precisionAtK + q.delta.recallAtK + q.delta.mrr;
    if (sumDelta > 0) improvedCount++;
    else if (sumDelta < 0) degradedCount++;
    else unchangedCount++;
  }

  return {
    perQuery,
    aggregate: {
      enabled: enabledAgg,
      disabled: disabledAgg,
      delta: aggDelta,
      improvedCount,
      degradedCount,
      unchangedCount,
    },
    k,
  };
}

// Exported for unit testing the pure metric helpers.
export const __testOnly = {
  precisionAtK,
  recallAtK,
  reciprocalRank,
  mean,
};
