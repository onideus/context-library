import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool } from "./tool-aliases.js";
import { query } from "../db/client.js";
import { withTransaction, appendChange } from "../db/changes.js";
import { indexArtifact } from "../embeddings/indexer.js";
import { applyEdits } from "./note-edits.js";

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

Route content to the appropriate primitive — see create_note, create_task, create_handoff, and update_handoff for guidance on what belongs elsewhere.

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

Use 'execution_order' to sequence artifacts within a batch (e.g., a chain of CC prompts where 1 builds infrastructure, 2 adds tests, 3 updates docs). Use 'dependencies' for explicit cross-artifact ordering when execution_order is not enough. Use 'metadata' for flexible fields — see the pipeline metadata contract below.

Pipeline metadata contract (cc-prompt artifacts consumed by a pipeline interceptor):
- 'target_repo' (REQUIRED for pipeline-consumed artifacts) — repository name the interceptor should check out. An interceptor watching for ready cc-prompts will demote any artifact missing this key back to draft; without target_repo it does not know where to execute.
- 'target_org' (optional) — org/owner qualifying target_repo. Defaults per interceptor config when omitted.
- 'content_hash' — SHA-256 of 'content'. Auto-computed server-side on store and on promotion to a locked status ('ready'/'executing'/'completed'); callers must NOT supply it. Any caller-supplied value is dropped. The interceptor recomputes and verifies at execution time; a mismatch aborts the run.
- 'branch_target' (DEPRECATED) — kept for one release for reader compatibility. New artifacts should use 'target_repo' instead. Interceptors still read branch_target if target_repo is absent, but that fallback is going away.
- Other conventional keys: 'base_branch', 'working_branch', 'model', 'surface', 'batch_label', 'risk_hint'. Free-form — deployments extend as needed.

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

Concurrent status transitions are gated by a conditional UPDATE. When status is being changed, the write only lands if the row is still in the caller's expected status (the row's status as of the read at the top of this call, or 'expected_status' when supplied). A concurrent transition — including a competing interceptor's ready → executing claim — returns STATUS_CONFLICT with the current server state instead of overwriting. This is how the interceptor claim mutex works: two interceptors racing on ready → executing produce one success and one STATUS_CONFLICT, no silent overwrite.

Pipeline metadata contract (cc-prompt artifacts):
- 'target_repo' — REQUIRED for pipeline-consumed artifacts. An interceptor watching for ready cc-prompts will demote any artifact missing this key back to draft. If you promote to ready without target_repo set, expect the artifact to be demoted; add it via metadata: {target_repo: "..."} in the same update or an earlier one.
- 'target_org' — optional, defaults per interceptor config.
- 'content_hash' — SHA-256 of 'content', auto-computed server-side. Callers must NOT supply it — any supplied value is stripped from metadata updates before merge. On promotion to a locked status ('ready'/'executing'/'completed'), the hash is recomputed from the effective content. Reverting to 'draft' keeps the hash (the artifact still has content). The interceptor verifies this hash at execution time.
- 'branch_target' (DEPRECATED) — kept one release for reader compatibility; prefer 'target_repo'.

Integrity:
- 'execution_order' must be unique within an 'artifact_type'. Moving an artifact onto an already-used slot returns EXECUTION_ORDER_CONFLICT.
- 'dependencies' UUIDs are validated at write time. Pass an empty array to clear; any non-empty array must reference existing artifacts or returns VALIDATION_ERROR.

Re-embeds when title, content, tags, or artifact_type change.

For small edits to the content of a large artifact, prefer edit_artifact (exact-text replace) — it avoids resending the full content.`;

const PATCH_ARTIFACT_DESC = `Edit an artifact's content by replacing exact spans of text, without resending the whole body. Prefer this over update_artifact for content changes that touch a small part of a large artifact (fixing a paragraph of a long prompt, updating a value in a spec, rewording a section of a report) — update_artifact requires the complete new content, costs tokens for the entire artifact, and risks silently changing text you didn't mean to touch.

Do NOT use this to change title, tags, metadata, status, scope, pointer, or execution_order, or to replace most of the content — use update_artifact for those.

