import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { join } from "node:path";
import { config } from "../config.js";
import { read, writeHandoff, getLatestHandoffFilename, getHandoffCount } from "../storage/json-store.js";
import type { Handoff } from "../storage/schemas.js";
import { mergeHandoff } from "./merge.js";
import { indexHandoff } from "../embeddings/indexer.js";

const SCHEMA_VERSION = "1.1";

const HANDOFFS_DIR = () => join(config.dataDir, "handoffs");

/** Format current time as ISO-8601 with timezone offset. Uses IANA timezone if provided, otherwise server-local. */
function localIsoTimestamp(tz?: string): string {
  const now = new Date();

  if (tz) {
    try {
      // Use Intl to get the time in the specified timezone
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        fractionalSecondDigits: 3,
      }).formatToParts(now);
      const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
      // Calculate offset for the specified timezone
      const tzDate = new Date(now.toLocaleString("en-US", { timeZone: tz }));
      const utcDate = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
      const offsetMin = (tzDate.getTime() - utcDate.getTime()) / 60000;
      const sign = offsetMin >= 0 ? "+" : "-";
      const offH = String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, "0");
      const offM = String(Math.abs(offsetMin) % 60).padStart(2, "0");
      return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}.${get("fractionalSecond")}${sign}${offH}:${offM}`;
    } catch {
      // Invalid timezone — fall through to server-local
    }
  }

  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
  const pad = (n: number) => String(n).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${ms}` +
    `${sign}${hours}:${minutes}`
  );
}

/** Format a stored_at timestamp in the handoff's timezone for convenience display. */
function formatStoredAtLocal(storedAt: string, tz?: string): string | null {
  if (!storedAt || !tz) return null;
  try {
    const date = new Date(storedAt);
    if (isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
      timeZoneName: "short",
    }).format(date);
  } catch {
    return null;
  }
}

/** Compute task_summary from handoff data. */
function computeTaskSummary(handoff: Handoff) {
  return {
    open_count: (handoff.tasks?.open || []).length,
    blocked_count: (handoff.tasks?.blocked || []).length,
    completed_count: (handoff.tasks?.completed || []).length,
  };
}

/** Compute elapsed_seconds since stored_at. Returns null if stored_at is missing/unparseable. */
function computeElapsedSeconds(storedAt?: string): number | null {
  if (!storedAt) return null;
  const parsed = Date.parse(storedAt);
  if (isNaN(parsed)) return null;
  return Math.floor((Date.now() - parsed) / 1000);
}

/** Compute same_calendar_day using the handoff's timezone. */
function computeSameCalendarDay(storedAt?: string, tz?: string): boolean {
  if (!storedAt) return false;
  const timezone = tz || "UTC";
  try {
    const storedDate = new Date(storedAt).toLocaleDateString("en-CA", { timeZone: timezone });
    const nowDate = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
    return storedDate === nowDate;
  } catch {
    return false;
  }
}

/** Filter a handoff payload by scope, tracking which fields were removed. */
function filterByScope(
  handoff: Handoff,
  scope: "full" | "work" | "personal"
): { result: Record<string, unknown>; filteredFields: string[] } {
  if (scope === "full") return { result: handoff, filteredFields: [] };

  const filteredFields: string[] = [];

  if (scope === "work") {
    // Exclude personal health/financial data
    const result: Record<string, unknown> = {
      active_context: handoff.active_context,
      tasks: handoff.tasks
        ? {
            completed: handoff.tasks.completed,
            open: handoff.tasks.open,
            blocked: handoff.tasks.blocked,
          }
        : undefined,
      tone_notes: handoff.tone_notes,
      stored_at: handoff.stored_at,
      timezone: handoff.timezone,
    };

    if (handoff.operational_state) {
      result.operational_state = {
        energy_level: handoff.operational_state.energy_level,
        mood: handoff.operational_state.mood,
      };
      if (handoff.operational_state.sleep_hours) {
        filteredFields.push("operational_state.sleep_hours");
      }
      if (handoff.operational_state.physical_state) {
        filteredFields.push("operational_state.physical_state");
      }
    }

    if (handoff.memory_deltas) {
      filteredFields.push("memory_deltas");
    }

    return { result, filteredFields };
  }

  // scope === "personal" — exclude work-specific items
  const filteredPersonal: string[] = [];
  const result: Record<string, unknown> = {
    operational_state: handoff.operational_state,
    memory_deltas: handoff.memory_deltas,
    tone_notes: handoff.tone_notes,
    stored_at: handoff.stored_at,
    timezone: handoff.timezone,
  };

  if (handoff.active_context) {
    filteredPersonal.push("active_context");
  }
  if (handoff.tasks) {
    filteredPersonal.push("tasks");
  }

  return {
    result,
    filteredFields: filteredPersonal,
  };
}

// ── Tool Descriptions ──────────────────────────────────────────────

