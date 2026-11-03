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

const STORE_ARTIFACT_DESC = `Save a generated output for later use: a prompt for a coding agent (artifact_type 'cc-prompt'), a report, a template. Give inline content, a pointer, or both. ready, executing and completed lock the content; update_artifact enforces status transitions.

cc-prompts: metadata.target_repo is required, or the pipeline interceptor demotes the artifact from ready back to draft; target_org is optional; content_hash is server-computed (a supplied value is dropped); branch_target is deprecated (use target_repo).

execution_order is unique per artifact_type (EXECUTION_ORDER_CONFLICT); dependencies must exist (VALIDATION_ERROR).

Returns: id, title, artifact_type, status, created_at.`;

const GET_ARTIFACT_DESC = `Get one artifact by id with every field: content, pointer, status, dependencies, execution_order, metadata and the rest. metadata.content_hash is edit_artifact's expected_content_hash.

Returns the artifact. NOT_FOUND if missing.`;

const LIST_ARTIFACTS_DESC = `List artifacts by filter, without content or metadata (use get_artifact). artifact_type 'cc-prompt' + status 'ready' is the run queue, in execution order. Default order: execution_order ascending with an artifact_type filter, else newest first.

Returns: artifacts [{id, title, artifact_type, status, scope, tags, execution_order, timestamps}], total_count, limit, offset, next_step.`;

const UPDATE_ARTIFACT_DESC = `Change fields of an artifact; omitted fields are kept. tags, dependencies and related_task_ids replace the whole list; metadata merges top-level keys.

Enforced transitions (else INVALID_STATUS_TRANSITION): draft → ready; ready → executing | draft; executing → completed | ready; and any status → superseded. Content of a ready, executing or completed artifact is locked (CANNOT_MODIFY_LOCKED_ARTIFACT): move it to draft in a separate call first.

A status change lands only if the status is still expected_status (default: as read at the call's start), else STATUS_CONFLICT with current. Without a status change expected_status is not checked.

cc-prompts: set metadata.target_repo before or when promoting to ready, or the interceptor demotes it to draft. content_hash is server-computed (a supplied one is stripped); branch_target is deprecated.

execution_order is unique per artifact_type (EXECUTION_ORDER_CONFLICT); dependencies must exist (VALIDATION_ERROR); content or pointer must remain. Returns the artifact.`;

const PATCH_ARTIFACT_DESC = `Replace exact text inside an artifact's content without resending it (other fields: update_artifact). Call get_artifact first, copy each old_str exactly, and pass metadata.content_hash as expected_content_hash.

Edits apply in order, each to the previous result; all apply or none do. old_str must occur exactly once unless replace_all is true. content_hash is recomputed.

Errors (nothing written): NOT_FOUND; CANNOT_MODIFY_LOCKED_ARTIFACT (ready, executing, completed: move to draft first); VALIDATION_ERROR (no inline content, or empty result); VERSION_CONFLICT (stale hash, checked first; gives current_content_hash); NO_MATCH / AMBIGUOUS_MATCH with edit_index, match_count.

Returns, without content: id, title, status, changed, content_hash, previous_content_hash, replacements, content_length, updated_at.`;

const SEARCH_ARTIFACTS_DESC = `Keyword search (full-text, English stemming) over artifact titles and content, ranked. Returns full artifacts with content.

CALL THIS WHEN: the user refers to a prompt, report or other generated output; before create_artifact, to find duplicates or earlier versions.
DO NOT CALL WHEN: list_artifacts with a status filter already answered it this turn.
CONSEQUENCE OF SKIPPING: duplicate or superseded artifacts get recreated.

Returns: artifacts[] (with rank), total_count, next_step.`;

// ── Tool Registration ────────────────────────────────────────────