Workflow: call get_artifact first so every old_str is copied exactly from the current content, and pass its metadata.content_hash as expected_content_hash.

Parameters:
- id (required): UUID of the artifact to edit.
- edits (required, 1–50 items): ordered list of {old_str, new_str, replace_all?}. Edits apply in order, each against the result of the previous one, so a later edit can match text an earlier edit inserted. All edits apply or none do.
  - old_str (required, non-empty): the exact text to find. Literal match — case-sensitive, whitespace-sensitive, NOT a regex (characters like . * $ ( ) are matched as-is).
  - new_str (required, may be empty): the replacement text, inserted verbatim (no $& / $1 substitution). An empty string deletes old_str.
  - replace_all (optional, default false): when true, replace every occurrence (at least one must exist); when false, old_str must occur exactly once.
- expected_content_hash (optional): the content_hash you last saw (metadata.content_hash from get_artifact, or content_hash from a previous edit_artifact response). Enforced whenever present; omit for last-writer-wins.

Locked artifacts: content of an artifact in 'ready', 'executing', or 'completed' is immutable, exactly as with update_artifact. Move it back to 'draft' with update_artifact first. 'draft' and 'superseded' artifacts can be patched; the status is unchanged.

Content hash: metadata.content_hash (SHA-256 of content) is recomputed server-side from the patched content, as update_artifact does. There is no way to supply it. Every other metadata key is preserved.

Errors (returned as {error: true, message, code, ...}):
- NOT_FOUND — no artifact with that id.
- CANNOT_MODIFY_LOCKED_ARTIFACT — the artifact is 'ready', 'executing', or 'completed'. Nothing is written.
- VALIDATION_ERROR — the artifact has no inline content (pointer-only), an old_str is empty, or the edits would leave the content empty (an artifact must keep content or a pointer). Nothing is written.
- VERSION_CONFLICT — expected_content_hash does not match: the content changed since you read it, so nothing is written. current_content_hash is the hash as it is now — re-read with get_artifact, copy old_str from the current content, and retry. Checked before matching, so it takes precedence over NO_MATCH / AMBIGUOUS_MATCH.
- NO_MATCH — the edit at edit_index (zero-based) does not occur in the content as it stands after the earlier edits (match_count: 0). Nothing is written. Re-read with get_artifact and copy the text exactly.
- AMBIGUOUS_MATCH — the edit at edit_index occurs match_count times and replace_all is false. Nothing is written. Widen old_str with surrounding text until it is unique, or pass replace_all: true.

If the edits leave the content identical (every new_str equal to its old_str), the call is a no-op: changed is false and nothing is written.

