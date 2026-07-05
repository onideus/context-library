import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { join } from "node:path";
import { config } from "../config.js";
import { read, writeHandoff, writeHandoffInPlace, getLatestHandoffFilename, getHandoffCount } from "../storage/json-store.js";
import type { Handoff } from "../storage/schemas.js";
import { mergeHandoff } from "./merge.js";
import { compactHandoff, COMPACTED_FLAG } from "./compaction.js";
import { indexHandoff, getPendingEmbeddingsCount, hasPendingEmbedding, extractHandoffText } from "../embeddings/indexer.js";
import { isEmbeddingAvailable, getLastEmbeddingSuccess } from "../embeddings/client.js";
import { extractAndStore } from "../entities/pipeline.js";
import { appendChangeBestEffort } from "../db/changes.js";
import { computeDynamicTaskSummary } from "./task-summary.js";
import { computeDynamicArtifactSummary } from "./artifact-summary.js";
import { validatePayloadSize, PayloadTooLargeError, LIMITS } from "./validation.js";

export const SCHEMA_VERSION = "1.3";

/**
 * Log the structured deprecation warning emitted whenever a caller sends
 * legacy handoff task arrays. Centralised so store_handoff and patch_handoff
 * emit identical signal.
 */
function logTaskArrayDeprecation(tool: "store_handoff" | "patch_handoff"): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      tool,
      message: "Deprecated: handoff task arrays stripped server-side",
      field: "tasks",
      recommendation: "Use create_task/update_task for task management",
    })
  );
}

/** True when the incoming handoff payload contains any legacy task array. */
function hasTaskArrays(args: Record<string, unknown>): boolean {
  const t = args.tasks as Record<string, unknown> | undefined;
  if (!t || typeof t !== "object") return false;
  return "completed" in t || "open" in t || "blocked" in t;
}

export const HANDOFFS_DIR = () => join(config.dataDir, "handoffs");