export function registerArtifactTools(mcpServer: McpServer): void {
  // ── create_artifact ──────────────────────────────────────────
  registerTool(
    mcpServer,
    "create_artifact",
    STORE_ARTIFACT_DESC,
    {
      title: z.string().describe("Short descriptive title."),
      artifact_type: z.string().describe("Kind of artifact, free-form, e.g. 'cc-prompt', 'research', 'template'. Stored lowercase."),
      scope: scopeEnum.describe(
        "'work', 'personal', or 'shared' (reusable across both). Ask when unclear."
      ),
      content: z.string().optional().describe("Inline body. Required unless pointer is given."),
      pointer: pointerSchema.optional().describe("External location: {type:'git', repo, branch, path} | {type:'local', path} | {type:'url', href}. Required unless content is given."),
      status: statusEnum.optional().describe("Initial status (default 'draft')."),
      tags: z.array(z.string()).optional().describe("Free-form tags."),
      dependencies: z.array(z.string()).optional().describe("UUIDs of artifacts that must complete before this one; each must exist."),
      execution_order: z.number().int().optional().describe("Position within a batch of this artifact_type (1, 2, 3…); unique per type."),
      related_task_ids: z.array(z.string()).optional().describe("UUIDs of related tasks."),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Free-form keys. cc-prompts need target_repo; optional target_org, base_branch, working_branch, model, batch_label. Never send content_hash."),
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
      id: z.string().describe("Artifact id (UUID)."),
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
      artifact_type: z.string().optional().describe("Type filter (case-insensitive)."),
      status: statusEnum.optional().describe("Status filter."),
      scope: scopeEnum.nullable().optional().describe("Scope filter; omit or null = all."),
      tags: z.array(z.string()).optional().describe("Match artifacts with ANY of these tags."),
      limit: z.number().min(1).max(100).optional().describe("Max results (default 20)."),
      offset: z.number().min(0).optional().describe("Rows to skip (default 0)."),
      order_by: listOrderByEnum.optional().describe("Sort field; default 'execution_order' with an artifact_type filter, else 'created_at'."),
      order_dir: orderDirEnum.optional().describe("Default 'asc' for execution_order, 'desc' otherwise."),
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
      query: z.string().describe("Search words; every word must match (stemmed)."),
      artifact_type: z.string().optional().describe("Type filter (case-insensitive)."),
      status: statusEnum.optional().describe("Status filter."),
      scope: scopeEnum.nullable().optional().describe("Scope filter; omit or null = all."),
      limit: z.number().min(1).max(50).optional().describe("Max results (default 10)."),
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
      id: z.string().describe("Artifact id (UUID)."),
      title: z.string().optional().describe("New title."),
      artifact_type: z.string().optional().describe("New type (stored lowercase)."),
      content: z.string().nullable().optional().describe("New inline content, replacing the old; null clears. Rejected while ready, executing or completed."),
      pointer: pointerSchema.nullable().optional().describe("New pointer; null clears."),
      status: statusEnum.optional().describe("New status; must be an allowed transition."),
      scope: scopeEnum.optional().describe("New scope."),
      tags: z.array(z.string()).optional().describe("New tags; replaces the whole list."),
      dependencies: z.array(z.string()).optional().describe("Artifact UUIDs; replaces the whole list ([] clears). Each must exist."),
      execution_order: z.number().int().nullable().optional().describe("New position within the artifact_type, unique per type; null clears."),
      related_task_ids: z.array(z.string()).optional().describe("Related task UUIDs; replaces the whole list."),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Keys to merge into metadata (each replaces its value). cc-prompts need target_repo. content_hash is stripped."),
      expected_status: statusEnum.optional().describe(
        "Status you expect the artifact to have; checked only when this call changes status (STATUS_CONFLICT)."
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
      id: z.string().describe("Artifact id (UUID)."),
      edits: z
        .array(
          z.object({
            old_str: z
              .string()
              .min(1)
              .describe("Exact text to find: literal, case- and whitespace-sensitive, not a regex."),
            new_str: z
              .string()
              .describe("Replacement text, inserted verbatim; an empty string deletes old_str."),
            replace_all: z
              .boolean()
              .optional()
              .describe("Replace every occurrence instead of requiring exactly one (default false)."),
          })
        )
        .min(1)
        .max(50)
        .describe("Exact-text replacements, applied in order."),
      expected_content_hash: z.string().optional().describe(
        "content_hash you last read (get_artifact's metadata.content_hash or a previous edit). Mismatch: VERSION_CONFLICT, nothing written."
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