const STORE_HANDOFF_DESCRIPTION = `Store the current operational handoff state as a new timestamped file (append-only — previous handoffs are preserved, not overwritten). Use this for full-state captures at session boundaries. For partial updates mid-session, use patch_handoff instead.

IMPORTANT: Always call get_latest_handoff first to load existing state before storing. This prevents data loss from overwriting fields you didn't intend to clear.

Usage cadence:
- At session boundaries (start/end of conversation)
- Mid-session when significant context has accumulated
- Before heavy context operations that may compress earlier messages

Session naming convention: Use YYYY-MM-DD-vNN format for session labels in active_context.session_meta.label (e.g., "2026-04-10-v01").

Parameters:
  - operational_state (optional): {sleep_hours, physical_state, energy_level, mood}
  - active_context (optional): Free-form object for session context, conversation arc, key decisions, and prompts generated. Supports an optional session_meta sub-object: {label, surface, model} to record which instance/surface/model produced this handoff.
  - tasks (optional): {completed: string[], open: string[], blocked: string[]}
    Blocked items should encode dependencies as "task → dependency"
  - memory_deltas (optional): Array of {slot, action, content} for memory edit requests
  - tone_notes (optional): Guidance for the next instance on how to approach the user
  - timezone (optional): IANA timezone identifier (e.g., 'America/New_York')

Returns: {success, stored_at, filename, task_summary, schema_version}`;

const GET_LATEST_HANDOFF_DESCRIPTION = `Retrieve the most recent handoff state. Returns operational context, active work, task lists, and tone notes from the last session.

WHEN TO CALL: At session start (always), before any store_handoff or patch_handoff (to load current state), and before any evaluative or judgment-class response (to ground reasoning in recorded context, not inference alone).

Pre-computed fields: elapsed_seconds, same_calendar_day (if false, operational_state is stale — confirm with user), task_summary, applied_scope/filtered_fields, schema_version, handoff_count, stored_at_local.

Response shape: operational_state, active_context, tasks, task_summary, tone_notes (read before responding), timezone, stored_at, retrieved_at, elapsed_seconds, same_calendar_day, schema_version, handoff_count.

Parameters:
- scope (optional, default "full"): "full" | "work" | "personal"
- timezone (optional): IANA timezone for retrieved_at formatting`;

const PATCH_HANDOFF_DESCRIPTION = `Apply a partial update to the most recent handoff state, creating a new handoff file with merged results. Use this instead of store_handoff when you only need to update specific fields (e.g., move a task from open to completed, update mood, append to conversation arc). Scalars overwrite, objects deep-merge, arrays use explicit operations (append/remove/replace). Each call creates a new timestamped file (append-only).

IMPORTANT: Always call get_latest_handoff first to confirm current state before patching. This prevents merge conflicts and stale data issues.

Session naming convention: Use YYYY-MM-DD-vNN format for session labels in active_context.session_meta.label (e.g., "2026-04-10-v01").

Merge semantics:
- Scalars (tone_notes, timezone): Direct overwrite if provided, preserved if null/absent.
- Objects (operational_state, active_context): Deep merge — patch keys overwrite, others preserved.
- Arrays (tasks.completed, tasks.open, tasks.blocked): Explicit operations only.
  - {op: "append", items: [...]} — add items to end
  - {op: "remove", items: [...]} — remove matching items
  - {op: "replace", items: [...]} — full replacement (escape hatch)
  - null — preserve original array
- memory_deltas: If provided, these are NEW deltas for this patch (not merged with original).
- active_context supports an optional session_meta sub-object: {label, surface, model}.

Parameters:
  - operational_state (optional): Partial object — keys provided overwrite, others preserved
  - active_context (optional): Partial object — keys provided overwrite, others preserved
  - tasks (optional): Object with array operations per sub-key (completed, open, blocked).
    Each accepts {op: "append"|"remove"|"replace", items: string[]} or null to preserve.
  - memory_deltas (optional): Array of {slot, action, content} — new deltas for this patch
  - tone_notes (optional): String to replace, or null to preserve
  - timezone (optional): IANA timezone string to replace, or null to preserve

Returns: {success, patched_fields, stored_at, source_handoff, task_summary, schema_version}`;

// ── Zod Schemas for patch_handoff ──────────────────────────────────

const arrayOpSchema = z
  .object({
    op: z.enum(["append", "remove", "replace"]),
    items: z.array(z.string()),
  })
  .nullable()
  .optional();

// ── Tool Registration ──────────────────────────────────────────────

