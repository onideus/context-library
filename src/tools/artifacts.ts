import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { query } from "../db/client.js";
import { indexArtifact } from "../embeddings/indexer.js";

// ── Types ────────────────────────────────────────────────────────

interface ArtifactRow {
  id: string;
  title: string;
  artifact_type: string;
  content: string | null;
  pointer: Record<string, unknown> | null;
  status: string;
  scope: string;
  tags: string[];
  dependencies: string[];
  execution_order: number | null;
  related_task_ids: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

function formatArtifact(row: ArtifactRow) {
  return {
    id: row.id,
    title: row.title,
    artifact_type: row.artifact_type,
    content: row.content,
    pointer: row.pointer,
    status: row.status,
    scope: row.scope,
    tags: row.tags || [],
    dependencies: row.dependencies || [],
    execution_order: row.execution_order,
    related_task_ids: row.related_task_ids || [],
    metadata: row.metadata || {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function formatArtifactListItem(row: ArtifactRow) {
  return {
    id: row.id,
    title: row.title,
    artifact_type: row.artifact_type,
    status: row.status,
    scope: row.scope,
    tags: row.tags || [],
    execution_order: row.execution_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function jsonResponse(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function errorResponse(message: string, code: string) {
  return jsonResponse({ error: true, message, code });
}

// Allowed status transitions — graph check against the DB CHECK constraint.
// Any state may move to 'superseded' (tombstone-style retirement).
const STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ["ready", "superseded"],
  ready: ["executing", "draft", "superseded"],
  executing: ["completed", "ready", "superseded"],
  completed: ["superseded"],
  superseded: [],
};

function isValidStatusTransition(from: string, to: string): boolean {
  if (from === to) return true;
  const allowed = STATUS_TRANSITIONS[from];
  return Boolean(allowed && allowed.includes(to));
}

// ── Zod Schemas ──────────────────────────────────────────────────

const scopeEnum = z.enum(["work", "personal", "shared"]);
const statusEnum = z.enum(["draft", "ready", "executing", "completed", "superseded"]);
const listOrderByEnum = z.enum(["created_at", "updated_at", "execution_order"]);
const orderDirEnum = z.enum(["asc", "desc"]);

const pointerSchema = z.object({
  type: z.string().describe("Pointer type: 'git', 'local', 'url', or any deployment-specific scheme"),
}).passthrough();

// ── Tool Descriptions ────────────────────────────────────────────

const STORE_ARTIFACT_DESC = `Store a generated output as an artifact. Artifacts are the fourth content primitive — tracked, searchable, lifecycle-aware outputs that bridge planning and execution. Use for Claude Code prompts, research reports, blog posts, templates, presentations — anything generated once and consumed later.

How artifacts differ from the other primitives:
- Tasks are action items with an open/completed lifecycle — "write the migration" is a task.
- Notes are permanent interpretation — decisions, patterns, takeaways. No lifecycle, no ordering.
- Handoffs are ephemeral session state.
- Artifacts are the concrete outputs produced by work. They have a status lifecycle (draft → ready → executing → completed) and can be ordered within a batch via execution_order.

Storage modes:
- Inline 'content' — for small artifacts like CC prompts, snippets, short docs. Stored directly in Postgres, indexed for semantic search.
- 'pointer' — for large artifacts (binaries, generated media, repo files). Stored externally; the pointer describes how to fetch it. Shape: {type: 'git', repo, branch, path} | {type: 'local', path} | {type: 'url', href}.
- You may provide both when content is a preview/summary and the pointer is the canonical source.

Status lifecycle:
- draft — being assembled, not ready for use
- ready — finalized and available for execution or consumption
- executing — currently being acted on (e.g., a CC prompt being run)
- completed — execution finished
- superseded — replaced or retired; reachable from any state

Use 'execution_order' to sequence artifacts within a batch (e.g., a chain of CC prompts where 1 builds infrastructure, 2 adds tests, 3 updates docs). Use 'dependencies' for explicit cross-artifact ordering when execution_order is not enough. Use 'metadata' for flexible fields like branch_target, model, surface, batch_label.

Returns {id, title, artifact_type, status, created_at}. Re-embeds on create; falls back to the pending queue if the embedding server is offline.`;

const GET_ARTIFACT_DESC = `Retrieve a single artifact by its UUID. Returns the full artifact record including content, pointer, dependencies, and metadata.`;

const LIST_ARTIFACTS_DESC = `List artifacts with optional filters and pagination. Returns metadata only (id, title, artifact_type, status, scope, tags, execution_order, timestamps) — NOT the full content. Call get_artifact to retrieve a body.

This is the primary retrieval tool for execution sessions. Calling list_artifacts({artifact_type: 'cc-prompt', status: 'ready'}) returns the next ordered batch of prompts ready to run. Defaults to execution_order ASC when filtering by artifact_type, otherwise created_at DESC.

Filters (all optional):
- artifact_type — e.g., 'cc-prompt', 'research', 'blog-post'
- status — 'draft' | 'ready' | 'executing' | 'completed' | 'superseded'
- scope — 'work' | 'personal' | 'shared'
- tags — ANY-match array`;

const UPDATE_ARTIFACT_DESC = `Update fields on an existing artifact. All fields are optional — only provided fields are modified. Tags, dependencies, and related_task_ids are full-replacement (provide complete arrays). Metadata merges at the top level (provided keys overwrite; omitted keys are preserved).

Status transitions are enforced:
- draft → ready, superseded
- ready → executing, draft, superseded
- executing → completed, ready, superseded
- completed → superseded
- Any state → superseded (retirement)

Re-embeds when title, content, tags, or artifact_type change.`;

const SEARCH_ARTIFACTS_DESC = `Full-text search across artifact titles and content using PostgreSQL FTS with English stemming. Returns matching artifacts WITH full content (unlike list_artifacts), ranked by relevance.

For cross-type semantic search that finds artifacts alongside handoffs, tasks, and notes, use search_context with content_types: ['artifact'] instead — this tool only searches within the artifacts table.

Filters: artifact_type, status, scope.`;

// ── Tool Registration ────────────────────────────────────────────

export function registerArtifactTools(mcpServer: McpServer): void {
  // ── store_artifact ───────────────────────────────────────────
  mcpServer.tool(
    "store_artifact",
    STORE_ARTIFACT_DESC,
    {
      title: z.string().describe("Short descriptive title for the artifact"),
      artifact_type: z.string().describe("Kind of artifact, e.g., 'cc-prompt', 'research', 'blog-post', 'template', 'presentation'. Free-form — new types are valid."),
      scope: scopeEnum.describe("'work', 'personal', or 'shared'"),
      content: z.string().optional().describe("Inline artifact body. Required if pointer is not provided."),
      pointer: pointerSchema.optional().describe("External storage pointer: {type: 'git', repo, branch, path} | {type: 'local', path} | {type: 'url', href}. Required if content is not provided."),
      status: statusEnum.optional().describe("Lifecycle state (default 'draft')"),
      tags: z.array(z.string()).optional().describe("Free-form tags"),
      dependencies: z.array(z.string()).optional().describe("UUIDs of artifacts that must complete before this one"),
      execution_order: z.number().int().optional().describe("Ordering within a batch (1, 2, 3...). Use for sequenced prompt chains."),
      related_task_ids: z.array(z.string()).optional().describe("UUIDs of tasks this artifact relates to"),
      metadata: z.record(z.unknown()).optional().describe("Flexible metadata: branch_target, model, surface, batch_label, etc."),
    },
    async (args) => {
      if (!args.title?.trim()) {
        return errorResponse("title is required", "VALIDATION_ERROR");
      }
      if (!args.artifact_type?.trim()) {
        return errorResponse("artifact_type is required", "VALIDATION_ERROR");
      }
      const hasContent = typeof args.content === "string" && args.content.trim().length > 0;
      const hasPointer = args.pointer && typeof args.pointer === "object";
      if (!hasContent && !hasPointer) {
        return errorResponse(
          "Artifact must have either 'content' or 'pointer' (or both)",
          "VALIDATION_ERROR"
        );
      }

      try {
        const result = await query<ArtifactRow>(
          `INSERT INTO artifacts (
             title, artifact_type, content, pointer, status, scope,
             tags, dependencies, execution_order, related_task_ids, metadata
           )
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::uuid[], $9, $10::uuid[], $11::jsonb)
           RETURNING *`,
          [
            args.title,
            args.artifact_type,
            args.content ?? null,
            args.pointer ? JSON.stringify(args.pointer) : null,
            args.status ?? "draft",
            args.scope,
            args.tags ?? [],
            args.dependencies ?? [],
            args.execution_order ?? null,
            args.related_task_ids ?? [],
            JSON.stringify(args.metadata ?? {}),
          ]
        );
        const row = result.rows[0];
        indexArtifact(row.id, {
          title: row.title,
          content: row.content,
          artifact_type: row.artifact_type,
          tags: row.tags,
          status: row.status,
          scope: row.scope,
          created_at: row.created_at,
        }).catch((err) =>
          console.warn("[store_artifact] Background indexing failed:", err.message)
        );
        return jsonResponse({
          id: row.id,
          title: row.title,
          artifact_type: row.artifact_type,
          status: row.status,
          created_at: row.created_at,
        });
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );

  // ── get_artifact ─────────────────────────────────────────────
  mcpServer.tool(
    "get_artifact",
    GET_ARTIFACT_DESC,
    {
      id: z.string().describe("UUID of the artifact to retrieve"),
    },
    async (args) => {
      try {
        const result = await query<ArtifactRow>(
          "SELECT * FROM artifacts WHERE id = $1",
          [args.id]
        );
        if (result.rows.length === 0) {
          return errorResponse(`Artifact not found: ${args.id}`, "NOT_FOUND");
        }
        return jsonResponse(formatArtifact(result.rows[0]));
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );

  // ── list_artifacts ───────────────────────────────────────────
  mcpServer.tool(
    "list_artifacts",
    LIST_ARTIFACTS_DESC,
    {
      artifact_type: z.string().optional().describe("Filter by artifact_type"),
      status: statusEnum.optional().describe("Filter by status"),
      scope: scopeEnum.nullable().optional().describe("Filter by scope"),
      tags: z.array(z.string()).optional().describe("Filter by tags (ANY match)"),
      limit: z.number().min(1).max(100).optional().describe("Max results (1-100, default 20)"),
      offset: z.number().min(0).optional().describe("Offset for pagination (default 0)"),
      order_by: listOrderByEnum.optional().describe("Sort field. Default: 'execution_order' when artifact_type filter is set, otherwise 'created_at'"),
      order_dir: orderDirEnum.optional().describe("Sort direction. Default: 'asc' for execution_order, 'desc' for created_at/updated_at"),
    },
    async (args) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (args.artifact_type) {
          conditions.push(`artifact_type = $${paramIdx++}`);
          params.push(args.artifact_type);
        }
        if (args.status) {
          conditions.push(`status = $${paramIdx++}`);
          params.push(args.status);
        }
        if (args.scope) {
          conditions.push(`scope = $${paramIdx++}`);
          params.push(args.scope);
        }
        if (args.tags && args.tags.length > 0) {
          conditions.push(`tags && $${paramIdx++}`);
          params.push(args.tags);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
        const offset = Math.max(args.offset ?? 0, 0);

        const typeFiltered = Boolean(args.artifact_type);
        const orderBy = args.order_by ?? (typeFiltered ? "execution_order" : "created_at");
        const defaultDir = orderBy === "execution_order" ? "asc" : "desc";
        const orderDir = (args.order_dir ?? defaultDir).toUpperCase();
        const orderClause = `ORDER BY ${orderBy} ${orderDir} NULLS LAST`;

        const countResult = await query<{ count: string }>(
          `SELECT COUNT(*) as count FROM artifacts ${where}`,
          params
        );
        const totalCount = parseInt(countResult.rows[0].count, 10);

        const dataResult = await query<ArtifactRow>(
          `SELECT * FROM artifacts ${where} ${orderClause} LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
          [...params, limit, offset]
        );

        return jsonResponse({
          artifacts: dataResult.rows.map(formatArtifactListItem),
          total_count: totalCount,
          limit,
          offset,
        });
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );

  // ── search_artifacts ─────────────────────────────────────────
  mcpServer.tool(
    "search_artifacts",
    SEARCH_ARTIFACTS_DESC,
    {
      query: z.string().describe("Full-text search query"),
      artifact_type: z.string().optional().describe("Filter by artifact_type"),
      status: statusEnum.optional().describe("Filter by status"),
      scope: scopeEnum.nullable().optional().describe("Filter by scope"),
      limit: z.number().min(1).max(50).optional().describe("Max results (1-50, default 10)"),
    },
    async (args) => {
      if (!args.query?.trim()) {
        return errorResponse("query is required", "VALIDATION_ERROR");
      }

      try {
        const conditions: string[] = [
          `to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, '')) @@ plainto_tsquery('english', $1)`,
        ];
        const params: unknown[] = [args.query];
        let paramIdx = 2;

        if (args.artifact_type) {
          conditions.push(`artifact_type = $${paramIdx++}`);
          params.push(args.artifact_type);
        }
        if (args.status) {
          conditions.push(`status = $${paramIdx++}`);
          params.push(args.status);
        }
        if (args.scope) {
          conditions.push(`scope = $${paramIdx++}`);
          params.push(args.scope);
        }

        const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
        const where = conditions.join(" AND ");

        const countResult = await query<{ count: string }>(
          `SELECT COUNT(*) as count FROM artifacts WHERE ${where}`,
          params
        );
        const totalCount = parseInt(countResult.rows[0].count, 10);

        const dataResult = await query<ArtifactRow & { rank: number }>(
          `SELECT *, ts_rank(
            to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, '')),
            plainto_tsquery('english', $1)
          ) AS rank
          FROM artifacts WHERE ${where}
          ORDER BY rank DESC
          LIMIT $${paramIdx}`,
          [...params, limit]
        );

        return jsonResponse({
          artifacts: dataResult.rows.map((row) => ({
            ...formatArtifact(row),
            rank: row.rank,
          })),
          total_count: totalCount,
        });
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );

  // ── update_artifact ──────────────────────────────────────────
  mcpServer.tool(
    "update_artifact",
    UPDATE_ARTIFACT_DESC,
    {
      id: z.string().describe("UUID of the artifact to update"),
      title: z.string().optional().describe("New title"),
      artifact_type: z.string().optional().describe("New artifact_type"),
      content: z.string().nullable().optional().describe("New inline content, or null to clear"),
      pointer: pointerSchema.nullable().optional().describe("New pointer, or null to clear"),
      status: statusEnum.optional().describe("New status — must follow valid transitions"),
      scope: scopeEnum.optional().describe("New scope"),
      tags: z.array(z.string()).optional().describe("New tags (full replacement)"),
      dependencies: z.array(z.string()).optional().describe("New dependencies (full replacement)"),
      execution_order: z.number().int().nullable().optional().describe("New execution_order, or null to clear"),
      related_task_ids: z.array(z.string()).optional().describe("New related task IDs (full replacement)"),
      metadata: z.record(z.unknown()).optional().describe("Metadata to merge (top-level keys)"),
    },
    async (args) => {
      try {
        const existing = await query<ArtifactRow>(
          "SELECT * FROM artifacts WHERE id = $1",
          [args.id]
        );
        if (existing.rows.length === 0) {
          return errorResponse(`Artifact not found: ${args.id}`, "NOT_FOUND");
        }
        const current = existing.rows[0];

        if (args.status !== undefined && !isValidStatusTransition(current.status, args.status)) {
          return errorResponse(
            `Invalid status transition: ${current.status} → ${args.status}`,
            "INVALID_STATUS_TRANSITION"
          );
        }

        // Ensure post-update we still have content or pointer.
        const nextContent =
          args.content !== undefined ? args.content : current.content;
        const nextPointer =
          args.pointer !== undefined ? args.pointer : current.pointer;
        const hasContent = typeof nextContent === "string" && nextContent.trim().length > 0;
        const hasPointer = nextPointer && typeof nextPointer === "object";
        if (!hasContent && !hasPointer) {
          return errorResponse(
            "Artifact must retain either 'content' or 'pointer' after update",
            "VALIDATION_ERROR"
          );
        }

        const sets: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (args.title !== undefined) {
          sets.push(`title = $${paramIdx++}`);
          params.push(args.title);
        }
        if (args.artifact_type !== undefined) {
          sets.push(`artifact_type = $${paramIdx++}`);
          params.push(args.artifact_type);
        }
        if (args.content !== undefined) {
          sets.push(`content = $${paramIdx++}`);
          params.push(args.content);
        }
        if (args.pointer !== undefined) {
          sets.push(`pointer = $${paramIdx++}::jsonb`);
          params.push(args.pointer ? JSON.stringify(args.pointer) : null);
        }
        if (args.status !== undefined) {
          sets.push(`status = $${paramIdx++}`);
          params.push(args.status);
        }
        if (args.scope !== undefined) {
          sets.push(`scope = $${paramIdx++}`);
          params.push(args.scope);
        }
        if (args.tags !== undefined) {
          sets.push(`tags = $${paramIdx++}`);
          params.push(args.tags);
        }
        if (args.dependencies !== undefined) {
          sets.push(`dependencies = $${paramIdx++}::uuid[]`);
          params.push(args.dependencies);
        }
        if (args.execution_order !== undefined) {
          sets.push(`execution_order = $${paramIdx++}`);
          params.push(args.execution_order);
        }
        if (args.related_task_ids !== undefined) {
          sets.push(`related_task_ids = $${paramIdx++}::uuid[]`);
          params.push(args.related_task_ids);
        }
        if (args.metadata !== undefined) {
          // Top-level merge — provided keys overwrite, existing preserved.
          sets.push(`metadata = metadata || $${paramIdx++}::jsonb`);
          params.push(JSON.stringify(args.metadata));
        }

        if (sets.length === 0) {
          return errorResponse("No updates provided", "VALIDATION_ERROR");
        }

        const result = await query<ArtifactRow>(
          `UPDATE artifacts SET ${sets.join(", ")} WHERE id = $${paramIdx} RETURNING *`,
          [...params, args.id]
        );
        const row = result.rows[0];

        const contentChanged =
          args.title !== undefined ||
          args.content !== undefined ||
          args.tags !== undefined ||
          args.artifact_type !== undefined;
        if (contentChanged) {
          indexArtifact(row.id, {
            title: row.title,
            content: row.content,
            artifact_type: row.artifact_type,
            tags: row.tags,
            status: row.status,
            scope: row.scope,
            created_at: row.created_at,
          }).catch((err) =>
            console.warn("[update_artifact] Background indexing failed:", err.message)
          );
        }

        return jsonResponse(formatArtifact(row));
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );
}