/** Format current time as ISO-8601 with timezone offset. Uses IANA timezone if provided, otherwise server-local. */
export function localIsoTimestamp(tz?: string): string {
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
export function formatStoredAtLocal(storedAt: string, tz?: string): string | null {
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

/**
 * Compute next_step guidance based on handoff state.
 *
 * Accepts an optional taskSummary so the open-task hint can reflect the
 * authoritative Postgres count when available. Handoff task arrays are no
 * longer authoritative (deprecated since schema 1.3) so we only fall back to
 * them when no summary is supplied — historical handoffs are read defensively.
 */
export function computeNextStep(
  handoff: Handoff,
  taskSummary?: { open_count: number } | null
): string {
  const parts: string[] = [];

  parts.push("Before responding on architecture, strategy, or pipeline topics, call search_notes or search_context to check for prior decisions.");

  const openCount =
    taskSummary?.open_count ?? handoff.tasks?.open?.length ?? 0;
  if (openCount > 0) {
    parts.push(`${openCount} open tasks loaded. Check search_tasks before creating new tasks to avoid duplicates.`);
  }

  if (handoff.tone_notes) {
    parts.push("tone_notes loaded -- read and apply before responding.");
  }

  return parts.join(" ");
}

/**
 * Compute task_summary from handoff data. Used only as a fallback when
 * Postgres is unavailable — handoff task arrays are deprecated since schema
 * 1.3 and may be missing entirely from new handoffs (counts will be 0).
 */
export function computeTaskSummary(handoff: Handoff) {
  return {
    open_count: (handoff.tasks?.open || []).length,
    blocked_count: (handoff.tasks?.blocked || []).length,
    completed_count: (handoff.tasks?.completed || []).length,
  };
}

/** Compute elapsed_seconds since stored_at. Returns null if stored_at is missing/unparseable. */
export function computeElapsedSeconds(storedAt?: string): number | null {
  if (!storedAt) return null;
  const parsed = Date.parse(storedAt);
  if (isNaN(parsed)) return null;
  return Math.floor((Date.now() - parsed) / 1000);
}

/** Compute same_calendar_day using the handoff's timezone. */
export function computeSameCalendarDay(storedAt?: string, tz?: string): boolean {
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

/**
 * Minimum elapsed seconds between a session-closing handoff and "now" before
 * we classify the next conversation as a cold start. A session reopened
 * within this window (e.g., the user closed and reopened Claude Code to fix
 * a config) is still effectively warm — operational_state and active_context
 * are very likely to apply directly. The spec calls this "significant
 * elapsed_seconds." 15 minutes is the threshold: long enough that the user
 * has likely walked away, short enough that genuine resumptions still
 * register as resume.
 */
const COLD_START_THRESHOLD_SECONDS = 15 * 60;

/**
 * Derive a coarse session-continuity signal for the next caller.
 *
 *  - "cold_start"   : the previous session was explicitly closed via
 *                     store_handoff/patch_handoff with final=true AND a
 *                     significant amount of time has elapsed since the
 *                     closing handoff (see COLD_START_THRESHOLD_SECONDS).
 *                     The next conversation should treat operational_state
 *                     and active_context as historical context, not live
 *                     state.
 *  - "resume"       : the previous session never set final=true, OR it set
 *                     final=true but was reopened within the cold-start
 *                     threshold. The next conversation may be a
 *                     continuation; load the active context with that
 *                     framing.
 *  - "unknown"      : no stored_at is parseable (e.g., corrupted handoff).
 *
 * Returned as advisory information — callers decide how to weight it.
 * Handoffs that pre-date the flag report "resume" because they have no
 * session_closed marker. That matches the old default behaviour.
 */
export function computeSessionContinuity(handoff: {
  stored_at?: string;
  session_closed?: boolean;
}): "cold_start" | "resume" | "unknown" {
  if (!handoff.stored_at) return "unknown";
  if (handoff.session_closed !== true) return "resume";
  const elapsed = computeElapsedSeconds(handoff.stored_at);
  if (elapsed === null) return "unknown";
  return elapsed >= COLD_START_THRESHOLD_SECONDS ? "cold_start" : "resume";
}

/**
 * Filter a handoff payload by scope, tracking which fields were removed.
 *
 * Note: legacy task arrays (tasks.completed/open/blocked) and memory_deltas
 * are no longer surfaced in any scope since schema 1.3. task_summary,
 * computed from Postgres, is the authoritative task replacement. Historical
 * handoffs on disk may still contain these fields; they are dropped from
 * the response, never written back.
 */
export function filterByScope(
  handoff: Handoff,
  scope: "full" | "work" | "personal"
): { result: Record<string, unknown>; filteredFields: string[] } {
  const handoffRecord = handoff as Record<string, unknown>;

  if (scope === "full") {
    // Strip the deprecated tasks and memory_deltas keys from the response
    // without mutating the input. The on-disk file is untouched.
    const { tasks: _tasks, memory_deltas: _memDeltas, ...rest } =
      handoffRecord as Record<string, unknown> & {
        tasks?: unknown;
        memory_deltas?: unknown;
      };
    void _tasks;
    void _memDeltas;
    return { result: rest, filteredFields: [] };
  }

  const filteredFields: string[] = [];

  // Track deprecated fields excluded from work/personal scopes so callers
  // can see they existed on the underlying handoff even when not returned.
  if (handoff.tasks) filteredFields.push("tasks");
  if (handoffRecord.memory_deltas !== undefined) filteredFields.push("memory_deltas");

  if (scope === "work") {
    // Exclude personal health/financial data
    const result: Record<string, unknown> = {
      active_context: handoff.active_context,
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

    return { result, filteredFields };
  }

  // scope === "personal" — exclude work-specific items
  const result: Record<string, unknown> = {
    operational_state: handoff.operational_state,
    tone_notes: handoff.tone_notes,
    stored_at: handoff.stored_at,
    timezone: handoff.timezone,
  };

  if (handoff.active_context) {
    filteredFields.push("active_context");
  }

  return {
    result,
    filteredFields,
  };
}

/**
 * Compact a previously-stored handoff in place so token cost on the latest
 * handoff stays bounded as history grows. Non-fatal — never blocks the caller.
 * Skips handoffs that are already compacted or still have pending embeddings
 * (content hasn't been indexed yet; archiving would lose it).
 */
async function compactPreviousHandoff(previousFilename: string | null): Promise<void> {
  if (!previousFilename) return;
  try {
    const previous = await read<Handoff>(join(HANDOFFS_DIR(), previousFilename));
    if (!previous) return;

    if ((previous as Record<string, unknown>)[COMPACTED_FLAG] === true) return;

    const pending = await hasPendingEmbedding("handoff", previousFilename);
    if (pending) {
      console.log(
        `[compaction] Skipped ${previousFilename}: embedding still pending`
      );
      return;
    }

    const { compacted, original_size, compacted_size, archived_keys } = compactHandoff(previous);
    if (original_size === compacted_size) return;

    await writeHandoffInPlace(previousFilename, compacted);
    const reduction = Math.round((1 - compacted_size / original_size) * 100);
    console.log(
      `[compaction] ${previousFilename}: ${original_size} → ${compacted_size} bytes ` +
        `(${reduction}% reduction, archived: ${archived_keys.join(", ") || "none"})`
    );
  } catch (err) {
    console.warn(
      "[compaction] Failed to compact previous handoff:",
      (err as Error).message
    );
  }
}

// ── Tool Descriptions ──────────────────────────────────────────────

const STORE_HANDOFF_DESCRIPTION = `Store the current operational handoff state as a new timestamped file (append-only — previous handoffs are preserved, not overwritten). Use this for full-state captures at session boundaries. For partial updates mid-session, use patch_handoff instead.

Context Library has four content primitives: handoffs (ephemeral session state), tasks (actionable items with lifecycle), notes (permanent decisions and patterns), and artifacts (generated outputs with status lifecycle). This tool handles handoffs. Route content to the appropriate primitive — see create_note, create_task, and store_artifact for guidance on what belongs elsewhere.

IMPORTANT: Always call get_latest_handoff first to load existing state before storing. This prevents data loss from overwriting fields you didn't intend to clear.

Usage cadence:
- At session boundaries (start/end of conversation)
- Mid-session when significant context has accumulated
- Before heavy context operations that may compress earlier messages

Session naming convention: Use YYYY-MM-DD-vNN format for session labels in active_context.session_meta.label (e.g., "2026-04-10-v01").

Content routing — what belongs in active_context (handoff):
- Working state: current branch, where you stopped, next steps in this session
- In-progress decisions not yet finalized
- Short-lived context that only matters in the next 1–2 sessions

What belongs elsewhere:
- Durable decisions, architectural patterns, lessons learned → create_note
- Action items with completion lifecycle → create_task
- Generated outputs (CC prompts, research, templates) → store_artifact

If content would be expensive for a future session to re-derive from handoff archaeology, it belongs in a note, not a handoff.

Task management uses create_task and update_task. Handoff task arrays are deprecated and will be stripped server-side if provided (the request still succeeds; a structured warning is logged).

Parameters:
  - operational_state (optional): {sleep_hours, physical_state, energy_level, mood}
  - active_context (optional): Free-form object for session context, conversation arc, key decisions, and prompts generated. Supports an optional session_meta sub-object: {label, surface, model} to record which instance/surface/model produced this handoff.
  - tone_notes (optional): Guidance for the next instance on how to approach the user
  - timezone (optional): IANA timezone identifier (e.g., 'America/New_York')
  - final (optional, default false): Set true on the last write of a session. The stored handoff is marked session_closed=true with a session_closed_at timestamp so the next get_latest_handoff returns session_continuity='cold_start' instead of 'resume'. The flag is also reserved as the trigger for future compaction of the session's handoff chain. If unsure whether this is the final write, omit — false is the safe default.

Returns: {success, stored_at, filename, task_summary, schema_version, session_closed, session_closed_at}

Response Format:
- Reasoning-capable models (extended thinking enabled): Use structured reflection before confirming the store. Evaluate whether the captured state reflects the actual session. Note any gaps in active_context or tasks explicitly.
- Standard inference models: Respond directly. Confirm the store and summarize task_summary. Flag when captured state seems thin.`;

const GET_LATEST_HANDOFF_DESCRIPTION = `Retrieve the most recent handoff state. Returns operational context, active work, task lists, and tone notes from the last session.

WHEN TO CALL: At session start (always), before any store_handoff or patch_handoff (to load current state), and before any evaluative or judgment-class response (to ground reasoning in recorded context, not inference alone).

After loading the handoff, check for durable decisions by calling search_context(content_types: ['note']) or search_notes(query) for topic-specific retrieval. Notes are permanent interpretation — they don't expire between sessions. If making an architectural recommendation, career decision, or strategic judgment, check notes before responding. Handoffs show what was happening; notes show what has been decided and why.

CONSEQUENCE OF SKIPPING: You will operate without session context, miss open tasks, duplicate completed work, or contradict the conversation arc documented in the handoff.

Pre-computed fields: elapsed_seconds, same_calendar_day (if false, operational_state is stale — confirm with user), task_summary, artifact_summary, applied_scope/filtered_fields, schema_version, handoff_count, stored_at_local, embedding_status, evidence_pulled, session_closed, session_closed_at, session_continuity.

Session continuity:
- session_closed (boolean): true when the previous write set final=true. Implies the user explicitly ended that session.
- session_closed_at (ISO timestamp or null): when the session was closed (matches stored_at on the closing handoff).
- session_continuity ('cold_start' | 'resume' | 'unknown'): coarse signal for whether this conversation is picking up a still-open session ('resume') or starting after a closed one ('cold_start'). Use this to frame how literally to apply operational_state and active_context — a closed session's working state is historical, not live. A closed session reopened within ~15 minutes still reports 'resume' so brief reopens (e.g., to fix config) don't lose context.

embedding_status: {available, last_success, pending_count}. available=false means semantic search (search_context) is offline — use search_tasks for keyword-based lookup. pending_count>0 means prior store/patch operations have queued items awaiting TEI recovery; they drain automatically on the next successful search_context or reindex call.

Response shape: operational_state, active_context, task_summary, artifact_summary, tone_notes (read before responding), timezone, stored_at, retrieved_at, elapsed_seconds, same_calendar_day, schema_version, handoff_count, embedding_status, evidence_pulled. Legacy handoff task arrays (tasks.completed/open/blocked) and memory_deltas are NOT returned since schema 1.3 — they are stripped from the response in every scope even when present on the underlying historical file. task_summary is the authoritative replacement for task arrays, computed live from the Postgres tasks table. Call search_tasks or list_tasks for full task detail.

task_summary shape:
When Postgres is available, task_summary is computed live from the authoritative tasks table and returns:
{open_count, blocked_count, completed_count, critical_items: [{id, title, due_date}], due_this_week: [{id, title, due_date}], recently_completed: [{id, title, completed_at}], blocked_items: [{id, title, blocked_reason}]}
When Postgres is unavailable, task_summary falls back to counts derived from the handoff's own tasks arrays: {open_count, blocked_count, completed_count}.

artifact_summary shape:
Computed live from Postgres against the authoritative artifacts table. Use this to ground narration about artifact lifecycle — handoff active_context.prompts_generated text can become stale once an artifact transitions to 'completed'. Shape:
{ready_count, executing_count, draft_count, completed_count, recently_completed: [{id, title, artifact_type, execution_order, completed_at}], currently_executing: [{id, title, artifact_type, execution_order}], ready_queue: [{id, title, artifact_type, execution_order}]}
recently_completed only includes artifacts whose status transitioned to 'completed' after the handoff's stored_at. When Postgres is unavailable, artifact_summary is null (no fallback) — treat the absence as a degradation signal.

SessionEvidence:
evidence_pulled indicates whether operational context was successfully loaded.
When false, judgment-class responses (career advice, strategic decisions,
relationship guidance) should note that they lack session history context.
This is advisory — the model decides how to weight the signal.

Parameters:
- scope (optional, default "full"): "full" | "work" | "personal"
- timezone (optional): IANA timezone for retrieved_at formatting`;

const PATCH_HANDOFF_DESCRIPTION = `Apply a partial update to the most recent handoff state, creating a new handoff file with merged results. Use this instead of store_handoff when you only need to update mood, append to conversation arc, or revise tone_notes. Scalars overwrite, objects deep-merge. Each call creates a new timestamped file (append-only).

Context Library has four content primitives: handoffs (ephemeral session state), tasks (actionable items with lifecycle), notes (permanent decisions and patterns), and artifacts (generated outputs with status lifecycle). This tool handles handoffs. Route content to the appropriate primitive — see create_note, create_task, and store_artifact for guidance on what belongs elsewhere.

IMPORTANT: Always call get_latest_handoff first to confirm current state before patching. This prevents merge conflicts and stale data issues.

Session naming convention: Use YYYY-MM-DD-vNN format for session labels in active_context.session_meta.label (e.g., "2026-04-10-v01").

Merge semantics:
- Scalars (tone_notes, timezone): Direct overwrite if provided, preserved if null/absent.
- Objects (operational_state, active_context): Deep merge — patch keys overwrite, others preserved.
- active_context supports an optional session_meta sub-object: {label, surface, model}.

Task management uses create_task and update_task — the handoff tasks parameter is deprecated. A tasks argument is still accepted for backwards compatibility, but task array operations (append/remove/replace) are no-ops: the patch succeeds, a structured warning is logged, and the returned task_summary reflects the authoritative Postgres state.

Parameters:
  - operational_state (optional): Partial object — keys provided overwrite, others preserved
  - active_context (optional): Partial object — keys provided overwrite, others preserved
  - tone_notes (optional): String to replace, or null to preserve
  - timezone (optional): IANA timezone string to replace, or null to preserve
  - final (optional, default false): Set true on the last write of a session. Marks the patched handoff with session_closed=true plus a session_closed_at timestamp. Setting final=true alone (with no other field) is a valid session-close patch. Future get_latest_handoff calls read this to derive session_continuity (cold start vs. resume). If unsure whether this is the final write, omit — false is the safe default. Note: a patch without final=true clears any session_closed/session_closed_at markers carried over from the source handoff — patching a previously closed session reopens it.

Content routing — what belongs in active_context (handoff):
- Working state: current branch, where you stopped, next steps in this session
- In-progress decisions not yet finalized
- Short-lived context that only matters in the next 1–2 sessions

What belongs elsewhere:
- Durable decisions, architectural patterns, lessons learned → create_note
- Action items with completion lifecycle → create_task
- Generated outputs (CC prompts, research, templates) → store_artifact

If content would be expensive for a future session to re-derive from handoff archaeology, it belongs in a note, not a handoff.

Returns: {success, patched_fields, stored_at, source_handoff, task_summary, schema_version, session_closed, session_closed_at}

Response Format:
- Reasoning-capable models (extended thinking enabled): Use structured reflection before patching. Evaluate whether the patch is consistent with the loaded state. Note any gaps or conflicts explicitly.
- Standard inference models: Respond directly. Confirm the patched_fields and updated task_summary. Flag when the patch seems inconsistent with recent context.`;

// ── Zod Schemas for patch_handoff ──────────────────────────────────

const arrayOpSchema = z
  .object({
    op: z.enum(["append", "remove", "replace"]),
    items: z.array(z.string()),
  })
  .nullable()
  .optional();

/**
 * Fields treated as user-supplied content on store_handoff / patch_handoff
 * for the purposes of the empty-payload guard.
 *
 * `tasks` is intentionally still counted as content even though it is
 * deprecated and stripped server-side before persistence: pre-schema-1.3
 * callers that send tasks-only payloads must still receive a success
 * response (they previously got a metadata-only handoff file). Stripping
 * `tasks` from this list would silently turn those calls into EMPTY_HANDOFF
 * errors, which is a breaking change we don't want bundled into a hardening
 * batch. The stored file remains metadata-only; the deprecation warning
 * still fires; only the empty guard treats the payload as non-empty.
 */
const STORE_CONTENT_FIELDS = [
  "operational_state",
  "active_context",
  "tasks",
  "tone_notes",
  "timezone",
] as const;

/** True when at least one content field is present (non-undefined, non-null). */
function hasAnyContent(args: Record<string, unknown>, fields: readonly string[]): boolean {
  for (const field of fields) {
    const value = args[field];
    if (value !== undefined && value !== null) return true;
  }
  return false;
}

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
      active_context: z.record(z.string(), z.unknown()).optional(),
      /**
       * @deprecated Handoff task arrays are deprecated since schema 1.3 and
       * stripped server-side before storage. Use create_task / update_task
       * instead. Field stays in the schema so existing callers don't fail.
       */
      tasks: z
        .object({
          completed: z.array(z.string()).optional(),
          open: z.array(z.string()).optional(),
          blocked: z.array(z.string()).optional(),
        })
        .optional(),
      tone_notes: z.string().optional(),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone identifier (e.g., 'America/New_York'). Used to format retrieved_at in the user's local timezone."
        ),
      final: z
        .boolean()
        .optional()
        .describe(
          "Set true on the last write of a session. Marks the stored handoff with session_closed=true and a session_closed_at timestamp. Default false (safe default for mid-session writes)."
        ),
    },
    async (args) => {
      const argsBytes = Buffer.byteLength(JSON.stringify(args), "utf-8");
      console.log(`[store_handoff] args size: ${argsBytes} bytes`);

      if (!hasAnyContent(args as Record<string, unknown>, STORE_CONTENT_FIELDS)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                code: "EMPTY_HANDOFF",
                message:
                  "store_handoff requires at least one content field (operational_state, active_context, tone_notes, or timezone).",
              }),
            },
          ],
        };
      }

      try {
        validatePayloadSize(args, LIMITS.STORE_HANDOFF_BYTES, "store_handoff payload");
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: true,
                  code: "PAYLOAD_TOO_LARGE",
                  message: err.message,
                  field: err.field,
                  actual: err.actual,
                  max: err.max,
                }),
              },
            ],
          };
        }
        throw err;
      }

      // Deprecation: log + strip legacy task arrays before storage. The
      // Postgres tasks table is authoritative; handoff arrays are never
      // persisted on the new schema (1.3+).
      if (hasTaskArrays(args as Record<string, unknown>)) {
        logTaskArrayDeprecation("store_handoff");
      }
      // Strip the deprecated tasks array and the transport-only `final` flag
      // before persistence: `final` lives in args to signal session close, but
      // the stored payload carries session_closed/session_closed_at instead.
      const { tasks: _droppedTasks, final: finalFlag, ...sanitizedArgs } =
        args as typeof args & { tasks?: unknown; final?: boolean };
      void _droppedTasks;

      const storedAt = new Date().toISOString();
      const sessionClosed = finalFlag === true;
      const handoff: Handoff = {
        ...sanitizedArgs,
        stored_at: storedAt,
        schema_version: SCHEMA_VERSION,
        ...(sessionClosed
          ? { session_closed: true, session_closed_at: storedAt }
          : {}),
      };

      // Capture previous latest BEFORE writing so we know what to compact.
      const previousFilename = await getLatestHandoffFilename();

      const filename = await writeHandoff(handoff);

      // Append to the sync change log — fire-and-forget so a Postgres outage
      // never blocks the file-mode handoff path (Tier-1 graceful degradation).
      // If the DB is down, the change row is dropped here; server startup runs
      // backfillHandoffChanges() on the next boot to reconcile on-disk files
      // with the changes table so pullers eventually see them.
      appendChangeBestEffort("handoff", filename, "insert").catch((err) =>
        console.warn("[store_handoff] change-log append failed:", (err as Error).message)
      );

      // Fire-and-forget background indexing — MUST NOT block or fail the handoff
      indexHandoff(filename, handoff).catch(err =>
        console.warn("[store_handoff] Background indexing failed:", (err as Error).message)
      );

      // Fire-and-forget entity extraction
      if (config.entityExtractionEnabled && config.entityExtractionAsync) {
        const handoffText = extractHandoffText(handoff as Record<string, unknown>);
        extractAndStore("handoff", filename, handoffText).catch(err =>
          console.warn("[store_handoff] Background entity extraction failed:", (err as Error).message)
        );
      }

      // Fire-and-forget compaction of the prior handoff. Non-fatal.
      if (previousFilename && previousFilename !== filename) {
        compactPreviousHandoff(previousFilename).catch(err =>
          console.warn("[store_handoff] Compaction failed:", (err as Error).message)
        );
      }

      // Prefer the authoritative Postgres-derived task_summary; fall back to
      // the handoff-array counts when Postgres is unavailable. For new
      // handoffs the array fallback will be 0 (task arrays are stripped) —
      // tasks live in Postgres now.
      const dynamicSummary = await computeDynamicTaskSummary();
      const taskSummary = dynamicSummary ?? computeTaskSummary(handoff);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              stored_at: storedAt,
              filename,
              task_summary: taskSummary,
              schema_version: SCHEMA_VERSION,
              session_closed: sessionClosed,
              session_closed_at: sessionClosed ? storedAt : null,
              next_step: computeNextStep(handoff, taskSummary),
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
                evidence_pulled: false,
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
                evidence_pulled: false,
              }),
            },
          ],
        };
      }

      const scope = args.scope ?? "full";
      const { result: filtered, filteredFields } = filterByScope(handoff, scope);
      const handoffCount = await getHandoffCount();
      const embeddingStatus = {
        available: await isEmbeddingAvailable(),
        last_success: getLastEmbeddingSuccess(),
        pending_count: await getPendingEmbeddingsCount(),
      };

      // Prefer enriched task summary from Postgres; fall back to handoff-array counts when unavailable.
      // Sequence the artifact summary after the task summary so a single Postgres-availability check
      // gates both queries — if the first call fails (Postgres down), we skip the second to keep
      // get_latest_handoff fast under graceful degradation.
      const dynamicSummary = await computeDynamicTaskSummary();
      const artifactSummary =
        dynamicSummary !== null ? await computeDynamicArtifactSummary(handoff.stored_at) : null;
      const taskSummary = dynamicSummary ?? computeTaskSummary(handoff);

      // Session continuity signal — read straight from the stored markers so
      // the answer is the same whether scope is full/work/personal. Stale
      // markers are dropped on patch_handoff, so a "cold_start" result here
      // always reflects the most recent write.
      const sessionClosed = handoff.session_closed === true;
      const sessionClosedAt = handoff.session_closed_at ?? null;
      const sessionContinuity = computeSessionContinuity(handoff);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ...filtered,
              retrieved_at: localIsoTimestamp(handoff.timezone),
              elapsed_seconds: computeElapsedSeconds(handoff.stored_at),
              same_calendar_day: computeSameCalendarDay(handoff.stored_at, handoff.timezone),
              task_summary: taskSummary,
              artifact_summary: artifactSummary,
              applied_scope: scope,
              ...(scope !== "full" ? { filtered_fields: filteredFields } : {}),
              stored_at_local: formatStoredAtLocal(handoff.stored_at ?? "", handoff.timezone),
              schema_version: SCHEMA_VERSION,
              handoff_count: handoffCount,
              embedding_status: embeddingStatus,
              evidence_pulled: true,
              session_closed: sessionClosed,
              session_closed_at: sessionClosedAt,
              session_continuity: sessionContinuity,
              next_step: computeNextStep(handoff, taskSummary),
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
        .record(z.string(), z.unknown())
        .nullable()
        .optional(),
      /**
       * @deprecated Handoff task array operations are no-ops since schema
       * 1.3. The Postgres tasks table is authoritative — use create_task /
       * update_task. Accepted for backwards compatibility; a structured
       * warning is logged when present and the operations are skipped.
       */
      tasks: z
        .object({
          completed: arrayOpSchema,
          open: arrayOpSchema,
          blocked: arrayOpSchema,
        })
        .nullable()
        .optional(),
      tone_notes: z.string().nullable().optional(),
      timezone: z.string().nullable().optional(),
      final: z
        .boolean()
        .optional()
        .describe(
          "Set true on the last write of a session. Marks the patched handoff with session_closed=true and a session_closed_at timestamp. Default false (safe default for mid-session patches)."
        ),
      expected_source: z
        .string()
        .optional()
        .describe(
          "Optimistic concurrency precondition. When provided, the patch is applied ONLY if the current latest handoff filename matches this value — if a concurrent writer (chat, pipeline, phone) has since written a new handoff, returns HANDOFF_CONFLICT with the current latest filename instead of merging over stale state. Backward compatible: when omitted, the patch applies to whatever is currently latest (legacy read-merge-write behaviour)."
        ),
    },
    async (args) => {
      const argsBytes = Buffer.byteLength(JSON.stringify(args), "utf-8");
      console.log(`[patch_handoff] args size: ${argsBytes} bytes`);

      // `final: true` on its own is a valid session-close signal even without
      // other content. Treat it as sufficient content so callers don't have
      // to dummy-set tone_notes purely to close a session.
      const finalOnly = args.final === true;
      if (
        !finalOnly &&
        !hasAnyContent(args as Record<string, unknown>, STORE_CONTENT_FIELDS)
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                code: "EMPTY_PATCH",
                message:
                  "patch_handoff requires at least one content field (operational_state, active_context, tone_notes, or timezone) or final=true. Null values are treated as no-op.",
              }),
            },
          ],
        };
      }

      try {
        validatePayloadSize(args, LIMITS.PATCH_HANDOFF_BYTES, "patch_handoff payload");
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: true,
                  code: "PAYLOAD_TOO_LARGE",
                  message: err.message,
                  field: err.field,
                  actual: err.actual,
                  max: err.max,
                }),
              },
            ],
          };
        }
        throw err;
      }

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

      // Item 5 (expected_source precondition): when the caller supplies the
      // filename they intended to patch against, reject if the current latest
      // has moved. This closes the read-merge-write lost-update race the June
      // 10 architecture review ranked #1 among sync hazards. Backward
      // compatible — legacy callers omit expected_source and get today's
      // "patch whatever is latest" behaviour.
      if (args.expected_source !== undefined && args.expected_source !== sourceFilename) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                code: "HANDOFF_CONFLICT",
                message:
                  `expected_source ${args.expected_source} is no longer the latest handoff (current: ${sourceFilename}). Re-read via get_latest_handoff and re-issue the patch.`,
                expected_source: args.expected_source,
                current_source: sourceFilename,
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

      // Deprecation: task array ops become no-ops since schema 1.3. Log a
      // structured warning and drop the field from both the patch and the
      // source handoff so the merged result never carries legacy task arrays
      // forward.
      const patchHasTasks =
        args.tasks !== undefined && args.tasks !== null && Object.keys(args.tasks).length > 0;
      if (patchHasTasks) {
        logTaskArrayDeprecation("patch_handoff");
      }
      // Strip the deprecated tasks array, the transport-only `final` flag,
      // and the sync precondition `expected_source` from the patch payload
      // before merging — none of them belong in the persisted handoff body.
      const {
        tasks: _patchTasks,
        final: finalFlag,
        expected_source: _expectedSource,
        ...patchWithoutTasks
      } = args as typeof args & { tasks?: unknown; final?: boolean; expected_source?: string };
      void _patchTasks;
      void _expectedSource;
      // Also drop any prior session_closed markers from the source so the
      // merged result reflects the current write — closing a session here
      // shouldn't echo a stale close from an earlier handoff.
      const {
        tasks: _origTasks,
        session_closed: _origClosed,
        session_closed_at: _origClosedAt,
        ...handoffWithoutTasks
      } = handoff as Handoff & {
        tasks?: unknown;
        session_closed?: boolean;
        session_closed_at?: string;
      };
      void _origTasks;
      void _origClosed;
      void _origClosedAt;

      // Merge
      const { merged, patchedFields } = mergeHandoff(handoffWithoutTasks, patchWithoutTasks);

      // Set new stored_at, schema_version, and patched_from reference
      const newStoredAt = new Date().toISOString();
      merged.stored_at = newStoredAt;
      (merged as Record<string, unknown>).schema_version = SCHEMA_VERSION;
      (merged as Record<string, unknown>).patched_from = sourceFilename;

      const sessionClosed = finalFlag === true;
      if (sessionClosed) {
        (merged as Record<string, unknown>).session_closed = true;
        (merged as Record<string, unknown>).session_closed_at = newStoredAt;
      }

      // Write as new handoff file (append-only)
      const newFilename = await writeHandoff(merged);

      // Append to the sync change log — fire-and-forget so a Postgres outage
      // doesn't break the file-mode handoff path.
      appendChangeBestEffort("handoff", newFilename, "insert").catch((err) =>
        console.warn("[patch_handoff] change-log append failed:", (err as Error).message)
      );

      // Fire-and-forget background indexing
      indexHandoff(newFilename, merged as Record<string, unknown>).catch(err =>
        console.warn("[patch_handoff] Background indexing failed:", (err as Error).message)
      );

      // Fire-and-forget entity extraction
      if (config.entityExtractionEnabled && config.entityExtractionAsync) {
        const handoffText = extractHandoffText(merged as Record<string, unknown>);
        extractAndStore("handoff", newFilename, handoffText).catch(err =>
          console.warn("[patch_handoff] Background entity extraction failed:", (err as Error).message)
        );
      }

      // task_summary on patch_handoff response reflects authoritative
      // Postgres state, not the legacy handoff arrays (now stripped).
      const dynamicSummary = await computeDynamicTaskSummary();
      const taskSummary = dynamicSummary ?? computeTaskSummary(merged);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              patched_fields: patchedFields,
              stored_at: merged.stored_at,
              source_handoff: sourceFilename,
              task_summary: taskSummary,
              schema_version: SCHEMA_VERSION,
              session_closed: sessionClosed,
              session_closed_at: sessionClosed ? newStoredAt : null,
            }),
          },
        ],
      };
    }
  );
}