export function registerHandoffTools(mcpServer: McpServer): void {
  // ── store_handoff ──────────────────────────────────────────────
  mcpServer.tool(
    "store_handoff",
    STORE_HANDOFF_DESCRIPTION,
    {
      operational_state: z
        .object({
          sleep_hours: z.string().optional(),
          physical_state: z.string().optional(),
          energy_level: z.string().optional(),
          mood: z.string().optional(),
        })
        .optional(),
      active_context: z.record(z.string(), z.any()).optional(),
      tasks: z
        .object({
          completed: z.array(z.string()).optional(),
          open: z.array(z.string()).optional(),
          blocked: z.array(z.string()).optional(),
        })
        .optional(),
      memory_deltas: z
        .array(
          z.object({
            slot: z.number(),
            action: z.enum(["add", "replace", "remove"]),
            content: z.string().optional(),
          })
        )
        .optional(),
      tone_notes: z.string().optional(),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone identifier (e.g., 'America/New_York'). Used to format retrieved_at in the user's local timezone."
        ),
    },
    async (args) => {
      const storedAt = new Date().toISOString();
      const handoff: Handoff = { ...args, stored_at: storedAt };
      const filename = await writeHandoff(handoff);

      // Fire-and-forget background indexing — MUST NOT block or fail the handoff
      indexHandoff(filename, handoff).catch(err =>
        console.warn("[store_handoff] Background indexing failed:", err.message)
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              stored_at: storedAt,
              filename,
              task_summary: computeTaskSummary(handoff),
              schema_version: SCHEMA_VERSION,
            }),
          },
        ],
      };
    }
  );

  // ── get_latest_handoff ─────────────────────────────────────────
  mcpServer.tool(
    "get_latest_handoff",
    GET_LATEST_HANDOFF_DESCRIPTION,
    {
      scope: z
        .enum(["full", "work", "personal"])
        .optional()
        .describe(
          "Filter scope: 'full' returns everything (default), 'work' excludes personal health/financial data, 'personal' excludes work-specific items"
        ),
    },
    async (args) => {
      // Read latest handoff from directory listing (avoids pointer file race condition)
      const latestFilename = await getLatestHandoffFilename();
      if (!latestFilename) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: "No handoff stored yet",
                code: "NOT_FOUND",
              }),
            },
          ],
        };
      }
      const handoff = await read<Handoff>(join(HANDOFFS_DIR(), latestFilename));
      if (!handoff) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: "No handoff stored yet",
                code: "NOT_FOUND",
              }),
            },
          ],
        };
      }

      const scope = args.scope ?? "full";
      const { result: filtered, filteredFields } = filterByScope(handoff, scope);
      const handoffCount = await getHandoffCount();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ...filtered,
              retrieved_at: localIsoTimestamp(handoff.timezone),
              elapsed_seconds: computeElapsedSeconds(handoff.stored_at),
              same_calendar_day: computeSameCalendarDay(handoff.stored_at, handoff.timezone),
              task_summary: computeTaskSummary(handoff),
              applied_scope: scope,
              ...(scope !== "full" ? { filtered_fields: filteredFields } : {}),
              stored_at_local: formatStoredAtLocal(handoff.stored_at ?? "", handoff.timezone),
              schema_version: SCHEMA_VERSION,
              handoff_count: handoffCount,
            }),
          },
        ],
      };
    }
  );

  // ── patch_handoff ──────────────────────────────────────────────
  mcpServer.tool(
    "patch_handoff",
    PATCH_HANDOFF_DESCRIPTION,
    {
      operational_state: z
        .record(z.string(), z.string().optional())
        .nullable()
        .optional(),
      active_context: z
        .record(z.string(), z.any())
        .nullable()
        .optional(),
      tasks: z
        .object({
          completed: arrayOpSchema,
          open: arrayOpSchema,
          blocked: arrayOpSchema,
        })
        .nullable()
        .optional(),
      memory_deltas: z
        .array(
          z.object({
            slot: z.number(),
            action: z.enum(["add", "replace", "remove"]),
            content: z.string().optional(),
          })
        )
        .nullable()
        .optional(),
      tone_notes: z.string().nullable().optional(),
      timezone: z.string().nullable().optional(),
    },
    async (args) => {
      // Read latest handoff from directory listing (avoids pointer file race condition)
      const sourceFilename = await getLatestHandoffFilename();
      if (!sourceFilename) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: "No handoff exists to patch. Use store_handoff to create one first.",
                code: "NOT_FOUND",
              }),
            },
          ],
        };
      }
      const handoff = await read<Handoff>(join(HANDOFFS_DIR(), sourceFilename));
      if (!handoff) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: "No handoff exists to patch. Use store_handoff to create one first.",
                code: "NOT_FOUND",
              }),
            },
          ],
        };
      }

      // Merge
      const { merged, patchedFields } = mergeHandoff(handoff, args);

      // Set new stored_at and patched_from reference
      merged.stored_at = new Date().toISOString();
      (merged as Record<string, unknown>).patched_from = sourceFilename;

      // Write as new handoff file (append-only)
      const newFilename = await writeHandoff(merged);

      // Fire-and-forget background indexing
      indexHandoff(newFilename, merged as Record<string, unknown>).catch(err =>
        console.warn("[patch_handoff] Background indexing failed:", err.message)
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              patched_fields: patchedFields,
              stored_at: merged.stored_at,
              source_handoff: sourceFilename,
              task_summary: computeTaskSummary(merged),
              schema_version: SCHEMA_VERSION,
            }),
          },
        ],
      };
    }
  );
}
