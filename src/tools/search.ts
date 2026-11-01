import { z } from "zod";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import { pool, query } from "../db/client.js";
import { generateEmbedding, isEmbeddingAvailable, rerankResults } from "../embeddings/client.js";
import { drainPendingEmbeddings } from "../embeddings/indexer.js";
import { lookupEntities, computeEnvelope, emptyEnvelope, generateBoundaryNotice } from "./entities.js";
import { expandQuery } from "./search-aliases.js";
import { recognizeEntities, type RecognizedEntity } from "../entities/recognizer.js";
import { getGraphCandidates, type GraphCandidate } from "../entities/store.js";
import type { EffectiveNoteStatus } from "../notes/store.js";
import {
  isMissingLifecycleSchemaError,
  keepShownNotices,
  lifecycleNextStep,
  noteLifecycleFilterSql,
  notesInScope,
  redirectNoteRows,
  type LifecycleNotice,
} from "../notes/lifecycle-search.js";

/**
 * Normalize text for fingerprinting: lowercase, collapse whitespace, take first 500 chars, then SHA-256.
 */
function contentFingerprint(text: string): string {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 500);
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Extract timestamp from source_file for chronological sorting.
 * Filenames are like: 2026-03-21T23-12-37-052Z-abcd1234.json
 * Returns the string for lexicographic comparison (ISO-ish format sorts correctly).
 */
function sourceFileTimestamp(sourceFile: string): string {
  // Extract the timestamp portion before the UUID suffix
  const match = sourceFile.match(/^(\d{4}-\d{2}-\d{2}T[\d-]+Z)/);
  return match ? match[1] : "9999"; // unknown files sort last
}

export interface SearchResultRow {
  content_type: string;
  content_id: string;
  content_text: string;
  metadata: Record<string, unknown>;
  similarity?: number;
  rrf_score?: number;
  semantic_rank?: number | null;
  fulltext_rank?: number | null;
  graph_rank?: number | null;
  graph_score?: number;
  graph_path?: GraphCandidate["path"];
  // Note lifecycle annotations, set by the redirect step (notes only).
  /** Note ids that matched and were redirected to this note; [] when it matched directly. */
  matched_via?: string[];
  /** Computed lifecycle status: active | superseded | expired. */
  note_status?: EffectiveNoteStatus;
  superseded_by?: string | null;
  superseded_at?: string | null;
  valid_until?: string | null;
  /** Title of the direct successor; null unless the note is superseded. */
  successor_title?: string | null;
  /**
   * Text a cross-encoder should score instead of `content_text`: set on a
   * redirected head that did not itself match, to the wording of the
   * candidate that did. Internal - never returned to the caller.
   */
  rerank_text?: string;
}

/**
 * Apply weighted Reciprocal Rank Fusion across three retrieval signals:
 * semantic (vector), full-text, and entity-graph. Each signal contributes
 * `w_i * 1 / (60 + rank_i)`; a missing rank contributes zero. The result is
 * written back onto `row.rrf_score` and graph metadata is attached when the
 * row appeared in `graphRankMap`.
 *
 * Pure function — no I/O — so the fusion math can be unit-tested in
 * isolation from the SQL/query layer.
 */
export interface FusionWeights {
  vector: number;
  fulltext: number;
  graph: number;
}

export interface GraphRankEntry {
  rank: number;
  cand: GraphCandidate;
}

export function fuseRrf(
  rows: SearchResultRow[],
  graphRankMap: Map<string, GraphRankEntry>,
  weights: FusionWeights
): { contributed: boolean; matchedKeys: Set<string> } {
  let contributed = false;
  const matchedKeys = new Set<string>();
  for (const r of rows) {
    const key = `${r.content_type}::${r.content_id}`;
    matchedKeys.add(key);
    const semRank = r.semantic_rank ?? null;
    const ftsRank = r.fulltext_rank ?? null;
    const graphMatch = graphRankMap.get(key);

    const semTerm = semRank != null ? weights.vector * (1.0 / (60 + Number(semRank))) : 0;
    const ftsTerm = ftsRank != null ? weights.fulltext * (1.0 / (60 + Number(ftsRank))) : 0;
    const graphTerm = graphMatch ? weights.graph * (1.0 / (60 + graphMatch.rank)) : 0;
    r.rrf_score = semTerm + ftsTerm + graphTerm;
    if (graphMatch) {
      r.graph_rank = graphMatch.rank;
      r.graph_score = graphMatch.cand.score;
      r.graph_path = graphMatch.cand.path;
      contributed = true;
    }
  }
  return { contributed, matchedKeys };
}

