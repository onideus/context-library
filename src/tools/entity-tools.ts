import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { query } from "../db/client.js";
import { config } from "../config.js";
import { getProvider, getActiveProvider } from "../entities/registry.js";
import { SamplingProvider } from "../entities/providers/sampling.js";
import {
  createExtractionRun,
  completeExtractionRun,
  failExtractionRun,
  storeTriples,
  getRelationsForEntity,
} from "../entities/store.js";
import { extractHandoffText } from "../embeddings/indexer.js";
import { getLatestHandoffFilename } from "../storage/json-store.js";
import type { EntityExtractor } from "../entities/types.js";

// ── Response helpers ─────────────────────────────────────────────────────────

function jsonResponse(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errorResponse(message: string, code: string) {
  return jsonResponse({ error: true, message, code });
}

// ── DB row types ─────────────────────────────────────────────────────────────

interface ExtractionRunRow {
  id: string;
  provider: string;
  provider_version: string | null;
  status: string;
  content_scope: string | null;
  content_count: number;
  triple_count: number;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

interface EntityNodeRow {
  id: string;
  name: string;
  entity_type: string;
  canonical_name: string;
  mention_count: number;
  first_seen: string;
  last_seen: string;
}

interface RelationRow {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  confidence: number;
  provider: string;
  extraction_run_id: string | null;
  source_content_type: string;
  source_content_id: string;
  context_snippet: string | null;
  created_at: string;
}

// ── Tool Descriptions ────────────────────────────────────────────────────────

const EXTRACT_ENTITIES_DESC = `Trigger entity extraction on a single content item (handoff or note) and persist the resulting knowledge graph triples.

CALL THIS WHEN:
- The user asks to "extract entities from this handoff/note" or "update the entity graph for X"
- You want to populate the entity graph for a specific item before querying it with entity_relations or browse_entities

DO NOT CALL WHEN:
- You want to process many items at once — use run_extraction instead
- You want to browse already-extracted entities — use browse_entities or entity_relations

Parameters:
- content_type: 'handoff' or 'note' (required)
- content_id: UUID of a note, or filename of a handoff. If omitted, uses the most recent handoff.
- provider: 'ollama', 'api', or 'mcp-sampling'. If omitted, uses the active provider from config.

Returns: triple_count, entity_count, provider_used, run_id, duration_ms.
Returns error with code NO_PROVIDER if no extraction provider is configured or available.`;

const RUN_EXTRACTION_DESC = `Batch-extract entities from multiple content items under a single extraction run. Used to populate or refresh the entity graph at scale.

CALL THIS WHEN:
- The user asks to "re-extract everything", "run entity extraction on all notes", or similar batch requests
- You want to set up two runs with different providers so you can compare them with compare_extractions

DO NOT CALL WHEN:
- Only one specific item needs extracting — use extract_entities instead
- You just want to see what's already in the graph — use browse_entities

Parameters:
- provider: which extraction provider to use ('ollama', 'api', 'mcp-sampling')
- scope: 'handoffs', 'notes', or 'all' (default: 'all')
- limit: max items to process (default: unlimited)

Returns: run_id, status, triple_count, content_count, provider_used, duration_ms.
Suggest following up with compare_extractions if this is the second run of a provider comparison.`;

const COMPARE_EXTRACTIONS_DESC = `Compare two extraction runs to see how much overlap and divergence there is between providers or extraction passes.

CALL THIS WHEN:
- You just completed two extraction runs with different providers (e.g., ollama vs api) and want to evaluate quality
- The user asks "how does run X compare to run Y" or "which provider found more relationships"

Returns:
- Triple counts for each run
- Overlapping triples (same subject canonical name + predicate + object canonical name)
- Triples unique to run A and unique to run B
- Average confidence per run
- Entity type distribution per run
- Top 10 highest-confidence triples from each run`;

const LIST_EXTRACTION_RUNS_DESC = `List recent entity extraction runs with status, provider, triple counts, and timestamps.

Use this to find run IDs for compare_extractions, to check the status of a recent batch, or to review extraction history.`;

const BROWSE_ENTITIES_DESC = `Browse the entity graph — list entity nodes with their mention counts and relation counts.

CALL THIS WHEN:
- The user asks "what entities are in the graph", "show me all technologies", or "list entities related to X"
- You want to discover entity IDs before calling entity_relations

DO NOT CALL WHEN:
- You already know the entity ID and want its relations — use entity_relations directly

Parameters:
- entity_type: filter by type ('concept', 'technology', 'person', 'organization', etc.)
- search: substring match on entity name (case-insensitive)
- limit: max results (default 20, max 100)

Returns: list of entities with id, name, type, mention_count, relation_count.`;

const ENTITY_RELATIONS_DESC = `Retrieve the relation graph for an entity — what it connects to and how.

CALL THIS WHEN:
- The user asks "what is X connected to", "show me the relations for Y", or "what depends on Z"
- You are traversing the entity graph to answer questions about dependencies or relationships

Parameters:
- entity_id: UUID of the entity (get from browse_entities if unknown)
- hops: traversal depth 1–3 (default 1). Use 2+ for transitive relationships.
- relation_type: filter to only relations of this type (e.g., 'blocked_by', 'implemented_with')

Returns: source entity info, list of relations with connected entity names and types, and hop depth for multi-hop results.`;

// ── Tool Registration ─────────────────────────────────────────────────────────

export function registerEntityTools(mcpServer: McpServer): void {
  // Shared SamplingProvider instance — the provider object is reused across requests.
  // available() and extract() calls are request-scoped: sampling/createMessage only
  // works when an active MCP client connection is present. Always check available()
  // before calling extract().
  const samplingProvider = new SamplingProvider(mcpServer.server, {
    minConfidence: config.entityMinConfidence,
  });

  // ── Resolve provider helper ──────────────────────────────────────────────
  function resolveProvider(name?: string): EntityExtractor | undefined {
    if (name === "mcp-sampling") return samplingProvider;
    if (name) return getProvider(name);
    return getActiveProvider();
  }

  // ── extract_entities ─────────────────────────────────────────────────────
  mcpServer.tool(
    "extract_entities",
    EXTRACT_ENTITIES_DESC,
    {
      content_type: z.enum(["handoff", "note"]).describe("Type of content to extract from"),
      content_id: z.string().optional().describe("UUID (note) or filename (handoff). Defaults to most recent handoff."),
      provider: z.string().optional().describe("Provider name: 'ollama', 'api', or 'mcp-sampling'. Defaults to active provider from config."),
    },
    async (args) => {
      const provider = resolveProvider(args.provider);
      if (!provider) {
        return errorResponse(
          "No extraction provider configured. Set ENTITY_EXTRACTION_PROVIDER env var or pass provider explicitly.",
          "NO_PROVIDER"
        );
      }

      const isAvailable = await provider.available().catch(() => false);
      if (!isAvailable) {
        return errorResponse(
          `Provider '${provider.provider}' is not available. Check connectivity and configuration.`,
          "PROVIDER_UNAVAILABLE"
        );
      }

      let contentId = args.content_id;
      let content: string;

      if (args.content_type === "handoff") {
        if (!contentId) {
          const latest = await getLatestHandoffFilename();
          if (!latest) {
            return errorResponse("No handoff files found", "NOT_FOUND");
          }
          contentId = latest;
        }
        // Reject path traversal: contentId must be a bare filename with no separators, ending in .json
        if (contentId.includes("/") || contentId.includes("\\") || !contentId.endsWith(".json")) {
          return errorResponse(`Invalid handoff filename: '${contentId}'`, "VALIDATION_ERROR");
        }
        try {
          const { readFile } = await import("node:fs/promises");
          const { join } = await import("node:path");
          const raw = await readFile(join(config.dataDir, "handoffs", contentId), "utf-8");
          content = extractHandoffText(JSON.parse(raw) as Record<string, unknown>);
        } catch (err) {
          return errorResponse(`Failed to read handoff '${contentId}': ${(err as Error).message}`, "READ_ERROR");
        }
      } else {
        if (!contentId) {
          return errorResponse("content_id is required for notes", "VALIDATION_ERROR");
        }
        try {
          const result = await query<{ title: string; content: string }>(
            "SELECT title, content FROM notes WHERE id = $1",
            [contentId]
          );
          if (result.rows.length === 0) {
            return errorResponse(`Note not found: ${contentId}`, "NOT_FOUND");
          }
          const row = result.rows[0];
          content = [row.title, row.content].filter(Boolean).join("\n");
        } catch (err) {
          return errorResponse((err as Error).message, "DB_ERROR");
        }
      }

      if (!content.trim()) {
        return errorResponse("Content is empty — nothing to extract", "EMPTY_CONTENT");
      }

      const runId = await createExtractionRun(provider.provider, provider.version, {
        contentType: args.content_type,
        contentId,
      });

      try {
        const result = await provider.extract(content, args.content_type, contentId);
        const storedTriples = runId ? await storeTriples(result, runId) : 0;

        // Count distinct entities involved
        const entityCount = new Set([
          ...result.triples.map((t) => t.subject.toLowerCase().trim()),
          ...result.triples.map((t) => t.object.toLowerCase().trim()),
        ]).size;

        if (runId) await completeExtractionRun(runId, storedTriples);

        return jsonResponse({
          run_id: runId,
          provider_used: provider.provider,
          triple_count: storedTriples,
          entity_count: entityCount,
          duration_ms: result.durationMs,
        });
      } catch (err) {
        if (runId) await failExtractionRun(runId, (err as Error).message).catch(() => {});
        return errorResponse((err as Error).message, "EXTRACTION_ERROR");
      }
    }
  );

  // ── run_extraction ────────────────────────────────────────────────────────
  mcpServer.tool(
    "run_extraction",
    RUN_EXTRACTION_DESC,
    {
      provider: z.string().describe("Provider to use: 'ollama', 'api', or 'mcp-sampling'"),
      scope: z.enum(["handoffs", "notes", "all"]).optional().describe("Which content to process (default: 'all')"),
      limit: z.number().min(1).optional().describe("Max items to process per content type"),
    },
    async (args) => {
      const provider = resolveProvider(args.provider);
      if (!provider) {
        return errorResponse(
          `Provider '${args.provider}' is not registered. Available: ollama, api, mcp-sampling.`,
          "NO_PROVIDER"
        );
      }

      const isAvailable = await provider.available().catch(() => false);
      if (!isAvailable) {
        return errorResponse(
          `Provider '${provider.provider}' is not available.`,
          "PROVIDER_UNAVAILABLE"
        );
      }

      const scope = args.scope ?? "all";
      const limit = args.limit;
      const startTime = Date.now();

      let totalTriples = 0;
      let totalContent = 0;
      const runIds: string[] = [];

      // ── Process handoffs ──────────────────────────────────────────────────
      if (scope === "handoffs" || scope === "all") {
        try {
          const { readdir, readFile } = await import("node:fs/promises");
          const { join } = await import("node:path");
          const handoffsDir = join(config.dataDir, "handoffs");
          let files: string[] = [];
          try {
            files = (await readdir(handoffsDir)).filter((f) => f.endsWith(".json")).sort();
          } catch {
            // Directory missing — skip silently
          }
          if (limit) files = files.slice(0, limit);

          if (files.length > 0) {
            const runId = await createExtractionRun(provider.provider, provider.version, {
              scope: "handoffs",
              contentCount: files.length,
            });
            if (runId) runIds.push(runId);

            let runTriples = 0;
            for (const file of files) {
              try {
                const raw = await readFile(join(handoffsDir, file), "utf-8");
                const text = extractHandoffText(JSON.parse(raw) as Record<string, unknown>);
                if (!text.trim()) continue;
                const result = await provider.extract(text, "handoff", file);
                const stored = runId ? await storeTriples(result, runId) : 0;
                runTriples += stored;
                totalContent++;
              } catch (err) {
                console.warn(`[run_extraction] handoff ${file}:`, (err as Error).message);
              }
            }

            if (runId) await completeExtractionRun(runId, runTriples);
            totalTriples += runTriples;
          }
        } catch (err) {
          console.warn("[run_extraction] handoff processing failed:", (err as Error).message);
        }
      }

      // ── Process notes ─────────────────────────────────────────────────────
      if (scope === "notes" || scope === "all") {
        try {
          const noteResult = await query<{ id: string; title: string; content: string }>(
            limit
              ? `SELECT id, title, content FROM notes ORDER BY created_at ASC LIMIT $1`
              : `SELECT id, title, content FROM notes ORDER BY created_at ASC`,
            limit ? [limit] : undefined
          );

          if (noteResult.rows.length > 0) {
            const runId = await createExtractionRun(provider.provider, provider.version, {
              scope: "notes",
              contentCount: noteResult.rows.length,
            });
            if (runId) runIds.push(runId);

            let runTriples = 0;
            for (const note of noteResult.rows) {
              try {
                const text = [note.title, note.content].filter(Boolean).join("\n");
                if (!text.trim()) continue;
                const result = await provider.extract(text, "note", note.id);
                const stored = runId ? await storeTriples(result, runId) : 0;
                runTriples += stored;
                totalContent++;
              } catch (err) {
                console.warn(`[run_extraction] note ${note.id}:`, (err as Error).message);
              }
            }

            if (runId) await completeExtractionRun(runId, runTriples);
            totalTriples += runTriples;
          }
        } catch (err) {
          return errorResponse((err as Error).message, "DB_ERROR");
        }
      }

      return jsonResponse({
        run_ids: runIds,
        status: "completed",
        provider_used: provider.provider,
        triple_count: totalTriples,
        content_count: totalContent,
        scope,
        duration_ms: Date.now() - startTime,
        next_step: runIds.length > 0
          ? `Use compare_extractions with run_id_a and run_id_b to compare this run against a previous one.`
          : undefined,
      });
    }
  );

  // ── compare_extractions ───────────────────────────────────────────────────
  mcpServer.tool(
    "compare_extractions",
    COMPARE_EXTRACTIONS_DESC,
    {
      run_id_a: z.string().describe("UUID of the first extraction run"),
      run_id_b: z.string().describe("UUID of the second extraction run"),
    },
    async (args) => {
      try {
        // Fetch run metadata
        const runsResult = await query<ExtractionRunRow>(
          "SELECT * FROM extraction_runs WHERE id = ANY($1::uuid[])",
          [[args.run_id_a, args.run_id_b]]
        );

        const runMap = new Map(runsResult.rows.map((r) => [r.id, r]));
        const runA = runMap.get(args.run_id_a);
        const runB = runMap.get(args.run_id_b);

        if (!runA) return errorResponse(`Run not found: ${args.run_id_a}`, "NOT_FOUND");
        if (!runB) return errorResponse(`Run not found: ${args.run_id_b}`, "NOT_FOUND");

        // Overlap count (same canonical src + tgt + relation_type)
        const overlapResult = await query<{ count: string }>(
          `SELECT COUNT(*) AS count
           FROM (
             SELECT sn.canonical_name AS src, tn.canonical_name AS tgt, er_a.relation_type
             FROM entity_relations er_a
             JOIN entity_nodes sn ON sn.id = er_a.source_entity_id
             JOIN entity_nodes tn ON tn.id = er_a.target_entity_id
             WHERE er_a.extraction_run_id = $1
           ) a
           INNER JOIN (
             SELECT sn.canonical_name AS src, tn.canonical_name AS tgt, er_b.relation_type
             FROM entity_relations er_b
             JOIN entity_nodes sn ON sn.id = er_b.source_entity_id
             JOIN entity_nodes tn ON tn.id = er_b.target_entity_id
             WHERE er_b.extraction_run_id = $2
           ) b USING (src, tgt, relation_type)`,
          [args.run_id_a, args.run_id_b]
        );
        const overlapCount = parseInt(overlapResult.rows[0]?.count ?? "0", 10);

        // Average confidence per run
        const avgResult = await query<{ run_id: string; avg_confidence: string }>(
          `SELECT extraction_run_id AS run_id, AVG(confidence) AS avg_confidence
           FROM entity_relations
           WHERE extraction_run_id = ANY($1::uuid[])
           GROUP BY extraction_run_id`,
          [[args.run_id_a, args.run_id_b]]
        );
        const avgMap = new Map(avgResult.rows.map((r) => [r.run_id, parseFloat(r.avg_confidence)]));

        // Entity type distribution per run
        const typeDistResult = await query<{ run_id: string; entity_type: string; count: string }>(
          `SELECT er.extraction_run_id AS run_id, en.entity_type, COUNT(*) AS count
           FROM entity_relations er
           JOIN entity_nodes en ON en.id = er.source_entity_id OR en.id = er.target_entity_id
           WHERE er.extraction_run_id = ANY($1::uuid[])
           GROUP BY er.extraction_run_id, en.entity_type
           ORDER BY er.extraction_run_id, count DESC`,
          [[args.run_id_a, args.run_id_b]]
        );
        const typeDist: Record<string, Record<string, number>> = {};
        for (const row of typeDistResult.rows) {
          if (!typeDist[row.run_id]) typeDist[row.run_id] = {};
          typeDist[row.run_id][row.entity_type] = parseInt(row.count, 10);
        }

        // Top 10 highest-confidence triples from each run
        const topTriplesResult = await query<{
          run_id: string;
          subject: string;
          relation_type: string;
          object: string;
          confidence: number;
        }>(
          `SELECT er.extraction_run_id AS run_id,
                  sn.name AS subject, er.relation_type, tn.name AS object, er.confidence
           FROM entity_relations er
           JOIN entity_nodes sn ON sn.id = er.source_entity_id
           JOIN entity_nodes tn ON tn.id = er.target_entity_id
           WHERE er.extraction_run_id = ANY($1::uuid[])
           ORDER BY er.extraction_run_id, er.confidence DESC`,
          [[args.run_id_a, args.run_id_b]]
        );

        const topMap: Record<string, Array<{ subject: string; predicate: string; object: string; confidence: number }>> = {};
        for (const row of topTriplesResult.rows) {
          if (!topMap[row.run_id]) topMap[row.run_id] = [];
          if (topMap[row.run_id].length < 10) {
            topMap[row.run_id].push({
              subject: row.subject,
              predicate: row.relation_type,
              object: row.object,
              confidence: row.confidence,
            });
          }
        }

        const aTriples = runA.triple_count;
        const bTriples = runB.triple_count;

        return jsonResponse({
          run_a: {
            id: args.run_id_a,
            provider: runA.provider,
            triple_count: aTriples,
            avg_confidence: avgMap.get(args.run_id_a) ?? null,
            entity_type_distribution: typeDist[args.run_id_a] ?? {},
            top_triples: topMap[args.run_id_a] ?? [],
          },
          run_b: {
            id: args.run_id_b,
            provider: runB.provider,
            triple_count: bTriples,
            avg_confidence: avgMap.get(args.run_id_b) ?? null,
            entity_type_distribution: typeDist[args.run_id_b] ?? {},
            top_triples: topMap[args.run_id_b] ?? [],
          },
          overlap_count: overlapCount,
          unique_to_a: Math.max(0, aTriples - overlapCount),
          unique_to_b: Math.max(0, bTriples - overlapCount),
          overlap_pct:
            aTriples + bTriples > 0
              ? Math.round((overlapCount * 2 * 100) / (aTriples + bTriples))
              : 0,
        });
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );

  // ── list_extraction_runs ──────────────────────────────────────────────────
  mcpServer.tool(
    "list_extraction_runs",
    LIST_EXTRACTION_RUNS_DESC,
    {
      limit: z.number().min(1).max(50).optional().describe("Max runs to return (default 10, max 50)"),
    },
    async (args) => {
      try {
        const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
        const result = await query<ExtractionRunRow>(
          `SELECT * FROM extraction_runs ORDER BY started_at DESC LIMIT $1`,
          [limit]
        );
        return jsonResponse({
          runs: result.rows.map((r) => ({
            id: r.id,
            provider: r.provider,
            provider_version: r.provider_version,
            status: r.status,
            content_scope: r.content_scope,
            content_count: r.content_count,
            triple_count: r.triple_count,
            started_at: r.started_at,
            completed_at: r.completed_at,
            error: r.error,
          })),
          total: result.rows.length,
        });
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );

  // ── browse_entities ───────────────────────────────────────────────────────
  mcpServer.tool(
    "browse_entities",
    BROWSE_ENTITIES_DESC,
    {
      entity_type: z.string().optional().describe("Filter by entity type (e.g., 'technology', 'concept', 'person')"),
      search: z.string().optional().describe("Case-insensitive substring search on entity name"),
      limit: z.number().min(1).max(100).optional().describe("Max results (default 20, max 100)"),
    },
    async (args) => {
      try {
        const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (args.entity_type) {
          conditions.push(`en.entity_type = $${paramIdx++}`);
          params.push(args.entity_type);
        }
        if (args.search) {
          conditions.push(`en.name ILIKE $${paramIdx++}`);
          params.push(`%${args.search}%`);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

        const result = await query<EntityNodeRow & { relation_count: string }>(
          `SELECT en.id, en.name, en.entity_type, en.canonical_name,
                  en.mention_count, en.first_seen, en.last_seen,
                  COUNT(DISTINCT er.id) AS relation_count
           FROM entity_nodes en
           LEFT JOIN entity_relations er
             ON er.source_entity_id = en.id OR er.target_entity_id = en.id
           ${where}
           GROUP BY en.id
           ORDER BY en.mention_count DESC, en.name ASC
           LIMIT $${paramIdx}`,
          [...params, limit]
        );

        return jsonResponse({
          entities: result.rows.map((r) => ({
            id: r.id,
            name: r.name,
            entity_type: r.entity_type,
            mention_count: r.mention_count,
            relation_count: parseInt(r.relation_count, 10),
            first_seen: r.first_seen,
            last_seen: r.last_seen,
          })),
          count: result.rows.length,
          next_step: result.rows.length > 0
            ? "Use entity_relations with an entity id to explore its connections."
            : "No entities found. Run extract_entities or run_extraction to populate the graph.",
        });
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );

  // ── entity_relations ──────────────────────────────────────────────────────
  mcpServer.tool(
    "entity_relations",
    ENTITY_RELATIONS_DESC,
    {
      entity_id: z.string().describe("UUID of the entity (get from browse_entities if unknown)"),
      hops: z.number().min(1).max(3).optional().describe("Traversal depth 1–3 (default 1)"),
      relation_type: z.string().optional().describe("Filter to relations of this type only"),
    },
    async (args) => {
      const hops = Math.min(Math.max(args.hops ?? 1, 1), 3);

      try {
        // Fetch the root entity
        const entityResult = await query<EntityNodeRow>(
          "SELECT * FROM entity_nodes WHERE id = $1",
          [args.entity_id]
        );
        if (entityResult.rows.length === 0) {
          return errorResponse(`Entity not found: ${args.entity_id}`, "NOT_FOUND");
        }
        const rootEntity = entityResult.rows[0];

        // Fetch relations (raw rows from store)
        const relations = await getRelationsForEntity(args.entity_id, hops);

        // Filter by relation_type if requested
        const filtered = args.relation_type
          ? relations.filter((r) => r.relation_type === args.relation_type)
          : relations;

        // Collect all entity IDs we need to resolve
        const entityIds = new Set<string>();
        for (const r of filtered) {
          entityIds.add(r.source_entity_id);
          entityIds.add(r.target_entity_id);
        }
        entityIds.delete(args.entity_id);

        // Resolve entity names in one query
        const entityMap = new Map<string, { name: string; entity_type: string }>();
        entityMap.set(args.entity_id, { name: rootEntity.name, entity_type: rootEntity.entity_type });

        if (entityIds.size > 0) {
          const idsArray = Array.from(entityIds);
          const resolveResult = await query<{ id: string; name: string; entity_type: string }>(
            "SELECT id, name, entity_type FROM entity_nodes WHERE id = ANY($1::uuid[])",
            [idsArray]
          );
          for (const row of resolveResult.rows) {
            entityMap.set(row.id, { name: row.name, entity_type: row.entity_type });
          }
        }

        const enrichedRelations = filtered.map((r: RelationRow) => ({
          id: r.id,
          source: {
            id: r.source_entity_id,
            ...(entityMap.get(r.source_entity_id) ?? { name: "unknown", entity_type: "concept" }),
          },
          relation_type: r.relation_type,
          target: {
            id: r.target_entity_id,
            ...(entityMap.get(r.target_entity_id) ?? { name: "unknown", entity_type: "concept" }),
          },
          confidence: r.confidence,
          provider: r.provider,
          source_content_type: r.source_content_type,
          source_content_id: r.source_content_id,
          context_snippet: r.context_snippet,
        }));

        return jsonResponse({
          entity: {
            id: rootEntity.id,
            name: rootEntity.name,
            entity_type: rootEntity.entity_type,
            mention_count: rootEntity.mention_count,
          },
          hops,
          relation_count: enrichedRelations.length,
          relations: enrichedRelations,
        });
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );
}
