import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { query } from "../db/client.js";
import { indexTask } from "../embeddings/indexer.js";
import { validateStringLength, PayloadTooLargeError, LIMITS } from "./validation.js";

// ── Types ────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  title: string;
  context: string | null;
  status: string;
  scope: string;
  priority: string | null;
  tags: string[];
  blocked_reason: string | null;
  scheduled_date: string | null;
  due_date: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

function formatTask(row: TaskRow) {
  return {
    id: row.id,
    title: row.title,
    context: row.context,
    status: row.status,
    scope: row.scope,
    priority: row.priority,
    tags: row.tags || [],
    blocked_reason: row.blocked_reason,
    scheduled_date: row.scheduled_date,
    due_date: row.due_date,
    completed_at: row.completed_at,
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

function payloadTooLargeResponse(err: PayloadTooLargeError) {
  return jsonResponse({
    error: true,
    code: "PAYLOAD_TOO_LARGE",
    message: err.message,
    field: err.field,
    actual: err.actual,
    max: err.max,
  });
}

function validateTaskFields(args: {
  title?: string;
  context?: string | null;
  blocked_reason?: string | null;
}): void {
  validateStringLength(args.title, LIMITS.TASK_TITLE_CHARS, "title");
  validateStringLength(args.context, LIMITS.TASK_CONTEXT_CHARS, "context");
  validateStringLength(
    args.blocked_reason,
    LIMITS.TASK_BLOCKED_REASON_CHARS,
    "blocked_reason"
  );
}

// ── Zod Schemas ──────────────────────────────────────────────────

const statusEnum = z.enum(["open", "completed", "deferred", "cancelled"]);
const scopeEnum = z.enum(["work", "personal"]);
const priorityEnum = z.enum(["critical", "high", "normal", "low"]);
const orderByEnum = z.enum(["created_at", "updated_at", "due_date", "scheduled_date", "priority"]);
const orderDirEnum = z.enum(["asc", "desc"]);

// ── Tool Descriptions ────────────────────────────────────────────

const CREATE_TASK_DESC = `Create a new task with title, scope, and optional metadata. Tasks start as 'open' by default. Use scope to separate work from personal items. Tags provide free-form categorization. Set blocked_reason if the task can't proceed yet.

This is the authoritative task store — do not maintain parallel task lists in handoff state or external systems. All task tracking should flow through create_task, update_task, and list_tasks.`;

const GET_TASK_DESC = `Retrieve a single task by its UUID. Returns all fields including timestamps and tags.`;

const LIST_TASKS_DESC = `List tasks with optional filters. Defaults to showing open tasks sorted by creation date (newest first). Use status=null to query across all statuses. Tags filter uses ANY-match. Blocked filter isolates tasks with/without a blocked_reason.

WHEN TO PULL TASKS: Before any evaluative response (performance reviews, weekly check-ins, compensation assessments, progress reports), pull task data to ground your assessment in tracked work — not memory alone.

SCOPE AWARENESS: If you called get_latest_handoff with a scope filter (work or personal), apply the same scope here unless the user explicitly asks for cross-scope results. Staying inside the session's scope prevents leaking personal items into a work-scoped response (and vice versa).

This is the authoritative task store — do not maintain parallel task lists in handoff state or external systems.`;

const UPDATE_TASK_DESC = `Update a task's fields and/or apply a lifecycle action. Actions are convenience shortcuts: 'complete' marks done with timestamp, 'cancel' marks cancelled, 'defer' parks the task, 'reopen' returns to open. Field updates can accompany any action. Tags are full-replacement (provide complete array). Set blocked_reason to null to unblock.`;

const SEARCH_TASKS_DESC = `Full-text search across task titles and context. Uses PostgreSQL FTS with English stemming. Filter by status and scope. Results ranked by relevance.

CALL THIS WHEN:
- The user asks about task status, progress, or what's open/blocked
- You are about to create a new task (check for duplicates first)
- The conversation references work items by keyword

DO NOT CALL WHEN:
- task_summary from get_latest_handoff already answered the question
- The user is asking about general concepts, not tracked work items

CONSEQUENCE OF SKIPPING: Duplicate tasks will be created or completed work will be re-opened.

SCOPE AWARENESS: If you called get_latest_handoff with a scope filter (work or personal), apply the same scope here unless the user explicitly asks for cross-scope results. Staying inside the session's scope prevents leaking personal items into a work-scoped response (and vice versa).`;

// ── Tool Registration ────────────────────────────────────────────

export function registerTaskTools(mcpServer: McpServer): void {
  // ── create_task ──────────────────────────────────────────────
  mcpServer.tool(
    "create_task",
    CREATE_TASK_DESC,
    {
      title: z.string().describe("Task title (required)"),
      context: z.string().optional().describe("Additional context or notes"),
      scope: scopeEnum.describe("'work' or 'personal' (required)"),
      priority: priorityEnum.nullable().optional().describe("Priority level, or null for unranked"),
      tags: z.array(z.string()).optional().describe("Free-form tags for categorization"),
      blocked_reason: z.string().nullable().optional().describe("If set, task is blocked with this reason"),
      scheduled_date: z.string().optional().describe("ISO date — 'start thinking about this' date"),
      due_date: z.string().optional().describe("ISO date — hard deadline"),
    },
    async (args) => {
      if (!args.title?.trim()) {
        return errorResponse("title is required", "VALIDATION_ERROR");
      }

      try {
        validateTaskFields(args);
      } catch (err) {
        if (err instanceof PayloadTooLargeError) return payloadTooLargeResponse(err);
        throw err;
      }

      try {
        const result = await query<TaskRow>(
          `INSERT INTO tasks (title, context, scope, priority, tags, blocked_reason, scheduled_date, due_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [
            args.title,
            args.context ?? null,
            args.scope,
            args.priority ?? null,
            args.tags ?? [],
            args.blocked_reason ?? null,
            args.scheduled_date ?? null,
            args.due_date ?? null,
          ]
        );
        const newTask = result.rows[0];
        indexTask(newTask.id, newTask.title, newTask.context, newTask.scope, newTask.tags, newTask.status, newTask.created_at)
          .catch(err => console.warn("[create_task] Background indexing failed:", err.message));
        return jsonResponse(formatTask(newTask));
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );

  // ── get_task ─────────────────────────────────────────────────
  mcpServer.tool(
    "get_task",
    GET_TASK_DESC,
    {
      id: z.string().describe("Task UUID (required)"),
    },
    async (args) => {
      try {
        const result = await query<TaskRow>(
          "SELECT * FROM tasks WHERE id = $1",
          [args.id]
        );
        if (result.rows.length === 0) {
          return errorResponse(`Task not found: ${args.id}`, "NOT_FOUND");
        }
        return jsonResponse(formatTask(result.rows[0]));
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );

  // ── list_tasks ───────────────────────────────────────────────
  mcpServer.tool(
    "list_tasks",
    LIST_TASKS_DESC,
    {
      status: statusEnum.nullable().optional().describe("Filter by status (default: 'open', null = all statuses)"),
      scope: scopeEnum.nullable().optional().describe("Filter by scope"),
      priority: priorityEnum.nullable().optional().describe("Filter by priority"),
      tags: z.array(z.string()).optional().describe("Filter by tags (ANY match)"),
      blocked: z.boolean().nullable().optional().describe("true = blocked only, false = unblocked only"),
      due_before: z.string().optional().describe("ISO date — tasks due before this date"),
      due_after: z.string().optional().describe("ISO date — tasks due after this date"),
      scheduled_before: z.string().optional().describe("ISO date — tasks scheduled before this date"),
      scheduled_after: z.string().optional().describe("ISO date — tasks scheduled after this date"),
      limit: z.number().optional().describe("Max results (default 50, max 200)"),
      offset: z.number().optional().describe("Offset for pagination (default 0)"),
      order_by: orderByEnum.optional().describe("Sort field (default: 'created_at')"),
      order_dir: orderDirEnum.optional().describe("Sort direction (default: 'desc')"),
    },
    async (args) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        // Default to 'open' unless explicitly set to null
        const statusFilter = args.status === undefined ? "open" : args.status;
        if (statusFilter !== null) {
          conditions.push(`status = $${paramIdx++}`);
          params.push(statusFilter);
        }

        if (args.scope) {
          conditions.push(`scope = $${paramIdx++}`);
          params.push(args.scope);
        }

        if (args.priority) {
          conditions.push(`priority = $${paramIdx++}`);
          params.push(args.priority);
        }

        if (args.tags && args.tags.length > 0) {
          conditions.push(`tags && $${paramIdx++}`);
          params.push(args.tags);
        }

        if (args.blocked === true) {
          conditions.push("blocked_reason IS NOT NULL");
        } else if (args.blocked === false) {
          conditions.push("blocked_reason IS NULL");
        }

        if (args.due_before) {
          conditions.push(`due_date < $${paramIdx++}`);
          params.push(args.due_before);
        }

        if (args.due_after) {
          conditions.push(`due_date > $${paramIdx++}`);
          params.push(args.due_after);
        }

        if (args.scheduled_before) {
          conditions.push(`scheduled_date < $${paramIdx++}`);
          params.push(args.scheduled_before);
        }

        if (args.scheduled_after) {
          conditions.push(`scheduled_date > $${paramIdx++}`);
          params.push(args.scheduled_after);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
        const offset = Math.max(args.offset ?? 0, 0);
        const orderBy = args.order_by ?? "created_at";
        const orderDir = args.order_dir ?? "desc";

        // Priority needs special ordering since ENUM sorts alphabetically by default
        let orderClause: string;
        if (orderBy === "priority") {
          const dir = orderDir.toUpperCase();
          orderClause = `ORDER BY CASE priority
            WHEN 'critical' THEN 1
            WHEN 'high' THEN 2
            WHEN 'normal' THEN 3
            WHEN 'low' THEN 4
            ELSE 5 END ${dir}`;
        } else {
          orderClause = `ORDER BY ${orderBy} ${orderDir.toUpperCase()} NULLS LAST`;
        }

        // Count total
        const countResult = await query<{ count: string }>(
          `SELECT COUNT(*) as count FROM tasks ${where}`,
          params
        );
        const totalCount = parseInt(countResult.rows[0].count, 10);

        // Fetch page
        const dataResult = await query<TaskRow>(
          `SELECT * FROM tasks ${where} ${orderClause} LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
          [...params, limit, offset]
        );

        return jsonResponse({
          tasks: dataResult.rows.map(formatTask),
          total_count: totalCount,
          limit,
          offset,
        });
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );

  // ── update_task ──────────────────────────────────────────────
  mcpServer.tool(
    "update_task",
    UPDATE_TASK_DESC,
    {
      id: z.string().describe("Task UUID (required)"),
      action: z.enum(["complete", "cancel", "defer", "reopen"]).nullable().optional()
        .describe("Convenience lifecycle action"),
      title: z.string().optional().describe("New title"),
      context: z.string().optional().describe("New context"),
      scope: scopeEnum.optional().describe("New scope"),
      priority: priorityEnum.nullable().optional().describe("New priority (null = unranked)"),
      tags: z.array(z.string()).optional().describe("New tags (full replacement)"),
      blocked_reason: z.string().nullable().optional().describe("Set blocked reason, or null to unblock"),
      scheduled_date: z.string().nullable().optional().describe("New scheduled date, or null to clear"),
      due_date: z.string().nullable().optional().describe("New due date, or null to clear"),
    },
    async (args) => {
      try {
        validateTaskFields(args);
      } catch (err) {
        if (err instanceof PayloadTooLargeError) return payloadTooLargeResponse(err);
        throw err;
      }

      try {
        // Check task exists
        const existing = await query<TaskRow>(
          "SELECT * FROM tasks WHERE id = $1",
          [args.id]
        );
        if (existing.rows.length === 0) {
          return errorResponse(`Task not found: ${args.id}`, "NOT_FOUND");
        }

        const sets: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        // Apply action shortcuts first
        if (args.action === "complete") {
          sets.push(`status = $${paramIdx++}`);
          params.push("completed");
          sets.push(`completed_at = $${paramIdx++}`);
          params.push(new Date().toISOString());
          sets.push(`blocked_reason = $${paramIdx++}`);
          params.push(null);
        } else if (args.action === "cancel") {
          sets.push(`status = $${paramIdx++}`);
          params.push("cancelled");
          sets.push(`blocked_reason = $${paramIdx++}`);
          params.push(null);
        } else if (args.action === "defer") {
          sets.push(`status = $${paramIdx++}`);
          params.push("deferred");
        } else if (args.action === "reopen") {
          sets.push(`status = $${paramIdx++}`);
          params.push("open");
          sets.push(`completed_at = $${paramIdx++}`);
          params.push(null);
        }

        // Apply field-level updates
        if (args.title !== undefined) {
          sets.push(`title = $${paramIdx++}`);
          params.push(args.title);
        }
        if (args.context !== undefined) {
          sets.push(`context = $${paramIdx++}`);
          params.push(args.context);
        }
        if (args.scope !== undefined) {
          sets.push(`scope = $${paramIdx++}`);
          params.push(args.scope);
        }
        if (args.priority !== undefined) {
          sets.push(`priority = $${paramIdx++}`);
          params.push(args.priority);
        }
        if (args.tags !== undefined) {
          sets.push(`tags = $${paramIdx++}`);
          params.push(args.tags);
        }
        if (args.blocked_reason !== undefined) {
          sets.push(`blocked_reason = $${paramIdx++}`);
          params.push(args.blocked_reason);
        }
        if (args.scheduled_date !== undefined) {
          sets.push(`scheduled_date = $${paramIdx++}`);
          params.push(args.scheduled_date);
        }
        if (args.due_date !== undefined) {
          sets.push(`due_date = $${paramIdx++}`);
          params.push(args.due_date);
        }

        if (sets.length === 0) {
          return errorResponse("No updates provided", "VALIDATION_ERROR");
        }

        const result = await query<TaskRow>(
          `UPDATE tasks SET ${sets.join(", ")} WHERE id = $${paramIdx} RETURNING *`,
          [...params, args.id]
        );
        const row = result.rows[0];
        indexTask(row.id, row.title, row.context, row.scope, row.tags, row.status, row.created_at)
          .catch(err => console.warn("[update_task] Background indexing failed:", err.message));
        return jsonResponse(formatTask(row));
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );

  // ── search_tasks ─────────────────────────────────────────────
  mcpServer.tool(
    "search_tasks",
    SEARCH_TASKS_DESC,
    {
      query: z.string().describe("Full-text search query (required)"),
      status: statusEnum.nullable().optional().describe("Filter by status (default: null = all)"),
      scope: scopeEnum.nullable().optional().describe("Filter by scope"),
      limit: z.number().optional().describe("Max results (default 20, max 100)"),
    },
    async (args) => {
      if (!args.query?.trim()) {
        return errorResponse("query is required", "VALIDATION_ERROR");
      }

      try {
        const conditions: string[] = [
          `to_tsvector('english', coalesce(title, '') || ' ' || coalesce(context, '')) @@ plainto_tsquery('english', $1)`
        ];
        const params: unknown[] = [args.query];
        let paramIdx = 2;

        if (args.status !== undefined && args.status !== null) {
          conditions.push(`status = $${paramIdx++}`);
          params.push(args.status);
        }

        if (args.scope) {
          conditions.push(`scope = $${paramIdx++}`);
          params.push(args.scope);
        }

        const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
        const where = conditions.join(" AND ");

        // Count total matches
        const countResult = await query<{ count: string }>(
          `SELECT COUNT(*) as count FROM tasks WHERE ${where}`,
          params
        );
        const totalCount = parseInt(countResult.rows[0].count, 10);

        // Fetch ranked results
        const dataResult = await query<TaskRow>(
          `SELECT *, ts_rank(
            to_tsvector('english', coalesce(title, '') || ' ' || coalesce(context, '')),
            plainto_tsquery('english', $1)
          ) AS rank
          FROM tasks WHERE ${where}
          ORDER BY rank DESC
          LIMIT $${paramIdx}`,
          [...params, limit]
        );

        return jsonResponse({
          tasks: dataResult.rows.map(formatTask),
          total_count: totalCount,
          next_step: totalCount > 0
            ? "Tasks found. Check their status before creating new tasks on the same topic."
            : "No matching tasks found. Safe to create a new task if needed.",
        });
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );
}
