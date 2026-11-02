import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { query } from "../db/client.js";
import { withTransaction, appendChange } from "../db/changes.js";
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
// 'shared' matches the notes scope enum — see migration 010_task_scope_shared.sql.
const scopeEnum = z.enum(["work", "personal", "shared"]);
const priorityEnum = z.enum(["critical", "high", "normal", "low"]);
const orderByEnum = z.enum(["created_at", "updated_at", "due_date", "scheduled_date", "priority"]);
const orderDirEnum = z.enum(["asc", "desc"]);

// ── Tool Descriptions ────────────────────────────────────────────

const CREATE_TASK_DESC = `Create a task: an action item with a lifecycle (open, completed, deferred, cancelled). The tasks table is the authoritative task store: do not keep parallel task lists in handoffs or elsewhere. Check search_tasks first for a duplicate. New tasks are 'open'.

Returns the task with every field (id, status, completed_at, timestamps, …).`;

const GET_TASK_DESC = `Get one task by id, with every field.

Returns the task. NOT_FOUND if missing.`;

const LIST_TASKS_DESC = `List tasks by filter. Defaults: status 'open', all scopes, newest first; status null lists every status. Use it to ground progress reports in tracked work.

Returns: tasks[] (full tasks), total_count, limit, offset.`;

const UPDATE_TASK_DESC = `Change a task. Sent fields replace the stored values, omitted ones are kept; tags replaces the whole list. null clears only priority, blocked_reason, scheduled_date or due_date.

action: 'complete' (sets completed_at, clears blocked_reason), 'cancel' (clears blocked_reason), 'defer', 'reopen' (open again, clears completed_at).

expected_status is checked only when the action changes status: on mismatch nothing is written and STATUS_CONFLICT returns current.

Returns the updated task. Errors: NOT_FOUND, VALIDATION_ERROR (nothing to update), STATUS_CONFLICT.`;

const SEARCH_TASKS_DESC = `Keyword search (full-text, English stemming) over task titles and context, ranked. Works when semantic search is offline.

CALL THIS WHEN: the user asks what is open, blocked or done on a topic; before create_task, to avoid a duplicate.
DO NOT CALL WHEN: task_summary from get_latest_handoff already answers it, or the question is not about tracked work.
CONSEQUENCE OF SKIPPING: duplicate tasks get created, or finished work is reopened.

Returns: tasks[] (full tasks), total_count, next_step.`;

// ── Tool Registration ────────────────────────────────────────────

