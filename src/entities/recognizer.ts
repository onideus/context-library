/**
 * Query entity recognition for graph-augmented retrieval.
 *
 * Given a free-text query, return the entity_nodes whose canonical_name appears
 * in the query as a standalone word. Fast path: if entity_nodes is empty (no
 * extraction has run), return [] without further work so search_context can
 * skip the graph signal entirely.
 *
 * Matching uses the same word-boundary semantics as src/tools/entities.ts so a
 * 2-char canonical name (e.g. "CB") doesn't false-positive against "SCBRS".
 */
import { matchesWordBoundary } from "../tools/entities.js";

export interface RecognizedEntity {
  id: string;
  canonicalName: string;
  entityType: string;
  mentionCount: number;
}

interface EntityNodeRow {
  id: string;
  canonical_name: string;
  entity_type: string;
  mention_count: number;
}

export async function recognizeEntities(
  query: string
): Promise<RecognizedEntity[]> {
  if (!query || query.trim().length === 0) return [];

  let queryFn: (text: string, params?: unknown[]) => Promise<{ rows: EntityNodeRow[] }>;
  try {
    const mod = await import("../db/client.js");
    queryFn = mod.query;
  } catch {
    return [];
  }

  let rows: EntityNodeRow[];
  try {
    // Pull all canonical names. At single-user scale entity_nodes typically
    // has < 10k rows and a full scan beats per-row LIKE in round-trip cost.
    // TODO: when entity_nodes grows past ~10k rows, switch to a server-side
    // WHERE canonical_name ~* '<alternation>' to avoid pulling the full table.
    const result = await queryFn(
      `SELECT id, canonical_name, entity_type, mention_count FROM entity_nodes`
    );
    rows = result.rows;
  } catch {
    return [];
  }

  if (rows.length === 0) return [];

  const matched: RecognizedEntity[] = [];
  // Track (canonical_name, entity_type) pairs we've already added so multiple
  // mention-count rows of the same canonical/type don't yield dup matches.
  const seen = new Set<string>();
  for (const row of rows) {
    // matchesWordBoundary rejects empty/single-character names internally.
    if (!matchesWordBoundary(query, row.canonical_name)) continue;
    const key = `${row.canonical_name}::${row.entity_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matched.push({
      id: row.id,
      canonicalName: row.canonical_name,
      entityType: row.entity_type,
      mentionCount: row.mention_count,
    });
  }
  return matched;
}