/**
 * Deduplicate search results by content fingerprint, keeping the oldest source_file.
 * Returns { deduped, preDedupCount }.
 *
 * Note rows are the exception: two notes with DIFFERENT content_ids are two
 * facts and are never collapsed into one, even when their first 500
 * characters match. A copy-and-edit successor must not be dropped in favour
 * of the stale note it replaces (or vice versa). When a fingerprint group
 * holds two or more distinct notes, every one of them survives, and the
 * group's non-note rows are kept alongside them (collapsed among themselves
 * exactly as before) - the new rule never drops a handoff, task, or artifact.
 * A group with at most one note, and every group without notes, behaves
 * exactly as before.
 */
export function deduplicateResults(rows: SearchResultRow[]): { deduped: SearchResultRow[]; preDedupCount: number } {
  const preDedupCount = rows.length;
  const groups = new Map<string, SearchResultRow[]>();

  for (const row of rows) {
    const fp = contentFingerprint(row.content_text ?? "");
    if (!groups.has(fp)) {
      groups.set(fp, []);
    }
    groups.get(fp)!.push(row);
  }

  const deduped: SearchResultRow[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      deduped.push(group[0]);
      continue;
    }

    // Distinct notes (by content_id) are never collapsed against each other.
    const distinctNotes = new Map<string, SearchResultRow>();
    for (const row of group) {
      if (row.content_type === "note" && !distinctNotes.has(row.content_id)) {
        distinctNotes.set(row.content_id, row);
      }
    }
    // Keep the row with the oldest source_file
    const oldestFirst = (members: SearchResultRow[]): SearchResultRow[] =>
      members.sort((a, b) => {
        const aFile = (a.metadata?.source_file as string) ?? "";
        const bFile = (b.metadata?.source_file as string) ?? "";
        if (!aFile && !bFile) return 0;
        if (!aFile) return -1; // no source_file = keep first encountered
        if (!bFile) return 1;
        return sourceFileTimestamp(aFile).localeCompare(sourceFileTimestamp(bFile));
      });

    if (distinctNotes.size >= 2) {
      deduped.push(...distinctNotes.values());
      const others = group.filter((r) => r.content_type !== "note");
      if (others.length > 0) deduped.push(oldestFirst(others)[0]);
      continue;
    }

    deduped.push(oldestFirst(group)[0]);
  }

  return { deduped, preDedupCount };
}

export interface SearchContextSqlInput {
  /** pgvector literal of the query embedding, e.g. "[0.1,0.2,...]". */
  pgVector: string;
  threshold: number;
  /** Text for websearch_to_tsquery (hybrid only). */
  ftsQuery: string;
  hybrid: boolean;
  contentTypes?: string[];
  /** ISO dates; compared against metadata stored_at / created_at. */
  after?: string;
  before?: string;
  overFetchLimit: number;
  /** Keep COMPUTED-expired notes as candidates. Default false. */
  includeExpired?: boolean;
  /**
   * Omit the note lifecycle filter even when notes are in scope. Used only to
   * retry after the database reports the lifecycle columns/table missing
   * (migration 013 not applied) so search degrades instead of failing.
   */
  omitLifecycleFilter?: boolean;
}

/**
 * Assemble the candidate-selection SQL for search_context. Pure (no I/O) so
 * the statement can be exercised against Postgres without an embedding server.
 *
 * Param layout: hybrid  -> $1 vector, $2 threshold, $3 ftsQuery,
 *               pure    -> $1 vector, $2 threshold,
 * then (optionally) content_types, then date params, then the final limit.
 * The lifecycle filter takes no parameters.
 *
 * Lifecycle (design section 6.3): when notes are in scope, every embeddings
 * query gets `AND (content_type <> 'note' OR content_id IN (SELECT id::text
 * FROM notes WHERE ...))` - a hashed subquery, never a join, so the HNSW
 * index-ordered scan survives. Superseded notes remain candidates (they are
 * redirected afterwards, see redirectNoteRows), so include_superseded does not
 * change this SQL; include_expired only relaxes the predicate. Orphaned
 * embeddings (note row deleted) drop in both cases. A superseded note stays a
 * candidate even if its own valid_until has passed (supersession wins over
 * expiry). A search whose content_types excludes notes never references
 * `notes`. `lifecycleFilterApplied` reports whether the filter is in the SQL.
 */
