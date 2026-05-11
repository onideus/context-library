import { z } from "zod";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import { query } from "../db/client.js";
import { generateEmbedding, isEmbeddingAvailable, rerankResults } from "../embeddings/client.js";
import { indexAllHandoffs, indexAllTasks, indexAllNotes, indexAllArtifacts, drainPendingEmbeddings } from "../embeddings/indexer.js";
import { lookupEntities, computeEnvelope, emptyEnvelope, generateBoundaryNotice } from "./entities.js";
import { expandQuery } from "./search-aliases.js";

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

interface SearchResultRow {
  content_type: string;
  content_id: string;
  content_text: string;
  metadata: Record<string, unknown>;
  similarity?: number;
  rrf_score?: number;
}

/**
 * Deduplicate search results by content fingerprint, keeping the oldest source_file.
 * Returns { deduped, preDedupCount }.
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
    } else {
      // Keep the row with the oldest source_file
      group.sort((a, b) => {
        const aFile = (a.metadata?.source_file as string) ?? "";
        const bFile = (b.metadata?.source_file as string) ?? "";
        if (!aFile && !bFile) return 0;
        if (!aFile) return -1; // no source_file = keep first encountered
        if (!bFile) return 1;
        return sourceFileTimestamp(aFile).localeCompare(sourceFileTimestamp(bFile));
      });
      deduped.push(group[0]);
    }
  }

  return { deduped, preDedupCount };
}

const SEARCH_CONTEXT_DESCRIPTION = `Semantic search across all indexed content — handoffs, tasks, notes, artifacts, documents.

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
Use these to narrow searches to specific time windows (e.g., "what did I decide about X last week").

READ context_envelope FIRST. If boundary_detected=true or constraint_alerts non-empty, address constraints before recommendations.

Returns: {results[], context_envelope, query, total, mode, deduplicated, pre_dedup_count}

If results reference events indirectly, reformulate with specific terms, lower threshold (0.05), higher limit (20).

Response Format:
- Reasoning-capable models (extended thinking enabled): Use structured reflection before synthesizing results. Evaluate whether retrieved evidence actually supports the user's question. Note gaps explicitly when results are thin or off-topic.
- Standard inference models: Respond directly using available results. Flag when results seem insufficient and suggest query reformulation.`;

const REINDEX_DESCRIPTION = `Rebuild the semantic search index by re-embedding all handoffs, tasks, notes, and artifacts. Use after bulk data changes, bulk imports, or when search_context results seem stale or incomplete.

WARNING: Can take several minutes for large datasets (1000+ handoffs). Re-embeds all content, not just changed items. Inform the user of expected duration before running.

Parameters:
  - content_types (optional): Which to reindex. Default: all. Options: 'handoff', 'task', 'note', 'artifact'

Returns: {handoffs: {indexed, skipped, errors}, tasks: {indexed}, notes: {indexed}, artifacts: {indexed}}`;

export function registerSearchTools(mcpServer: McpServer): void {
  // \u2500\u2500 search_context \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  mcpServer.tool(
    "search_context",
    SEARCH_CONTEXT_DESCRIPTION,
    {
      query: z.string().describe("Natural language search query"),
      content_types: z
        .array(z.enum(["handoff", "task", "note", "artifact", "document", "transcript"]))
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

        // Build date-range filter fragment + params. Applies to both the
        // vector and FTS sides so filtered-out rows don't consume candidate
        // slots before RRF fusion. Handoffs use stored_at; tasks use
        // created_at — both live in metadata JSONB.
        const dateParams: string[] = [];
        const dateClauses: string[] = [];
        if (args.after) {
          dateParams.push(args.after);
          const p = `$DATE${dateParams.length}`;
          dateClauses.push(
            `COALESCE((metadata->>'stored_at')::timestamptz, (metadata->>'created_at')::timestamptz) >= ${p}::timestamptz`
          );
        }
        if (args.before) {
          dateParams.push(args.before);
          const p = `$DATE${dateParams.length}`;
          dateClauses.push(
            `COALESCE((metadata->>'stored_at')::timestamptz, (metadata->>'created_at')::timestamptz) <= ${p}::timestamptz`
          );
        }
        const dateFilter = dateClauses.length ? ` AND ${dateClauses.join(" AND ")}` : "";

        let sql: string;
        let params: unknown[];

        if (useHybrid) {
          // Param layout: $1=vector, $2=threshold, $3=ftsQuery,
          // then (optionally) content_types, then date params, then final limit.
          params = [pgVector, threshold, expandedQuery];
          const contentTypesIdx = args.content_types?.length ? params.length + 1 : null;
          if (contentTypesIdx) params.push(args.content_types);
          const dateStartIdx = params.length + 1;
          params.push(...dateParams);
          const finalLimitIdx = params.length + 1;
          params.push(overFetchLimit);

          const contentTypesClause = contentTypesIdx
            ? `AND content_type = ANY($${contentTypesIdx}::text[])`
            : "";
          const resolvedDateFilter = dateFilter.replace(/\$DATE(\d+)/g, (_m, n) => `$${dateStartIdx + parseInt(n, 10) - 1}`);

          sql = `
            WITH semantic AS (
              SELECT id, content_type, content_id,
                     LEFT(content_text, 500) as content_text, metadata,
                     1 - (embedding <=> $1::vector) as similarity,
                     ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
              FROM embeddings
              WHERE 1 - (embedding <=> $1::vector) >= $2
              ${contentTypesClause}
              ${resolvedDateFilter}
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
              LIMIT 100
            )
            SELECT s.content_type, s.content_id, s.content_text, s.metadata, s.similarity,
                   COALESCE(1.0/(60 + s.rank), 0) + COALESCE(1.0/(60 + f.rank), 0) AS rrf_score
            FROM semantic s
            LEFT JOIN fulltext f ON s.id = f.id
            ORDER BY rrf_score DESC
            LIMIT $${finalLimitIdx}
          `;
        } else {
          // Pure vector search — over-fetch for dedup headroom
          params = [pgVector, threshold];
          const contentTypesIdx = args.content_types?.length ? params.length + 1 : null;
          if (contentTypesIdx) params.push(args.content_types);
          const dateStartIdx = params.length + 1;
          params.push(...dateParams);
          const finalLimitIdx = params.length + 1;
          params.push(overFetchLimit);

          const contentTypesClause = contentTypesIdx
            ? `AND content_type = ANY($${contentTypesIdx}::text[])`
            : "";
          const resolvedDateFilter = dateFilter.replace(/\$DATE(\d+)/g, (_m, n) => `$${dateStartIdx + parseInt(n, 10) - 1}`);

          sql = `
            SELECT content_type, content_id,
                   LEFT(content_text, 500) as content_text, metadata,
                   1 - (embedding <=> $1::vector) as similarity
            FROM embeddings
            WHERE 1 - (embedding <=> $1::vector) >= $2
            ${contentTypesClause}
            ${resolvedDateFilter}
            ORDER BY embedding <=> $1::vector
            LIMIT $${finalLimitIdx}
          `;
        }

        const result = await query(sql, params);

        if (result.rows.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                results: [],
                message: "No results found. Try broadening your query or lowering the similarity threshold.",
                query: args.query,
                mode: useHybrid ? "hybrid" : "vector",
                deduplicated: true,
                pre_dedup_count: 0,
                context_envelope: emptyEnvelope(),
              }),
            }],
          };
        }

        // Deduplicate: collapse near-identical content to oldest source
        const { deduped, preDedupCount } = deduplicateResults(result.rows as unknown as SearchResultRow[]);

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
        // fall back to the fusion ordering above.
        let reranked = false;
        let workingRows = deduped;
        if (rerankerEnabled && deduped.length > 1) {
          const texts = deduped.map((r) => r.content_text ?? "");
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

        // Compute context envelope from entity matches (best-effort)
        const resultTexts = finalRows.map((r) => r.content_text ?? "");
        let envelope;
        try {
          const entities = await lookupEntities(resultTexts);
          envelope = computeEnvelope(entities);
        } catch {
          envelope = emptyEnvelope();
        }

        const noteResults = finalRows.filter(r => r.content_type === 'note');
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

        const responseData = {
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
            ...(r.metadata?.chunk_index != null ? { chunk_index: r.metadata.chunk_index } : {}),
            ...(r.metadata?.source_file ? { source_file: r.metadata.source_file } : {}),
          })),
          query: args.query,
          total: finalRows.length,
          mode: useHybrid ? "hybrid" : "vector",
          reranked,
          deduplicated: true,
          pre_dedup_count: preDedupCount,
          context_envelope: envelope,
          next_step: nextStep,
        };

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

  // \u2500\u2500 reindex \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  mcpServer.tool(
    "reindex",
    REINDEX_DESCRIPTION,
    {
      content_types: z
        .array(z.enum(["handoff", "task", "note", "artifact"]))
        .optional()
        .describe("Which types to reindex. Default: all."),
    },
    async (args) => {
      const available = await isEmbeddingAvailable();
      if (!available) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              message: "Embedding server is not available. Cannot reindex.",
              code: "EMBEDDING_UNAVAILABLE",
            }),
          }],
        };
      }

      const types = args.content_types ?? ["handoff", "task", "note", "artifact"];
      const results: Record<string, unknown> = {};

      // Drain pending queue first so recovered items aren't re-processed by the full reindex below.
      const drained = await drainPendingEmbeddings();
      results.pending_drain = drained;

      if (types.includes("handoff")) {
        results.handoffs = await indexAllHandoffs();
      }

      if (types.includes("task")) {
        const count = await indexAllTasks();
        results.tasks = { indexed: count };
      }

      if (types.includes("note")) {
        const count = await indexAllNotes();
        results.notes = { indexed: count };
      }

      if (types.includes("artifact")) {
        const count = await indexAllArtifacts();
        results.artifacts = { indexed: count };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, reindexed: results }),
        }],
      };
    }
  );
}