export function registerTaskTools(mcpServer: McpServer): void {
  // ── create_task ──────────────────────────────────────────────
  mcpServer.tool(
    "create_task",
    CREATE_TASK_DESC,
    {
      title: z.string().describe("Task title."),
      context: z.string().optional().describe("Details, background or notes."),
      scope: scopeEnum.describe(
        "'work', 'personal', or 'shared' (reusable across both). Ask when unclear."
      ),
      priority: priorityEnum.nullable().optional().describe("Priority; omit or null for unranked."),
      tags: z.array(z.string()).optional().describe("Free-form tags."),
      blocked_reason: z.string().nullable().optional().describe("Why the task cannot proceed; setting it marks the task blocked."),
      scheduled_date: z.string().optional().describe("ISO date to start on it."),
      due_date: z.string().optional().describe("ISO date: hard deadline."),
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
        const newTask = await withTransaction(async (client) => {
          const result = await client.query<TaskRow>(
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
          const row = result.rows[0];
          await appendChange(client, "task", row.id, "insert");
          return row;
        });
        indexTask(newTask.id, newTask.title, newTask.context, newTask.scope, newTask.tags, newTask.status, newTask.created_at)
          .catch(err => console.warn("[create_task] Background indexing failed:", (err as Error).message));
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
      id: z.string().describe("Task id (UUID)."),
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
      status: statusEnum.nullable().optional().describe("Status filter; default 'open', null = all statuses."),
      scope: scopeEnum.nullable().optional().describe("Scope filter; omit or null = all scopes."),
      priority: priorityEnum.nullable().optional().describe("Priority filter."),
      tags: z.array(z.string()).optional().describe("Match tasks with ANY of these tags."),
      blocked: z.boolean().nullable().optional().describe("true = blocked only, false = unblocked only."),
      due_before: z.string().optional().describe("ISO date: due before it."),
      due_after: z.string().optional().describe("ISO date: due after it."),
      scheduled_before: z.string().optional().describe("ISO date: scheduled before it."),
      scheduled_after: z.string().optional().describe("ISO date: scheduled after it."),
      limit: z.number().optional().describe("Max results, 1-200 (default 50)."),
      offset: z.number().optional().describe("Rows to skip (default 0)."),
      order_by: orderByEnum.optional().describe("Sort field (default 'created_at')."),
      order_dir: orderDirEnum.optional().describe("Sort direction (default 'desc'); with order_by 'priority', 'asc' puts critical first."),
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
      id: z.string().describe("Task id (UUID)."),
      action: z.enum(["complete", "cancel", "defer", "reopen"]).nullable().optional()
        .describe("Lifecycle action; omit or null for none."),
      title: z.string().optional().describe("New title."),
      context: z.string().optional().describe("New context."),
      scope: scopeEnum.optional().describe("New scope."),
      priority: priorityEnum.nullable().optional().describe("New priority; null = unranked."),
      tags: z.array(z.string()).optional().describe("New tags; replaces the whole list."),
      blocked_reason: z.string().nullable().optional().describe("Reason the task is blocked; null unblocks."),
      scheduled_date: z.string().nullable().optional().describe("New ISO scheduled date; null clears."),
      due_date: z.string().nullable().optional().describe("New ISO due date; null clears."),
      expected_status: statusEnum.optional().describe(
        "Status you believe the task has. Checked only when the action changes status; on mismatch STATUS_CONFLICT, nothing written."
      ),
    },
    async (args) => {
      try {
        validateTaskFields(args);
      } catch (err) {
        if (err instanceof PayloadTooLargeError) return payloadTooLargeResponse(err);
        throw err;
      }

      try {
        // Read-then-conditional-write: check existence, capture current status,
        // and use it as the UPDATE precondition so concurrent status transitions
        // return STATUS_CONFLICT instead of blindly overwriting.
        const existing = await query<TaskRow>(
          "SELECT * FROM tasks WHERE id = $1",
          [args.id]
        );
        if (existing.rows.length === 0) {
          return errorResponse(`Task not found: ${args.id}`, "NOT_FOUND");
        }
        const currentRow = existing.rows[0];
        const expectedStatus = args.expected_status ?? currentRow.status;

        const sets: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;
        let statusWillChange = false;

        // Apply action shortcuts first
        if (args.action === "complete") {
          sets.push(`status = $${paramIdx++}`);
          params.push("completed");
          sets.push(`completed_at = $${paramIdx++}`);
          params.push(new Date().toISOString());
          sets.push(`blocked_reason = $${paramIdx++}`);
          params.push(null);
          statusWillChange = true;
        } else if (args.action === "cancel") {
          sets.push(`status = $${paramIdx++}`);
          params.push("cancelled");
          sets.push(`blocked_reason = $${paramIdx++}`);
          params.push(null);
          statusWillChange = true;
        } else if (args.action === "defer") {
          sets.push(`status = $${paramIdx++}`);
          params.push("deferred");
          statusWillChange = true;
        } else if (args.action === "reopen") {
          sets.push(`status = $${paramIdx++}`);
          params.push("open");
          sets.push(`completed_at = $${paramIdx++}`);
          params.push(null);
          statusWillChange = true;
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

        // Conditional-UPDATE guard: when the update mutates status, gate the
        // write on the row still being in the expected status. This is the
        // "item 3" fix from the June 10 architecture review — a second writer
        // that already advanced the status loses this write, and we return a
        // typed STATUS_CONFLICT with the current server state so the caller
        // (client sync push, or a chat racing the pipeline) can reconcile.
        const idParam = `$${paramIdx++}`;
        const conditional = statusWillChange
          ? ` AND status = $${paramIdx++}`
          : "";
        const conditionalParams = statusWillChange ? [expectedStatus] : [];

        const row = await withTransaction(async (client) => {
          const upd = await client.query<TaskRow>(
            `UPDATE tasks SET ${sets.join(", ")} WHERE id = ${idParam}${conditional} RETURNING *`,
            [...params, args.id, ...conditionalParams]
          );
          if (upd.rows.length === 0) {
            return null;
          }
          await appendChange(client, "task", args.id, "update");
          return upd.rows[0];
        });

        if (row === null) {
          // Re-read current state so the caller sees whatever status won.
          const current = await query<TaskRow>(
            "SELECT * FROM tasks WHERE id = $1",
            [args.id]
          );
          if (current.rows.length === 0) {
            return errorResponse(`Task not found: ${args.id}`, "NOT_FOUND");
          }
          return jsonResponse({
            error: true,
            code: "STATUS_CONFLICT",
            message: `Task status is no longer ${expectedStatus}; current status is ${current.rows[0].status}`,
            current: formatTask(current.rows[0]),
          });
        }

        indexTask(row.id, row.title, row.context, row.scope, row.tags, row.status, row.created_at)
          .catch(err => console.warn("[update_task] Background indexing failed:", (err as Error).message));
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
      query: z.string().describe("Search words; every word must match (stemmed)."),
      status: statusEnum.nullable().optional().describe("Status filter; omit or null = all."),
      scope: scopeEnum.nullable().optional().describe("Scope filter; omit or null = all."),
      limit: z.number().optional().describe("Max results, 1-100 (default 20)."),
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