export function buildSearchContextSql(
  input: SearchContextSqlInput
): { sql: string; params: unknown[]; lifecycleFilterApplied: boolean } {
  const { pgVector, threshold, ftsQuery, hybrid, contentTypes, after, before, overFetchLimit } = input;

  // Date-range filter fragment + params. Applies to both the vector and FTS
  // sides so filtered-out rows don't consume candidate slots before RRF
  // fusion. Handoffs use stored_at; tasks and notes use created_at - all live
  // in metadata JSONB.
  const dateParams: string[] = [];
  const dateClauses: string[] = [];
  if (after) {
    dateParams.push(after);
    const p = `$DATE${dateParams.length}`;
    dateClauses.push(
      `COALESCE((metadata->>'stored_at')::timestamptz, (metadata->>'created_at')::timestamptz) >= ${p}::timestamptz`
    );
  }
  if (before) {
    dateParams.push(before);
    const p = `$DATE${dateParams.length}`;
    dateClauses.push(
      `COALESCE((metadata->>'stored_at')::timestamptz, (metadata->>'created_at')::timestamptz) <= ${p}::timestamptz`
    );
  }
  const dateFilter = dateClauses.length ? ` AND ${dateClauses.join(" AND ")}` : "";

  const lifecycleClause = noteLifecycleFilterSql({
    notesInScope: notesInScope(contentTypes) && !input.omitLifecycleFilter,
    includeExpired: input.includeExpired ?? false,
  });
  const lifecycleFilterApplied = lifecycleClause !== "";

  const params: unknown[] = hybrid ? [pgVector, threshold, ftsQuery] : [pgVector, threshold];
  const contentTypesIdx = contentTypes?.length ? params.length + 1 : null;
  if (contentTypesIdx) params.push(contentTypes);
  const dateStartIdx = params.length + 1;
  params.push(...dateParams);
  const finalLimitIdx = params.length + 1;
  params.push(overFetchLimit);

  const contentTypesClause = contentTypesIdx
    ? `AND content_type = ANY($${contentTypesIdx}::text[])`
    : "";
  const resolvedDateFilter = dateFilter.replace(/\$DATE(\d+)/g, (_m, n) => `$${dateStartIdx + parseInt(n, 10) - 1}`);

  if (hybrid) {
    const sql = `
            WITH semantic AS (
              SELECT id, content_type, content_id,
                     LEFT(content_text, 500) as content_text, metadata,
                     1 - (embedding <=> $1::vector) as similarity,
                     ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
              FROM embeddings
              WHERE 1 - (embedding <=> $1::vector) >= $2
              ${contentTypesClause}
              ${resolvedDateFilter}
              ${lifecycleClause}
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
              ${contentTypesClause}
              ${resolvedDateFilter}
              ${lifecycleClause}
              LIMIT 100
            )
            SELECT s.content_type, s.content_id, s.content_text, s.metadata, s.similarity,
                   s.rank AS semantic_rank,
                   f.rank AS fulltext_rank,
                   COALESCE(1.0/(60 + s.rank), 0) + COALESCE(1.0/(60 + f.rank), 0) AS rrf_score
            FROM semantic s
            LEFT JOIN fulltext f ON s.id = f.id
            ORDER BY rrf_score DESC
            LIMIT $${finalLimitIdx}
          `;
    return { sql, params, lifecycleFilterApplied };
  }

  // Pure vector search - over-fetch for dedup headroom
  const sql = `
            SELECT content_type, content_id,
                   LEFT(content_text, 500) as content_text, metadata,
                   1 - (embedding <=> $1::vector) as similarity
            FROM embeddings
            WHERE 1 - (embedding <=> $1::vector) >= $2
            ${contentTypesClause}
            ${resolvedDateFilter}
            ${lifecycleClause}
            ORDER BY embedding <=> $1::vector
            LIMIT $${finalLimitIdx}
          `;
  return { sql, params, lifecycleFilterApplied };
}

/**
 * Fetch embeddings rows for graph-only candidates (content the entity graph
 * surfaced but neither FTS nor vector retrieved), by exact (type, id). Params:
 * $1 = content types, $2 = content ids (parallel arrays). The lifecycle filter
 * is added exactly when a requested key is a note, so a fetch that cannot
 * return a note never touches `notes`.
 */
