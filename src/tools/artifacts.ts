import { createHash } from "node:crypto";
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

function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// Statuses where content is immutable — mutations are rejected.
const LOCKED_STATUSES = new Set(["ready", "executing", "completed"]);

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

// Basic RFC-4122 UUID shape check. Postgres will reject anything else when
// casting to uuid[], but catching it here gives us a clean VALIDATION_ERROR
// instead of a raw DB_ERROR with a driver-level message.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verify all UUIDs in a dependencies array exist as artifact rows. Returns
 * an object indicating whether validation passed or listing the offending
 * UUIDs. Caller is responsible for only invoking this when the array is
 * non-empty and well-formed.
 */
async function validateDependenciesExist(
  deps: string[]
): Promise<{ valid: true } | { valid: false; missing: string[] }> {
  if (deps.length === 0) return { valid: true };
  const result = await query<{ id: string }>(
    "SELECT id FROM artifacts WHERE id = ANY($1::uuid[])",
    [deps]
  );
  // Postgres returns uuid values in canonical lowercase regardless of input
  // casing. Compare case-insensitively so an uppercase or mixed-case input
  // (still a valid UUID) is not falsely reported as missing.
  const found = new Set(result.rows.map((r) => r.id.toLowerCase()));
  const missing = deps.filter((d) => !found.has(d.toLowerCase()));
  return missing.length === 0 ? { valid: true } : { valid: false, missing };
}

interface PgErrorShape {
  code?: string;
  constraint?: string;
}

/**
 * Detect the execution_order uniqueness constraint violation so we can
 * surface a clean EXECUTION_ORDER_CONFLICT instead of a raw DB_ERROR. All
 * other 23505 scenarios still fall through to DB_ERROR.
 */