Returns a compact confirmation WITHOUT the content: {id, title, status, changed, content_hash, previous_content_hash, replacements, content_length, updated_at}. replacements lists the number of occurrences replaced by each edit, in order; content_length is the new content length (JavaScript string length, i.e. UTF-16 code units). Re-embeds the artifact for search when the content changed.`;

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
  // ── create_artifact ──────────────────────────────────────────
  registerTool(
    mcpServer,
    "create_artifact",
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
      metadata: z.record(z.string(), z.unknown()).optional().describe("Flexible metadata. Pipeline contract for cc-prompt artifacts: 'target_repo' (REQUIRED — interceptor demotes ready artifacts without it), 'target_org' (optional, defaults per interceptor config), 'base_branch', 'working_branch', 'model', 'surface', 'batch_label', 'risk_hint'. 'content_hash' is auto-computed server-side — do NOT supply it; any caller-supplied value is stripped. 'branch_target' is DEPRECATED in favor of 'target_repo' (kept one release for reader compatibility)."),
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
        const row = await withTransaction(async (client) => {
          const result = await client.query<ArtifactRow>(
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
          const inserted = result.rows[0];
          await appendChange(client, "artifact", inserted.id, "insert");
          return inserted;
        });
        indexArtifact(row.id, {
          title: row.title,
          content: row.content,
          artifact_type: row.artifact_type,
          tags: row.tags,
          status: row.status,
          scope: row.scope,
          created_at: row.created_at,
        }).catch((err) =>
          console.warn("[create_artifact] Background indexing failed:", (err as Error).message)
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
      metadata: z.record(z.string(), z.unknown()).optional().describe("Metadata to merge (top-level keys). Pipeline contract for cc-prompt artifacts: set 'target_repo' (REQUIRED — interceptor demotes ready artifacts without it) and optionally 'target_org'. 'content_hash' is auto-computed server-side and any caller-supplied value is stripped. 'branch_target' is DEPRECATED in favor of 'target_repo'."),
      expected_status: statusEnum.optional().describe(
        "Optimistic concurrency precondition. When provided AND status is being changed, the UPDATE runs conditionally against this value — if the row is no longer in expected_status, returns STATUS_CONFLICT with current server state instead of silently overwriting a concurrent transition. When omitted, the row's current status (as of the read at the top of this call) is used as the precondition."
      ),
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

        // Conditional-UPDATE guard (item 3 from the June 10 review): when this
        // update mutates status, gate the write on the row still being in the
        // caller's expected status (defaults to whatever we just read). A
        // concurrent transition means the caller's premise is wrong and we
        // return STATUS_CONFLICT with the current server state, letting the
        // caller reconcile instead of silently reverting the other writer.
        const statusWillChange = args.status !== undefined && args.status !== current.status;
        const expectedStatus = args.expected_status ?? current.status;
        const idParamPos = paramIdx;
        const conditionalClause = statusWillChange
          ? ` AND status = $${paramIdx + 1}`
          : "";
        const finalParams = statusWillChange
          ? [...params, args.id, expectedStatus]
          : [...params, args.id];

        const row = await withTransaction(async (client) => {
          const upd = await client.query<ArtifactRow>(
            `UPDATE artifacts SET ${sets.join(", ")} WHERE id = $${idParamPos}${conditionalClause} RETURNING *`,
            finalParams
          );
          if (upd.rows.length === 0) return null;
          await appendChange(client, "artifact", args.id, "update");
          return upd.rows[0];
        });

        if (row === null) {
          // Conditional lost — re-read so the caller sees whichever transition won.
          const currentRes = await query<ArtifactRow>(
            "SELECT * FROM artifacts WHERE id = $1",
            [args.id]
          );
          if (currentRes.rows.length === 0) {
            return errorResponse(`Artifact not found: ${args.id}`, "NOT_FOUND");
          }
          return jsonResponse({
            error: true,
            code: "STATUS_CONFLICT",
            message: `Artifact status is no longer ${expectedStatus}; current status is ${currentRes.rows[0].status}`,
            current: formatArtifact(currentRes.rows[0]),
          });
        }

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

  // ── edit_artifact ────────────────────────────────────────────
  registerTool(
    mcpServer,
    "edit_artifact",
    PATCH_ARTIFACT_DESC,
    {
      id: z.string().describe("UUID of the artifact to edit"),
      edits: z
        .array(
          z.object({
            old_str: z
              .string()
              .min(1)
              .describe("Exact text to find (literal, case- and whitespace-sensitive, not a regex)"),
            new_str: z
              .string()
              .describe("Replacement text, inserted verbatim. Empty string deletes old_str"),
            replace_all: z
              .boolean()
              .optional()
              .describe("Replace every occurrence instead of requiring exactly one (default false)"),
          })
        )
        .min(1)
        .max(50)
        .describe("Ordered edits (1–50), each applied to the result of the previous one. All apply or none do."),
      expected_content_hash: z.string().optional().describe(
        "Optimistic-concurrency precondition: the content_hash you last saw (metadata.content_hash from get_artifact, or content_hash from a previous edit_artifact). Enforced whenever present; on mismatch nothing is written and VERSION_CONFLICT returns current_content_hash. Omit for last-writer-wins."
      ),
    },
    async (args) => {
      if (!UUID_RE.test(args.id)) {
        return errorResponse(`Artifact not found: ${args.id}`, "NOT_FOUND");
      }

      type PatchOutcome =
        | { kind: "error"; body: Record<string, unknown> }
        | {
            kind: "ok";
            row: ArtifactRow;
            changed: boolean;
            previousHash: string;
            replacements: number[];
          };

      let outcome: PatchOutcome;
      try {
        outcome = await withTransaction(async (client): Promise<PatchOutcome> => {
          const locked = await client.query<ArtifactRow>(
            "SELECT * FROM artifacts WHERE id = $1 FOR UPDATE",
            [args.id]
          );
          if (locked.rows.length === 0) {
            return {
              kind: "error",
              body: { error: true, message: `Artifact not found: ${args.id}`, code: "NOT_FOUND" },
            };
          }
          const current = locked.rows[0];

          if (LOCKED_STATUSES.has(current.status)) {
            return {
              kind: "error",
              body: {
                error: true,
                message: `Cannot modify content of a locked artifact (status: ${current.status})`,
                code: "CANNOT_MODIFY_LOCKED_ARTIFACT",
              },
            };
          }

          if (typeof current.content !== "string" || current.content.length === 0) {
            return {
              kind: "error",
              body: {
                error: true,
                message: "Artifact has no inline content to patch (it is pointer-only). Use update_artifact to set content.",
                code: "VALIDATION_ERROR",
              },
            };
          }

          const storedHash = current.metadata?.content_hash;
          const currentHash =
            typeof storedHash === "string" ? storedHash : computeContentHash(current.content);

          // A stale hash means old_str was copied from content that has since
          // changed, so it outranks NO_MATCH / AMBIGUOUS_MATCH.
          if (
            args.expected_content_hash !== undefined &&
            args.expected_content_hash !== currentHash
          ) {
            return {
              kind: "error",
              body: {
                error: true,
                message: "Artifact content changed since expected_content_hash was read. Call get_artifact and retry against the current content.",
                code: "VERSION_CONFLICT",
                current_content_hash: currentHash,
              },
            };
          }

          const result = applyEdits(current.content, args.edits);
          if (!result.ok) {
            const message =
              result.code === "NO_MATCH"
                ? `edits[${result.edit_index}].old_str was not found in the artifact content (after applying earlier edits). Call get_artifact and copy the text exactly.`
                : `edits[${result.edit_index}].old_str matches ${result.match_count} times. Widen old_str with surrounding text to make it unique, or pass replace_all: true.`;
            return {
              kind: "error",
              body: {
                error: true,
                message,
                code: result.code,
                edit_index: result.edit_index,
                match_count: result.match_count,
              },
            };
          }

          if (result.content === current.content) {
            return {
              kind: "ok",
              row: current,
              changed: false,
              previousHash: currentHash,
              replacements: result.replacements,
            };
          }

          // Whitespace-only counts as empty, matching create_artifact/update_artifact.
          if (result.content.trim().length === 0) {
            return {
              kind: "error",
              body: {
                error: true,
                message: "Edits would leave the artifact content empty; an artifact must keep content or a pointer. Use update_artifact to replace content with a pointer.",
                code: "VALIDATION_ERROR",
              },
            };
          }

          // Same content_hash rule as update_artifact: server-computed from the
          // new content and merged into metadata, every other key preserved.
          const upd = await client.query<ArtifactRow>(
            `UPDATE artifacts SET content = $1, metadata = metadata || $2::jsonb WHERE id = $3 RETURNING *`,
            [
              result.content,
              JSON.stringify({ content_hash: computeContentHash(result.content) }),
              args.id,
            ]
          );
          await appendChange(client, "artifact", args.id, "update");
          return {
            kind: "ok",
            row: upd.rows[0],
            changed: true,
            previousHash: currentHash,
            replacements: result.replacements,
          };
        });
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }

      if (outcome.kind === "error") return jsonResponse(outcome.body);

      const { row, changed, previousHash, replacements } = outcome;
      if (changed) {
        indexArtifact(row.id, {
          title: row.title,
          content: row.content,
          artifact_type: row.artifact_type,
          tags: row.tags,
          status: row.status,
          scope: row.scope,
          created_at: row.created_at,
        }).catch((err) =>
          console.warn("[edit_artifact] Background indexing failed:", (err as Error).message)
        );
      }

      const content = row.content ?? "";
      return jsonResponse({
        id: row.id,
        title: row.title,
        status: row.status,
        changed,
        content_hash: changed ? computeContentHash(content) : previousHash,
        previous_content_hash: previousHash,
        replacements,
        content_length: content.length,
        updated_at: row.updated_at,
      });
    }
  );
}