export function buildGraphOnlyFetchSql(
  types: readonly string[],
  opts: { includeExpired?: boolean; omitLifecycleFilter?: boolean } = {}
): string {
  const lifecycleClause = noteLifecycleFilterSql({
    notesInScope: types.includes("note") && !opts.omitLifecycleFilter,
    includeExpired: opts.includeExpired ?? false,
  });
  return `
                SELECT content_type, content_id,
                       LEFT(content_text, 500) AS content_text, metadata
                FROM embeddings
                WHERE (content_type, content_id::text) IN (
                  SELECT unnest($1::text[]), unnest($2::text[])
                )
                ${lifecycleClause}
              `;
}

const SEARCH_CONTEXT_DESCRIPTION = `Semantic search across all indexed content — handoffs, tasks, notes, artifacts.

CALL THIS WHEN:
- The conversation touches architecture, strategy, infrastructure, pipeline, deployment, or design decisions
- The user references a prior decision, pattern, or constraint ("we decided", "the rule is", "last time")
- The user mentions a named person, device, project, or system by name
- The topic involves career, compensation, hardware, network, medical, or financial context
- You are about to recommend an approach and existing decisions may constrain the answer
- You are about to update an artifact status, create a task, or modify any CB primitive (check existing state first)

DO NOT CALL WHEN:
- The question is general knowledge with no project-specific dimension
- You already retrieved relevant results earlier in this same conversation turn
- The user explicitly says "don't search" or "from memory"

CONSEQUENCE OF SKIPPING: Recommendations will contradict documented decisions. Duplicate work will be created. The user will catch the error and lose trust in the system.

QUERY TIPS: Natural language, include entity names. People: full name. Devices: user's name for it.

Content type guide — what each type contains:
- handoff — what happened in recent sessions, operational history
- note — decisions made, patterns established, lessons learned
- task — action items and their status
- artifact — generated outputs: CC prompts, research, templates, reports

If you know which primitive you want, filter by content_types to reduce noise. If uncertain, run without a filter and let RRF surface what's most relevant.

- after (optional): ISO date — only return results stored after this date
- before (optional): ISO date — only return results stored before this date
Use these to narrow searches to specific time windows (e.g., "what did I decide about X last week"). after/before filter the notes that MATCH; a successor shown by a redirect (see Lifecycle) may lie outside the window - pass include_superseded: true when asking about historical state.

Lifecycle (notes): a note can be superseded by a newer note, or expire (valid_until in the past). By default this tool REDIRECTS: when a superseded note matches, the result for it is replaced by the note that currently stands in its place (the head of its supersession chain), carrying the old note's relevance. That result lists the superseded note id(s) that matched under matched_via, and lifecycle_notices holds one plain-English line per redirect ("Note 2b7c… ('…') matched but was superseded by 9e1a… ('…') on 2026-05-02 — showing the successor."). Expired notes are omitted (a superseded note is redirected even if its own valid_until has passed). If a superseded note matched but its chain ends in an expired note, nothing is shown for it and lifecycle_notices says so ("…which expired on <date>; there is no current version to show") - do not treat the old note as current. Every note result carries note_status (active | superseded | expired), superseded_by, superseded_at, valid_until, successor_title (null unless superseded) and matched_via ([] when the note matched directly). Cite the successor, never the superseded note. READ lifecycle_notices whenever it is non-empty; notices are reported only for notes in the returned page (or candidates that could have made it). redirected is the number of superseded matches that were replaced by a returned successor (several matches can collapse into one successor). Pass include_superseded: true to get superseded notes as themselves (each flagged and noticed), include_expired: true to include expired notes (flagged and noticed). Other content types have no lifecycle and are unaffected.

READ context_envelope FIRST. If boundary_detected=true or constraint_alerts non-empty, address constraints before recommendations.

Returns: {results[], context_envelope, query, total, mode, reranked, reranker_configured, deduplicated, pre_dedup_count, lifecycle_notices[], redirected, next_step}. pre_dedup_count is the candidate count before lifecycle redirection and dedup.

reranker_configured is whether this server has a cross-encoder reranker endpoint set (RERANKER_URL). reranked is whether that reranker actually rescored this response. reranker_configured=false means reranking is off by configuration. reranker_configured=true with reranked=false on a response with more than one result means the reranker is unreachable, timing out, or returning bad data — the server logs a [rerank] warning with the reason. Single-result responses are never reranked.

If results reference events indirectly, reformulate with specific terms, lower threshold (0.05), higher limit (20).

Response Format:
- Reasoning-capable models (extended thinking enabled): Use structured reflection before synthesizing results. Evaluate whether retrieved evidence actually supports the user's question. Note gaps explicitly when results are thin or off-topic.
- Standard inference models: Respond directly using available results. Flag when results seem insufficient and suggest query reformulation.`;