function isExecutionOrderConflict(err: unknown): boolean {
  const pg = err as PgErrorShape;
  return (
    pg?.code === "23505" &&
    pg?.constraint === "idx_artifacts_type_exec_order_unique"
  );
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

const STORE_ARTIFACT_DESC = `Store a generated output as an artifact. Artifacts are the fourth content primitive — tracked, searchable, lifecycle-aware outputs that bridge planning and execution. Use for CC prompts, research reports, blog posts, templates, presentations — anything generated once and consumed later.

How artifacts differ from the other primitives:
- Tasks are action items with an open/completed lifecycle — "write the migration" is a task.
- Notes are permanent interpretation — decisions, patterns, takeaways. No lifecycle, no ordering.
- Handoffs are ephemeral session state.
- Artifacts are the concrete outputs produced by work. They have a status lifecycle (draft → ready → executing → completed) and can be ordered within a batch via execution_order.

Route content to the appropriate primitive — see create_note, create_task, store_handoff, and patch_handoff for guidance on what belongs elsewhere.

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

Integrity:
- 'execution_order' must be unique within an 'artifact_type'. Attempting to store a duplicate returns EXECUTION_ORDER_CONFLICT. Leave execution_order unset (null) if you do not need a fixed slot.
- 'dependencies' UUIDs are validated at write time — all referenced artifacts must exist. Orphaned references return VALIDATION_ERROR.

Returns {id, title, artifact_type, status, created_at}. Re-embeds on create; falls back to the pending queue if the embedding server is offline.`;

const GET_ARTIFACT_DESC = `Retrieve a single artifact by its UUID. Returns the full artifact record including content, pointer, dependencies, and metadata.`;

const LIST_ARTIFACTS_DESC = `List artifacts with optional filters and pagination. Returns metadata only (id, title, artifact_type, status, scope, tags, execution_order, timestamps) — NOT the full content. Call get_artifact to retrieve a body.

This is the primary retrieval tool for execution sessions. Calling list_artifacts({artifact_type: 'cc-prompt', status: 'ready'}) returns the next ordered batch of prompts ready to run. Defaults to execution_order ASC when filtering by artifact_type, otherwise created_at DESC.

Filters (all optional):
- artifact_type — e.g., 'cc-prompt', 'research', 'blog-post'
- status — 'draft' | 'ready' | 'executing' | 'completed' | 'superseded'
- scope — 'work' | 'personal' | 'shared'. When omitted, returns artifacts across all scopes.
- tags — ANY-match array`;

const UPDATE_ARTIFACT_DESC = `Update fields on an existing artifact. All fields are optional — only provided fields are modified. Tags, dependencies, and related_task_ids are full-replacement (provide complete arrays). Metadata merges at the top level (provided keys overwrite; omitted keys are preserved).

Status transitions are enforced:
- draft → ready, superseded
- ready → executing, draft, superseded
- executing → completed, ready, superseded
- completed → superseded
- Any state → superseded (retirement)

Integrity:
- 'execution_order' must be unique within an 'artifact_type'. Moving an artifact onto an already-used slot returns EXECUTION_ORDER_CONFLICT.
- 'dependencies' UUIDs are validated at write time. Pass an empty array to clear; any non-empty array must reference existing artifacts or returns VALIDATION_ERROR.

Re-embeds when title, content, tags, or artifact_type change.`;

const SEARCH_ARTIFACTS_DESC = `Full-text search across artifact titles and content using PostgreSQL FTS with English stemming. Returns matching artifacts WITH full content (unlike list_artifacts), ranked by relevance.

CALL THIS WHEN:
- The user references a CC prompt, research document, or generated output
- You are about to create a new artifact (check for duplicates or superseded versions)
- The conversation involves pipeline execution status

DO NOT CALL WHEN:
- list_artifacts with status filter already answered the question in this turn

CONSEQUENCE OF SKIPPING: Duplicate or superseded artifacts will be recreated.

For cross-type semantic search that finds artifacts alongside handoffs, tasks, and notes, use search_context with content_types: ['artifact'] instead — this tool only searches within the artifacts table.

Filters: artifact_type, status, scope. When scope is omitted, searches across all scopes (work, personal, shared).`;

// ── Tool Registration ────────────────────────────────────────────

export function registerArtifactTools(mcpServer: McpServer): void {
  // ── store_artifact ───────────────────────────────────────────
  mcpServer.tool(
    "store_artifact",
    STORE_ARTIFACT_DESC,
    {
      title: z.string().describe("Short descriptive title for the artifact"),
      artifact_type: z.string().describe("Kind of artifact, e.g., 'cc-prompt', 'research', 'blog-post', 'template', 'presentation'. Free-form — new types are valid."),
      scope: scopeEnum.describe(
        "'work', 'personal', or 'shared' (required). Pass 'shared' when the artifact is reusable across contexts (architecture templates, OSS artifacts)."
      ),
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

      if (args.dependencies && args.dependencies.length > 0) {
        const malformed = args.dependencies.filter((d) => !UUID_RE.test(d));
        if (malformed.length > 0) {
          return errorResponse(
            `Malformed UUID in dependencies: ${malformed.join(", ")}`,
            "VALIDATION_ERROR"
          );
        }
        try {
          const check = await validateDependenciesExist(args.dependencies);
          if (!check.valid) {
            return errorResponse(
              `Dependency artifact IDs do not exist: ${check.missing.join(", ")}`,
              "VALIDATION_ERROR"
            );
          }
        } catch (err) {
          return errorResponse(
            `Failed to validate dependencies: ${(err as Error).message}`,
            "DB_ERROR"
          );
        }
      }

      const normalizedType = args.artifact_type.trim().toLowerCase();
      const status = args.status ?? "draft";

      const callerMeta: Record<string, unknown> = { ...(args.metadata ?? {}) };
      // content_hash is the single source of truth for artifact content identity
      // and must be tamper-resistant: only the server computes it, from the actual
      // stored content. Drop any caller-supplied value unconditionally so a pointer-
      // only store (no content to hash) cannot smuggle in a forged hash, then
      // recompute below when real content is present.
      delete callerMeta.content_hash;
      const finalMetadata: Record<string, unknown> = callerMeta;
      if (hasContent) {
        finalMetadata.content_hash = computeContentHash(args.content!);
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
            normalizedType,
            args.content ?? null,
            args.pointer ? JSON.stringify(args.pointer) : null,
            status,
            args.scope,
            args.tags ?? [],
            args.dependencies ?? [],
            args.execution_order ?? null,
            args.related_task_ids ?? [],
            JSON.stringify(finalMetadata),
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
          console.warn("[store_artifact] Background indexing failed:", (err as Error).message)
        );
        return jsonResponse({
          id: row.id,
          title: row.title,
          artifact_type: row.artifact_type,
          status: row.status,
          created_at: row.created_at,
        });
      } catch (err) {
        if (isExecutionOrderConflict(err)) {
          return errorResponse(
            `execution_order ${args.execution_order} is already used for artifact_type '${normalizedType}'`,
            "EXECUTION_ORDER_CONFLICT"
          );
        }
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
          const normalizedTypeFilter = args.artifact_type.trim().toLowerCase();
          conditions.push(`artifact_type = $${paramIdx++}`);
          params.push(normalizedTypeFilter);
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
          ...(args.status === "ready" ? { next_step: "These artifacts are queued for pipeline execution. Do not manually update their status -- the pipeline manages ready -> executing -> completed automatically." } : {}),
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
          const normalizedTypeFilter = args.artifact_type.trim().toLowerCase();
          conditions.push(`artifact_type = $${paramIdx++}`);
          params.push(normalizedTypeFilter);
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
          next_step: totalCount > 0
            ? "Artifacts found. Check status (draft/ready/executing/completed/superseded) before creating related artifacts."
            : "No matching artifacts found.",
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
      let current: ArtifactRow;
      try {
        const existing = await query<ArtifactRow>(
          "SELECT * FROM artifacts WHERE id = $1",
          [args.id]
        );
        if (existing.rows.length === 0) {
          return errorResponse(`Artifact not found: ${args.id}`, "NOT_FOUND");
        }
        current = existing.rows[0];
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }

      if (args.status !== undefined && !isValidStatusTransition(current.status, args.status)) {
        return errorResponse(
          `Invalid status transition: ${current.status} → ${args.status}`,
          "INVALID_STATUS_TRANSITION"
        );
      }

      if (args.content !== undefined && LOCKED_STATUSES.has(current.status)) {
        return errorResponse(
          `Cannot modify content of a locked artifact (status: ${current.status})`,
          "CANNOT_MODIFY_LOCKED_ARTIFACT"
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

      if (args.dependencies !== undefined && args.dependencies.length > 0) {
        const malformed = args.dependencies.filter((d) => !UUID_RE.test(d));
        if (malformed.length > 0) {
          return errorResponse(
            `Malformed UUID in dependencies: ${malformed.join(", ")}`,
            "VALIDATION_ERROR"
          );
        }
        try {
          const check = await validateDependenciesExist(args.dependencies);
          if (!check.valid) {
            return errorResponse(
              `Dependency artifact IDs do not exist: ${check.missing.join(", ")}`,
              "VALIDATION_ERROR"
            );
          }
        } catch (err) {
          return errorResponse(
            `Failed to validate dependencies: ${(err as Error).message}`,
            "DB_ERROR"
          );
        }
      }

      const normalizedType = args.artifact_type !== undefined
        ? args.artifact_type.trim().toLowerCase()
        : undefined;

      try {
        const sets: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (args.title !== undefined) {
          sets.push(`title = $${paramIdx++}`);
          params.push(args.title);
        }
        if (normalizedType !== undefined) {
          sets.push(`artifact_type = $${paramIdx++}`);
          params.push(normalizedType);
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

        // No user-supplied updates — short-circuit before the auto content_hash
        // recompute below, which would otherwise always touch metadata when the
        // artifact has content and mask the "no updates" case.
        if (sets.length === 0 && args.metadata === undefined) {
          return errorResponse("No updates provided", "VALIDATION_ERROR");
        }

        // content_hash lifecycle: one rule — if the artifact has content, it
        // has a hash. The hash is always server-computed from the effective
        // post-update content (new content if provided, existing row content
        // otherwise). Any caller-supplied content_hash is stripped first.
        // When content is cleared (to a pointer-only artifact), the hash is
        // removed from metadata so it can't outlive the content it described.
        const callerMeta = args.metadata !== undefined
          ? (() => {
              const { content_hash: _stripped, ...rest } =
                args.metadata as Record<string, unknown>;
              return rest;
            })()
          : undefined;

        const effectiveContent =
          args.content !== undefined ? args.content : current.content;
        const hasEffectiveContent =
          typeof effectiveContent === "string" &&
          effectiveContent.trim().length > 0;

        if (hasEffectiveContent) {
          const merged = {
            ...(callerMeta ?? {}),
            content_hash: computeContentHash(effectiveContent),
          };
          sets.push(`metadata = metadata || $${paramIdx++}::jsonb`);
          params.push(JSON.stringify(merged));
        } else if (callerMeta !== undefined || args.content !== undefined) {
          // No effective content post-update: strip any stale content_hash
          // before merging caller metadata. Stripping is a no-op if the key
          // isn't present, so it's safe even when no hash existed.
          sets.push(`metadata = (metadata - 'content_hash') || $${paramIdx++}::jsonb`);
          params.push(JSON.stringify(callerMeta ?? {}));
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
            console.warn("[update_artifact] Background indexing failed:", (err as Error).message)
          );
        }

        return jsonResponse(formatArtifact(row));
      } catch (err) {
        if (isExecutionOrderConflict(err)) {
          const effectiveType = normalizedType ?? current.artifact_type;
          const effectiveOrder =
            args.execution_order !== undefined
              ? args.execution_order
              : current.execution_order;
          return errorResponse(
            `execution_order ${effectiveOrder} is already used for artifact_type '${effectiveType}'`,
            "EXECUTION_ORDER_CONFLICT"
          );
        }
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );
}
