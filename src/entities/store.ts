/**
 * Entity graph storage layer.
 *
 * Handles upsert of entity_nodes, insertion of entity_relations, and
 * lifecycle management of extraction_runs. All functions degrade gracefully
 * when Postgres is unavailable (log warning, return empty/null).
 */

import { query } from "../db/client.js";
import type { ExtractionResult } from "./types.js";

// ── Row types ────────────────────────────────────────────────────────

interface EntityNodeRow {
  id: string;
  name: string;
  entity_type: string;
  canonical_name: string;
  first_seen: string;
  last_seen: string;
  mention_count: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface RelationRow {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  confidence: number;
  provider: string;
  provider_version: string | null;
  extraction_run_id: string | null;
  source_content_type: string;
  source_content_id: string;
  context_snippet: string | null;
  created_at: string;
}

interface ExtractionRunRow {
  id: string;
  provider: string;
  provider_version: string | null;
  status: string;
  content_scope: string | null;
  /** Reserved — not yet written by any function; always 0 until a batch API is added. */
  content_count: number;
  triple_count: number;
  started_at: string;
  completed_at: string | null;
  config: Record<string, unknown>;
  error: string | null;
}

// ── Entity upsert ────────────────────────────────────────────────────

export async function upsertEntity(
  name: string,
  entityType: string,
  metadata: Record<string, unknown> = {}
): Promise<EntityNodeRow | null> {
  const canonicalName = name.toLowerCase().trim();
  try {
    // ON CONFLICT intentionally does not merge metadata — the initial metadata
    // (usually from the first extraction) is preserved as written; bumping the
    // mention counter and refreshing last_seen is sufficient for deduplication.
    const result = await query<EntityNodeRow>(
      `INSERT INTO entity_nodes (name, entity_type, canonical_name, metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (canonical_name, entity_type) DO UPDATE
         SET mention_count = entity_nodes.mention_count + 1,
             last_seen = NOW(),
             name = EXCLUDED.name
       RETURNING *`,
      [name, entityType, canonicalName, JSON.stringify(metadata)]
    );
    return result.rows[0] ?? null;
  } catch (err) {
    console.warn("[entity-store] upsertEntity failed:", (err as Error).message);
    return null;
  }
}

// ── Triple storage ───────────────────────────────────────────────────

export async function storeTriples(
  result: ExtractionResult,
  runId: string
): Promise<number> {
  // Not transactional: a failed relation INSERT after a successful entity upsert
  // leaves bumped mention_count/last_seen with no corresponding relation.
  // Acceptable for v1; fix by wrapping in a BEGIN/COMMIT block if needed.
  let stored = 0;
  for (const triple of result.triples) {
    try {
      // Use caller-supplied entity types when available so the same canonical name
      // can exist as multiple types (e.g. "Python" as "language" vs "project").
      const subjectEntity = await upsertEntity(triple.subject, triple.subjectType ?? "concept");
      const objectEntity = await upsertEntity(triple.object, triple.objectType ?? "concept");
      if (!subjectEntity || !objectEntity) continue;

      await query(
        `INSERT INTO entity_relations (
           source_entity_id, target_entity_id, relation_type, confidence,
           provider, provider_version, extraction_run_id,
           source_content_type, source_content_id, context_snippet
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          subjectEntity.id,
          objectEntity.id,
          triple.predicate,
          triple.confidence,
          result.provider,
          result.providerVersion,
          runId,
          result.contentType,
          result.contentId,
          triple.contextSnippet ?? null,
        ]
      );
      stored++;
    } catch (err) {
      console.warn(
        "[entity-store] storeTriples: failed to store triple:",
        (err as Error).message
      );
    }
  }
  return stored;
}

// ── Extraction run lifecycle ─────────────────────────────────────────

export async function createExtractionRun(
  provider: string,
  providerVersion: string,
  config: Record<string, unknown> = {}
): Promise<string | null> {
  try {
    const result = await query<{ id: string }>(
      `INSERT INTO extraction_runs (provider, provider_version, config)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id`,
      [provider, providerVersion, JSON.stringify(config)]
    );
    return result.rows[0]?.id ?? null;
  } catch (err) {
    console.warn(
      "[entity-store] createExtractionRun failed:",
      (err as Error).message
    );
    return null;
  }
}

export async function completeExtractionRun(
  runId: string,
  tripleCount: number
): Promise<void> {
  try {
    await query(
      `UPDATE extraction_runs
       SET status = 'completed', completed_at = NOW(), triple_count = $2
       WHERE id = $1`,
      [runId, tripleCount]
    );
  } catch (err) {
    console.warn(
      "[entity-store] completeExtractionRun failed:",
      (err as Error).message
    );
  }
}

export async function failExtractionRun(
  runId: string,
  error: string
): Promise<void> {
  try {
    await query(
      `UPDATE extraction_runs
       SET status = 'failed', completed_at = NOW(), error = $2
       WHERE id = $1`,
      [runId, error]
    );
  } catch (err) {
    console.warn(
      "[entity-store] failExtractionRun failed:",
      (err as Error).message
    );
  }
}

// ── Retrieval ────────────────────────────────────────────────────────

export async function getEntitiesForContent(
  contentType: string,
  contentId: string
): Promise<EntityNodeRow[]> {
  try {
    const result = await query<EntityNodeRow>(
      `SELECT DISTINCT en.*
       FROM entity_nodes en
       JOIN entity_relations er
         ON er.source_entity_id = en.id OR er.target_entity_id = en.id
       WHERE er.source_content_type = $1
         AND er.source_content_id = $2::uuid`,
      [contentType, contentId]
    );
    return result.rows;
  } catch (err) {
    console.warn(
      "[entity-store] getEntitiesForContent failed:",
      (err as Error).message
    );
    return [];
  }
}

export async function getRelationsForEntity(
  entityId: string,
  hops = 1
): Promise<RelationRow[]> {
  // Clamp hops to a safe maximum to avoid runaway recursive queries.
  const depth = Math.min(Math.max(1, hops), 3);
  try {
    if (depth === 1) {
      const result = await query<RelationRow>(
        `SELECT * FROM entity_relations
         WHERE source_entity_id = $1 OR target_entity_id = $1
         ORDER BY created_at DESC`,
        [entityId]
      );
      return result.rows;
    }

    // Multi-hop traversal via recursive CTE. The path array prevents cycles.
    const result = await query<RelationRow>(
      `WITH RECURSIVE traversal AS (
         SELECT
           er.id, er.source_entity_id, er.target_entity_id, er.relation_type,
           er.confidence, er.provider, er.provider_version, er.extraction_run_id,
           er.source_content_type, er.source_content_id, er.context_snippet,
           er.created_at,
           1 AS depth,
           ARRAY[er.id] AS visited
         FROM entity_relations er
         WHERE er.source_entity_id = $1 OR er.target_entity_id = $1

         UNION ALL

         SELECT
           er2.id, er2.source_entity_id, er2.target_entity_id, er2.relation_type,
           er2.confidence, er2.provider, er2.provider_version, er2.extraction_run_id,
           er2.source_content_type, er2.source_content_id, er2.context_snippet,
           er2.created_at,
           t.depth + 1,
           t.visited || er2.id
         FROM entity_relations er2
         JOIN traversal t
           ON er2.source_entity_id = t.target_entity_id
              OR er2.target_entity_id = t.source_entity_id
         WHERE t.depth < $2
           AND NOT er2.id = ANY(t.visited)
       )
       SELECT DISTINCT
         id, source_entity_id, target_entity_id, relation_type,
         confidence, provider, provider_version, extraction_run_id,
         source_content_type, source_content_id, context_snippet, created_at
       FROM traversal
       ORDER BY created_at DESC`,
      [entityId, depth]
    );
    return result.rows;
  } catch (err) {
    console.warn(
      "[entity-store] getRelationsForEntity failed:",
      (err as Error).message
    );
    return [];
  }
}

// ── Graph candidate retrieval ────────────────────────────────────────

export interface GraphPathStep {
  entityName: string;
  relation: string;
  hops: number;
}

export interface GraphCandidate {
  contentType: string;
  contentId: string;
  score: number;
  path: GraphPathStep[];
}

interface GraphCandidateRow {
  source_content_type: string;
  source_content_id: string;
  min_hops: number;
  max_confidence: number;
  path_count: number;
  total_score: number;
  // Aggregated path metadata for explanation
  example_entity_name: string | null;
  example_relation_type: string | null;
}

/**
 * Traverse entity_relations up to `hops` levels from the given entity IDs and
 * return content (handoff/note/task/artifact) candidates ranked by graph
 * relevance.
 *
 * Score formula:
 *   per-row contribution = relation.confidence * (1 / hop_distance) * mention_weight
 *   final score = sum(contributions for this content) / path_count
 *
 * where mention_weight = ln(1 + mention_count) so very popular entities don't
 * fully dominate but are still favored.
 *
 * Cycle prevention: the recursive walk tracks visited entity IDs in a path
 * array and refuses to re-enter them. Hops are clamped to [1, 3].
 */
export async function getGraphCandidates(
  entityIds: string[],
  hops: number,
  limit: number
): Promise<GraphCandidate[]> {
  if (entityIds.length === 0 || limit <= 0) return [];
  const depth = Math.min(Math.max(1, hops), 3);
  const cappedLimit = Math.min(Math.max(1, limit), 500);

  try {
    // The CTE walks entity → relation → entity, accumulating one "candidate
    // row" per (content, source entity) it touches. Aggregation outside the
    // recursion picks the best (min hops, max confidence) per content_id and
    // sums per-path contributions.
    const sql = `
      WITH RECURSIVE graph_walk AS (
        -- Seed: any relation that touches one of the matched entities.
        SELECT
          er.source_content_type,
          er.source_content_id,
          er.confidence,
          er.relation_type,
          1 AS hop_distance,
          ARRAY[er.source_entity_id, er.target_entity_id]::uuid[] AS visited,
          CASE
            WHEN er.source_entity_id = ANY($1::uuid[]) THEN er.source_entity_id
            ELSE er.target_entity_id
          END AS seed_entity_id,
          CASE
            WHEN er.source_entity_id = ANY($1::uuid[]) THEN er.target_entity_id
            ELSE er.source_entity_id
          END AS frontier_entity_id
        FROM entity_relations er
        WHERE er.source_entity_id = ANY($1::uuid[])
           OR er.target_entity_id = ANY($1::uuid[])

        UNION ALL

        -- Recurse: from the current frontier entity, follow any relation that
        -- leads to an entity we haven't visited yet.
        SELECT
          er.source_content_type,
          er.source_content_id,
          er.confidence,
          er.relation_type,
          gw.hop_distance + 1,
          gw.visited || (CASE
            WHEN er.source_entity_id = gw.frontier_entity_id THEN er.target_entity_id
            ELSE er.source_entity_id
          END),
          gw.seed_entity_id,
          CASE
            WHEN er.source_entity_id = gw.frontier_entity_id THEN er.target_entity_id
            ELSE er.source_entity_id
          END
        FROM entity_relations er
        JOIN graph_walk gw ON (
          er.source_entity_id = gw.frontier_entity_id
          OR er.target_entity_id = gw.frontier_entity_id
        )
        WHERE gw.hop_distance < $2
          AND NOT (CASE
            WHEN er.source_entity_id = gw.frontier_entity_id THEN er.target_entity_id
            ELSE er.source_entity_id
          END = ANY(gw.visited))
      ),
      enriched AS (
        SELECT
          gw.source_content_type,
          gw.source_content_id,
          gw.confidence,
          gw.relation_type,
          gw.hop_distance,
          gw.visited,
          en.name AS entity_name,
          en.mention_count
        FROM graph_walk gw
        LEFT JOIN entity_nodes en ON en.id = gw.seed_entity_id
      )
      SELECT
        source_content_type,
        source_content_id,
        MIN(hop_distance) AS min_hops,
        MAX(confidence) AS max_confidence,
        -- Count distinct walks (collapse path expansions that visit the same
        -- set of entities) so popular nodes don't inflate the divisor below.
        COUNT(DISTINCT array_to_string(visited, ',')) AS path_count,
        SUM(
          confidence
          * (1.0 / hop_distance)
          * LN(1 + COALESCE(mention_count, 1))
        ) AS total_score,
        (ARRAY_AGG(entity_name ORDER BY hop_distance ASC, confidence DESC))[1] AS example_entity_name,
        (ARRAY_AGG(relation_type ORDER BY hop_distance ASC, confidence DESC))[1] AS example_relation_type
      FROM enriched
      GROUP BY source_content_type, source_content_id
      ORDER BY total_score DESC, min_hops ASC
      LIMIT $3
    `;

    const result = await query<GraphCandidateRow>(sql, [entityIds, depth, cappedLimit]);

    return result.rows.map((row) => {
      const pathCount = Number(row.path_count) || 1;
      const totalScore = Number(row.total_score) || 0;
      const score = totalScore / pathCount;
      const step: GraphPathStep = {
        entityName: row.example_entity_name ?? "",
        relation: row.example_relation_type ?? "",
        hops: Number(row.min_hops) || 1,
      };
      return {
        contentType: row.source_content_type,
        contentId: row.source_content_id,
        score,
        path: [step],
      };
    });
  } catch (err) {
    console.warn(
      "[entity-store] getGraphCandidates failed:",
      (err as Error).message
    );
    return [];
  }
}

// ── Run comparison ───────────────────────────────────────────────────

export interface RunComparison {
  runA: { id: string; tripleCount: number };
  runB: { id: string; tripleCount: number };
  overlapCount: number;
  uniqueToA: number;
  uniqueToB: number;
}

export async function compareRuns(
  runIdA: string,
  runIdB: string
): Promise<RunComparison> {
  const fallback: RunComparison = {
    runA: { id: runIdA, tripleCount: 0 },
    runB: { id: runIdB, tripleCount: 0 },
    overlapCount: 0,
    uniqueToA: 0,
    uniqueToB: 0,
  };
  try {
    const runsResult = await query<Pick<ExtractionRunRow, "id" | "triple_count">>(
      `SELECT id, triple_count FROM extraction_runs WHERE id = ANY($1::uuid[])`,
      [[runIdA, runIdB]]
    );
    const runMap = new Map(runsResult.rows.map((r) => [r.id, r.triple_count]));

    // Overlap: triples sharing the same (src canonical, tgt canonical, relation_type)
    const overlapResult = await query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM (
         SELECT
           sn.canonical_name AS src_canonical,
           tn.canonical_name AS tgt_canonical,
           er_a.relation_type
         FROM entity_relations er_a
         JOIN entity_nodes sn ON sn.id = er_a.source_entity_id
         JOIN entity_nodes tn ON tn.id = er_a.target_entity_id
         WHERE er_a.extraction_run_id = $1
       ) a
       INNER JOIN (
         SELECT
           sn.canonical_name AS src_canonical,
           tn.canonical_name AS tgt_canonical,
           er_b.relation_type
         FROM entity_relations er_b
         JOIN entity_nodes sn ON sn.id = er_b.source_entity_id
         JOIN entity_nodes tn ON tn.id = er_b.target_entity_id
         WHERE er_b.extraction_run_id = $2
       ) b USING (src_canonical, tgt_canonical, relation_type)`,
      [runIdA, runIdB]
    );
    const overlapCount = parseInt(overlapResult.rows[0]?.count ?? "0", 10);

    const runATriples = runMap.get(runIdA) ?? 0;
    const runBTriples = runMap.get(runIdB) ?? 0;

    return {
      runA: { id: runIdA, tripleCount: runATriples },
      runB: { id: runIdB, tripleCount: runBTriples },
      overlapCount,
      uniqueToA: Math.max(0, runATriples - overlapCount),
      uniqueToB: Math.max(0, runBTriples - overlapCount),
    };
  } catch (err) {
    console.warn("[entity-store] compareRuns failed:", (err as Error).message);
    return fallback;
  }
}