export function registerSearchTools(mcpServer: McpServer): void {
  // \u2500\u2500 search_context \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  mcpServer.tool(
    "search_context",
    SEARCH_CONTEXT_DESCRIPTION,
    {
      query: z.string().describe("Natural language search query"),
      content_types: z
        .array(z.enum(["handoff", "task", "note", "artifact"]))
        .optional()
        .describe("Filter by content type. Default: search all."),
      limit: z
        .number()
        .min(1)
        .max(20)
        .optional()
        .describe("Max results. Default: 5"),
      similarity_threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Minimum cosine similarity. Default: 0.15"),
      hybrid: z
        .boolean()
        .optional()
        .describe("Enable hybrid search (vector + full-text RRF fusion). Default: true"),
      after: z
        .string()
        .optional()
        .describe("ISO date — only return results from content stored after this date"),
      before: z
        .string()
        .optional()
        .describe("ISO date — only return results from content stored before this date"),
      include_superseded: z
        .boolean()
        .optional()
        .describe(
          "Notes only. false (default): a superseded note that matches is replaced by its current successor (see matched_via and lifecycle_notices). true: return superseded notes as themselves, flagged note_status='superseded' with successor_title."
        ),
      include_expired: z
        .boolean()
        .optional()
        .describe(
          "Notes only. false (default): notes whose valid_until has passed are omitted. true: include them, flagged note_status='expired'."
        ),
    },
    async (args) => {
      const available = await isEmbeddingAvailable();
      if (!available) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              message: "Embedding server is not available. Semantic search is offline. Use search_tasks for keyword-based search.",
              code: "EMBEDDING_UNAVAILABLE",
            }),
          }],
        };
      }

      try {
        // Expand known aliases before embedding so abbreviations match corpus text.
        const expandedQuery = expandQuery(args.query);
        // Prepend nomic search_query prefix
        const queryText = `search_query: ${expandedQuery}`;
        const embedding = await generateEmbedding(queryText);

        // Opportunistic drain — TEI just confirmed working. Fire-and-forget.
        drainPendingEmbeddings().catch((err) =>
          console.warn("[search_context] Pending drain failed:", (err as Error).message)
        );
        const limit = args.limit ?? 5;
        const rerankerEnabled = Boolean(config.rerankerUrl);
        // When reranking is enabled we widen the candidate pool so the
        // cross-encoder has more options to reorder. Otherwise keep the
        // original small over-fetch for dedup headroom.
        const overFetchLimit = rerankerEnabled
          ? Math.min(limit * 10, 100)
          : Math.min(limit * 4, 80);
        const threshold = args.similarity_threshold ?? 0.15;
        const useHybrid = args.hybrid ?? true;
        const pgVector = `[${embedding.join(",")}]`;

        const includeSuperseded = args.include_superseded ?? false;
        const includeExpired = args.include_expired ?? false;

        // Candidate SQL (vector / hybrid, date + content-type filters, note
        // lifecycle filter) is assembled by a pure function so it can be
        // tested against Postgres without an embedding server.
        const sqlInput = {
          pgVector,
          threshold,
          ftsQuery: expandedQuery,
          hybrid: useHybrid,
          contentTypes: args.content_types,
          after: args.after,
          before: args.before,
          overFetchLimit,
          includeExpired,
        };
        let candidateSql = buildSearchContextSql(sqlInput);
        let lifecycleUnavailable = false;
        let result;
        try {
          result = await query(candidateSql.sql, candidateSql.params);
        } catch (err) {
          // The lifecycle subquery names notes columns that only exist after
          // migration 013. If the database says they are missing, degrade to
          // an unfiltered search (flagged below) instead of failing every
          // default search. Any other error, or a failure with no lifecycle
          // clause in the SQL, is a real failure and propagates.
          if (!candidateSql.lifecycleFilterApplied || !isMissingLifecycleSchemaError(err)) throw err;
          console.warn(
            "[search_context] note lifecycle schema missing (migration 013 not applied?); retrying without the lifecycle filter:",
            (err as Error).message
          );
          lifecycleUnavailable = true;
          candidateSql = buildSearchContextSql({ ...sqlInput, omitLifecycleFilter: true });
          result = await query(candidateSql.sql, candidateSql.params);
        }
        let rows = result.rows as unknown as SearchResultRow[];

        // ── Graph-augmented retrieval (third RRF signal) ────────────────
        // Only fires when (1) feature flag enabled, (2) hybrid mode, (3)
        // recognized entities in the query, and (4) graph traversal returns
        // at least one candidate. Failure at any step is silent — we fall
        // back to the FTS+vector behavior unchanged.
        let recognizedEntities: RecognizedEntity[] = [];
        let graphCandidates: GraphCandidate[] = [];
        let graphContributed = false;

        if (config.entityGraphEnabled && useHybrid) {
          try {
            recognizedEntities = await recognizeEntities(args.query);
          } catch {
            recognizedEntities = [];
          }
          if (recognizedEntities.length > 0) {
            try {
              graphCandidates = await getGraphCandidates(
                recognizedEntities.map((e) => e.id),
                config.entityGraphHops,
                config.entityGraphMaxCandidates
              );
            } catch {
              graphCandidates = [];
            }
          }
        }

        // Fold graph contribution into rrf_score using weighted RRF.
        // The SQL currently emits rrf_score = 1/(60+sem_rank) + 1/(60+fts_rank)
        // with implicit weight=1 for each. We re-derive it here so the three
        // signals share a single weighted formula. Pure-vector (non-hybrid)
        // mode skips this — it has no rrf_score and we leave similarity-only
        // ranking alone.
        if (useHybrid) {
          const weights: FusionWeights = {
            vector: config.entityGraphVectorWeight,
            fulltext: config.entityGraphFtsWeight,
            graph: config.entityGraphRrfWeight,
          };
          // (content_type, content_id) -> graph rank (1-based)
          const graphRankMap = new Map<string, GraphRankEntry>();
          graphCandidates.forEach((c, idx) => {
            graphRankMap.set(`${c.contentType}::${c.contentId}`, { rank: idx + 1, cand: c });
          });

          const fusion = fuseRrf(rows, graphRankMap, weights);
          if (fusion.contributed) graphContributed = true;

          // Graph-only candidates: content that the graph surfaced but neither
          // FTS nor vector retrieved. Fetch their text/metadata so they can
          // join the result set rather than be silently dropped.
          const graphOnlyKeys = [...graphRankMap.keys()].filter((k) => !fusion.matchedKeys.has(k));
          if (graphOnlyKeys.length > 0) {
            const types: string[] = [];
            const ids: string[] = [];
            for (const k of graphOnlyKeys) {
              const sep = k.indexOf("::");
              types.push(k.slice(0, sep));
              ids.push(k.slice(sep + 2));
            }
            try {
              const extraSql = buildGraphOnlyFetchSql(types, {
                includeExpired,
                omitLifecycleFilter: lifecycleUnavailable,
              });
              const extraResult = await query<{
                content_type: string;
                content_id: string;
                content_text: string;
                metadata: Record<string, unknown>;
              }>(extraSql, [types, ids]);
              for (const row of extraResult.rows) {
                const key = `${row.content_type}::${row.content_id}`;
                const match = graphRankMap.get(key);
                if (!match) continue;
                const graphTerm = weights.graph * (1.0 / (60 + match.rank));
                rows.push({
                  content_type: row.content_type,
                  content_id: row.content_id,
                  content_text: row.content_text,
                  metadata: row.metadata,
                  similarity: 0,
                  rrf_score: graphTerm,
                  semantic_rank: null,
                  fulltext_rank: null,
                  graph_rank: match.rank,
                  graph_score: match.cand.score,
                  graph_path: match.cand.path,
                });
                graphContributed = true;
              }
            } catch (err) {
              console.warn(
                "[search_context] graph-only fetch failed:",
                (err as Error).message
              );
            }
          }
        }

        // Candidate count before lifecycle redirection and dedup.
        const candidateCount = rows.length;

        // ── Note lifecycle: redirect, do not hide ───────────────────────
        // Superseded note candidates are replaced by the head of their chain
        // (design section 6.1). Runs after candidate selection - including
        // graph-only rows - and BEFORE dedup so a successor and a stale copy
        // are judged as the distinct notes they are. Notices are structured
        // so they can be pruned after dedup/truncation: a notice may only
        // describe a note the response actually returns.
        let lifecycleNotices: LifecycleNotice[] = [];
        const systemNotices: string[] = [];
        if (lifecycleUnavailable) {
          systemNotices.push(
            "Note lifecycle filtering unavailable (migration 013 not applied); superseded/expired notes are not filtered."
          );
        } else {
          try {
            const redirect = await redirectNoteRows(pool, rows, { includeSuperseded, includeExpired });
            rows = redirect.rows;
            lifecycleNotices = redirect.notices;
          } catch (err) {
            // The candidate query already succeeded, so the lifecycle schema
            // exists: this is a transient failure of the follow-up lookups.
            // Return the candidates un-annotated, and say so.
            console.warn("[search_context] note lifecycle redirect failed:", (err as Error).message);
            systemNotices.push(
              "Note lifecycle annotations unavailable (lifecycle lookup failed); superseded or expired notes in these results may be unflagged."
            );
          }
        }

        if (rows.length === 0) {
          // Nothing is shown, so only notices about dropped candidates that
          // could have made the page remain true.
          const kept = keepShownNotices(lifecycleNotices, new Set<string>(), limit);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                results: [],
                message: "No results found. Try broadening your query or lowering the similarity threshold.",
                lifecycle_notices: [...kept.map((n) => n.text), ...systemNotices],
                redirected: 0,
                total: 0,
                ...(kept.length > 0
                  ? {
                      next_step:
                        "Notes matched but none is current - read lifecycle_notices before creating a new note on this topic. " +
                        lifecycleNextStep(kept),
                    }
                  : {}),
                query: args.query,
                mode: useHybrid ? "hybrid" : "vector",
                reranked: false,
                reranker_configured: rerankerEnabled,
                deduplicated: true,
                pre_dedup_count: candidateCount,
                context_envelope: emptyEnvelope(),
              }),
            }],
          };
        }

        // Deduplicate: collapse near-identical content to oldest source
        const { deduped } = deduplicateResults(rows);

        // Re-sort by original ranking and truncate to requested limit
        const sortKey = useHybrid ? "rrf_score" : "similarity";
        deduped.sort((a, b) => {
          const aVal = sortKey === "rrf_score" ? (a.rrf_score ?? 0) : (a.similarity ?? 0);
          const bVal = sortKey === "rrf_score" ? (b.rrf_score ?? 0) : (b.similarity ?? 0);
          return bVal - aVal;
        });

        // Optional cross-encoder rerank stage. We hand the deduped candidate
        // pool to the reranker, which rescores every candidate against the
        // original user query. On success we reorder by reranker score; on
        // any failure (network, timeout, malformed response) we silently
        // fall back to the fusion ordering above. A redirected head is scored
        // on the wording that actually matched (rerank_text), not on its own
        // text, so the cross-encoder does not demote the rows the redirect
        // exists for.
        let reranked = false;
        let workingRows = deduped;
        if (rerankerEnabled && deduped.length > 1) {
          const texts = deduped.map((r) => r.rerank_text ?? r.content_text ?? "");
          const scores = await rerankResults(args.query, texts);
          if (scores && scores.length > 0) {
            const scoreByIndex = new Map<number, number>();
            for (const s of scores) scoreByIndex.set(s.index, s.score);
            workingRows = [...deduped].sort((a, b) => {
              const ai = deduped.indexOf(a);
              const bi = deduped.indexOf(b);
              return (scoreByIndex.get(bi) ?? -Infinity) - (scoreByIndex.get(ai) ?? -Infinity);
            });
            // Attach rerank_score to each row for response transparency.
            for (let i = 0; i < deduped.length; i++) {
              const rr = scoreByIndex.get(i);
              if (rr !== undefined) {
                (deduped[i] as SearchResultRow & { rerank_score?: number }).rerank_score = rr;
              }
            }
            reranked = true;
          }
        }
        const finalRows = workingRows.slice(0, limit);

        // Keep only the lifecycle notices that are still true of the page
        // actually returned (dedup and truncation can remove a head that a
        // redirect notice refers to).
        const shownNoteIds = new Set(finalRows.filter((r) => r.content_type === "note").map((r) => r.content_id));
        const keptNotices = keepShownNotices(lifecycleNotices, shownNoteIds, limit);
        const redirectedCount = keptNotices.filter((n) => n.kind === "redirect").length;

        // Compute context envelope from entity matches (best-effort)
        const resultTexts = finalRows.map((r) => r.content_text ?? "");
        let envelope;
        try {
          const entities = await lookupEntities(resultTexts);
          envelope = computeEnvelope(entities);
        } catch {
          envelope = emptyEnvelope();
        }

        // Superseded/expired notes (returned only on request) are not "prior decisions".
        const noteResults = finalRows.filter(
          (r) => r.content_type === "note" && r.note_status !== "superseded" && r.note_status !== "expired"
        );
        const artifactResults = finalRows.filter(r => r.content_type === 'artifact');

        const formatIds = (ids: string[]) => {
          const MAX = 5;
          if (ids.length <= MAX) return ids.join(", ");
          return `${ids.slice(0, MAX).join(", ")} (+${ids.length - MAX} more)`;
        };

        let nextStep = "Cite relevant content_ids in your response.";
        if (noteResults.length > 0) {
          const noteIds = formatIds(noteResults.map(r => r.content_id));
          nextStep += ` Notes found (${noteIds}) -- these contain prior decisions. Do not contradict them without explicit user override.`;
        }
        if (artifactResults.length > 0) {
          const artifactIds = formatIds(artifactResults.map(r => r.content_id));
          nextStep += ` Artifacts found (${artifactIds}) -- check their status before creating related work.`;
        }
        const lifecycleStep = lifecycleNextStep(keptNotices);
        if (lifecycleStep) nextStep += ` ${lifecycleStep}`;

        const responseData: Record<string, unknown> = {
          results: finalRows.map((r: SearchResultRow & { rerank_score?: number }) => ({
            content_type: r.content_type,
            content_id: r.content_id,
            content_text: r.content_text,
            metadata: r.metadata,
            similarity: Math.round((r.similarity ?? 0) * 1000) / 1000,
            ...(r.rrf_score ? { rrf_score: Math.round(r.rrf_score * 10000) / 10000 } : {}),
            ...(r.rerank_score !== undefined
              ? { rerank_score: Math.round(r.rerank_score * 10000) / 10000 }
              : {}),
            ...(r.graph_rank != null
              ? {
                  graph_rank: r.graph_rank,
                  graph_score: Math.round((r.graph_score ?? 0) * 10000) / 10000,
                  graph_path: r.graph_path,
                }
              : {}),
            ...(r.metadata?.chunk_index != null ? { chunk_index: r.metadata.chunk_index } : {}),
            ...(r.metadata?.source_file ? { source_file: r.metadata.source_file } : {}),
            ...(r.content_type === "note"
              ? {
                  note_status: r.note_status ?? null,
                  superseded_by: r.superseded_by ?? null,
                  superseded_at: r.superseded_at ?? null,
                  valid_until: r.valid_until ?? null,
                  successor_title: r.successor_title ?? null,
                  matched_via: r.matched_via ?? [],
                }
              : {}),
          })),
          query: args.query,
          total: finalRows.length,
          mode: useHybrid ? "hybrid" : "vector",
          reranked,
          reranker_configured: rerankerEnabled,
          deduplicated: true,
          pre_dedup_count: candidateCount,
          lifecycle_notices: [...keptNotices.map((n) => n.text), ...systemNotices],
          redirected: redirectedCount,
          context_envelope: envelope,
          next_step: nextStep,
        };

        // Only surface entity_matches when graph actually fired and contributed
        // candidates. Clutters responses otherwise.
        if (graphContributed && recognizedEntities.length > 0) {
          // candidate_count = how many graph candidates surfaced for this
          // entity. NOT the entity's total relation count in entity_relations —
          // use list_entities for that.
          const candidateCounts = new Map<string, number>();
          for (const c of graphCandidates) {
            for (const step of c.path) {
              if (!step.entityName) continue;
              candidateCounts.set(
                step.entityName,
                (candidateCounts.get(step.entityName) ?? 0) + 1
              );
            }
          }
          responseData.entity_matches = {
            graph_contributed: true,
            entities: recognizedEntities.map((e) => ({
              name: e.canonicalName,
              type: e.entityType,
              candidate_count: candidateCounts.get(e.canonicalName) ?? 0,
            })),
          };
        }

        // Build MCP content array — prepend boundary notice if detected
        const contentItems: { type: "text"; text: string }[] = [];
        const boundaryNotice = generateBoundaryNotice(envelope);
        if (boundaryNotice) {
          contentItems.push({ type: "text" as const, text: boundaryNotice });
        }
        contentItems.push({ type: "text" as const, text: JSON.stringify(responseData) });

        return { content: contentItems };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              message: `Search failed: ${(err as Error).message}`,
              code: "SEARCH_ERROR",
            }),
          }],
        };
      }
    }
  );
}
