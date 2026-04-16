import { z } from "zod";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { query } from "../db/client.js";
import { generateEmbedding, isEmbeddingAvailable } from "../embeddings/client.js";
import { indexAllHandoffs, indexAllTasks } from "../embeddings/indexer.js";
import { lookupEntities, computeEnvelope, emptyEnvelope, generateBoundaryNotice } from "./entities.js";

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

const SEARCH_CONTEXT_DESCRIPTION = `Semantic search across indexed content — handoffs, tasks, documents. Results ranked by meaning similarity.

WHEN TO SEARCH: Proactively before responding about named people, hardware/devices, career/comp, network infra, medical, financial context, or continuity cues ("last time", "we discussed").

QUERY TIPS: Natural language, include entity names. People: full name. Devices: user's name for it.

READ context_envelope FIRST. If boundary_detected=true or constraint_alerts non-empty, address constraints before recommendations.

Returns: {results[], context_envelope, query, total, mode, deduplicated, pre_dedup_count}

If results reference events indirectly, reformulate with specific terms, lower threshold (0.05), higher limit (20).`;

const REINDEX_DESCRIPTION = `Rebuild the semantic search index by re-embedding all handoffs and tasks. Use after bulk data changes, bulk imports, or when search_context results seem stale or incomplete.

WARNING: Can take several minutes for large datasets (1000+ handoffs). Re-embeds all content, not just changed items. Inform the user of expected duration before running.

Parameters:
  - content_types (optional): Which to reindex. Default: all. Options: 'handoff', 'task'

Returns: {handoffs: {indexed, skipped, errors}, tasks: {indexed}}`;

export function registerSearchTools(mcpServer: McpServer): void {
  // \u2500\u2500 search_context \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  mcpServer.tool(
    "search_context",
    SEARCH_CONTEXT_DESCRIPTION,
    {
      query: z.string().describe("Natural language search query"),
      content_types: z
        .array(z.enum(["handoff", "task", "document", "transcript"]))
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
        // Prepend nomic search_query prefix
        const queryText = `search_query: ${args.query}`;
        const embedding = await generateEmbedding(queryText);
        const limit = args.limit ?? 5;
        const overFetchLimit = Math.min(limit * 4, 80);
        const threshold = args.similarity_threshold ?? 0.15;
        const useHybrid = args.hybrid ?? true;
        const pgVector = `[${embedding.join(",")}]`;

        let sql: string;
        let params: unknown[];

        if (useHybrid) {
          // Hybrid search: vector + full-text with RRF fusion (k=60)
          // Over-fetch on final LIMIT for dedup headroom; CTEs stay at 50
          sql = `
            WITH semantic AS (
              SELECT id, content_type, content_id,
                     LEFT(content_text, 500) as content_text, metadata,
                     1 - (embedding <=> $1::vector) as similarity,
                     ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
              FROM embeddings
              WHERE 1 - (embedding <=> $1::vector) >= $2
              ${args.content_types?.length ? `AND content_type = ANY($4::text[])` : ""}
              ORDER BY embedding <=> $1::vector
              LIMIT 50
            ),
            fulltext AS (
              SELECT id,
                     ROW_NUMBER() OVER (
                       ORDER BY ts_rank(to_tsvector('english', content_text),
                                        websearch_to_tsquery('english', $3)) DESC
                     ) AS rank
              FROM embeddings
              WHERE to_tsvector('english', content_text) @@ websearch_to_tsquery('english', $3)
              ${args.content_types?.length ? `AND content_type = ANY($4::text[])` : ""}
              LIMIT 50
            )
            SELECT s.content_type, s.content_id, s.content_text, s.metadata, s.similarity,
                   COALESCE(1.0/(60 + s.rank), 0) + COALESCE(1.0/(60 + f.rank), 0) AS rrf_score
            FROM semantic s
            LEFT JOIN fulltext f ON s.id = f.id
            ORDER BY rrf_score DESC
            LIMIT $${args.content_types?.length ? 5 : 4}
          `;
          params = [pgVector, threshold, args.query];
          if (args.content_types?.length) params.push(args.content_types);
          params.push(overFetchLimit);
        } else {
          // Pure vector search \u2014 over-fetch for dedup headroom
          sql = `
            SELECT content_type, content_id,
                   LEFT(content_text, 500) as content_text, metadata,
                   1 - (embedding <=> $1::vector) as similarity
            FROM embeddings
            WHERE 1 - (embedding <=> $1::vector) >= $2
            ${args.content_types?.length ? `AND content_type = ANY($3::text[])` : ""}
            ORDER BY embedding <=> $1::vector
            LIMIT $${args.content_types?.length ? 4 : 3}
          `;
          params = [pgVector, threshold];
          if (args.content_types?.length) params.push(args.content_types);
          params.push(overFetchLimit);
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
        const finalRows = deduped.slice(0, limit);

        // Compute context envelope from entity matches (best-effort)
        const resultTexts = finalRows.map((r) => r.content_text ?? "");
        let envelope;
        try {
          const entities = await lookupEntities(resultTexts);
          envelope = computeEnvelope(entities);
        } catch {
          envelope = emptyEnvelope();
        }

        const responseData = {
          results: finalRows.map((r: SearchResultRow) => ({
            content_type: r.content_type,
            content_id: r.content_id,
            content_text: r.content_text,
            metadata: r.metadata,
            similarity: Math.round((r.similarity ?? 0) * 1000) / 1000,
            ...(r.rrf_score ? { rrf_score: Math.round(r.rrf_score * 10000) / 10000 } : {}),
            ...(r.metadata?.chunk_index != null ? { chunk_index: r.metadata.chunk_index } : {}),
            ...(r.metadata?.source_file ? { source_file: r.metadata.source_file } : {}),
          })),
          query: args.query,
          total: finalRows.length,
          mode: useHybrid ? "hybrid" : "vector",
          deduplicated: true,
          pre_dedup_count: preDedupCount,
          context_envelope: envelope,
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
        .array(z.enum(["handoff", "task"]))
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

      const types = args.content_types ?? ["handoff", "task"];
      const results: Record<string, unknown> = {};

      if (types.includes("handoff")) {
        results.handoffs = await indexAllHandoffs();
      }

      if (types.includes("task")) {
        const count = await indexAllTasks();
        results.tasks = { indexed: count };
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
