import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool } from "./tool-aliases.js";
import { join } from "node:path";
import { config } from "../config.js";
import { read, writeHandoff, writeHandoffInPlace, archiveHandoff, ARCHIVE_DIRNAME, getLatestHandoffFilename, getHandoffCount } from "../storage/json-store.js";
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
 * legacy handoff task arrays. Centralised so create_handoff and update_handoff
 * emit identical signal.
 */
function logTaskArrayDeprecation(tool: "create_handoff" | "update_handoff"): void {
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
 *                     create_handoff/update_handoff with final=true AND a
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
 * Compact a previously-stored handoff so token cost on the latest handoff
 * stays bounded as history grows. Non-fatal — never blocks the caller.
 *
 * Behaviour is governed by COMPACTION_MODE (config.compactionMode):
 *
 *   off       Returns immediately. Nothing is ever rewritten. This is the
 *             archival-deployment setting — every handoff keeps its full
 *             active_context permanently.
 *   archive   (default) Copies the byte-exact original to handoffs/archive/
 *             and only then rewrites in place. Lossless on disk.
 *   in-place  Legacy. Rewrites with no copy. LOSSY: active_context collapses
 *             to a one-line summary and the original text survives only as
 *             chunks in the embeddings index.
 *
 * Skips handoffs that are already compacted (nothing left to save — archiving
 * a gutted file as though it were the original would be a lie) or that still
 * have pending embeddings (content hasn't been indexed yet).
 *
 * Exported for tests; create_handoff is the only production caller.
 */
export async function compactPreviousHandoff(previousFilename: string | null): Promise<void> {
  if (!previousFilename) return;

  const mode = config.compactionMode;
  if (mode === "off") return;

  try {
    const previous = await read<Handoff>(join(HANDOFFS_DIR(), previousFilename));
    if (!previous) return;

    if ((previous as Record<string, unknown>)[COMPACTED_FLAG] === true) return;

    const pending = await hasPendingEmbedding("handoff", previousFilename);
    if (pending) {
      console.log(
        `[compaction] mode=${mode} Skipped ${previousFilename}: embedding still pending`
      );
      return;
    }

    const { compacted, original_size, compacted_size, archived_keys } = compactHandoff(previous);
    if (original_size === compacted_size) return;

    // Archive BEFORE the rewrite, and let a failure here throw: the whole
    // point of archive mode is that the original outlives the rewrite, so a
    // failed copy must abort the rewrite rather than fall through to it.
    let archiveNote = "";
    if (mode === "archive") {
      const outcome = await archiveHandoff(previousFilename);
      archiveNote =
        outcome === "archived"
          ? `, original saved to ${ARCHIVE_DIRNAME}/`
          : `, ${ARCHIVE_DIRNAME}/ copy already present (kept)`;
    }

    await writeHandoffInPlace(previousFilename, compacted);
    const reduction = Math.round((1 - compacted_size / original_size) * 100);
    console.log(
      `[compaction] mode=${mode} ${previousFilename}: ${original_size} → ${compacted_size} bytes ` +
        `(${reduction}% reduction, archived: ${archived_keys.join(", ") || "none"}${archiveNote})`
    );
  } catch (err) {
    console.warn(
      `[compaction] mode=${mode} Failed to compact previous handoff:`,
      (err as Error).message
    );
  }
}

// ── Tool Descriptions ──────────────────────────────────────────────

const STORE_HANDOFF_DESCRIPTION = `Save the full session state as a new handoff; earlier handoffs are kept. This is a full replacement of the session state, not a patch: anything left out is absent from the new handoff. Partial change: update_handoff.

Call get_latest_handoff first and carry forward what is still true. Keep active_context to working state (decisions go in notes, action items in tasks).

final=true closes the session: after 15 minutes, get_latest_handoff reports session_continuity 'cold_start'.

Returns: success, filename, stored_at, task_summary, schema_version, session_closed, session_closed_at, next_step.`;

const GET_LATEST_HANDOFF_DESCRIPTION = `Load the latest handoff: the previous session's operational_state, active_context and tone_notes, plus live task and artifact summaries.

CALL THIS WHEN: a session starts (always first); before create_handoff or update_handoff; before judgments that rely on recent context.
DO NOT CALL WHEN: you need an older session (list_handoffs, then get_handoff).
CONSEQUENCE OF SKIPPING: you miss open tasks, repeat finished work, or contradict the recorded state.

- session_continuity: 'resume' = state is live; 'cold_start' = closed with final=true 15+ minutes ago, treat as history; 'unknown' = no valid timestamp.
- same_calendar_day=false: operational_state is from an earlier day; confirm it first.
- task_summary and artifact_summary are live and authoritative over task or artifact text in the handoff.
- Read and apply tone_notes before responding.
- embedding_status.available=false: semantic search is offline; use search_tasks.
- scope 'work' or 'personal' removes fields, listed in filtered_fields.

Returns the handoff fields plus filename (update_handoff's expected_source), the fields above, elapsed_seconds, session_closed, handoff_count, next_step and other metadata. NOT_FOUND if none exists.`;

const PATCH_HANDOFF_DESCRIPTION = `Change part of the latest handoff, saved as a new handoff (the source is kept). Read first with get_latest_handoff.

The merge is one level deep. tone_notes, timezone: replaced when given. operational_state, active_context: each top-level key sent replaces that key's whole value (nested objects such as session_meta are not merged); other keys are kept; an active_context key sent as null is stored as null. A field sent as null or omitted is unchanged.

final=true closes the session (it may be the only field); a call without it reopens a closed session. tasks is deprecated and a no-op: use create_task / update_task.

Returns: success, filename (the new handoff), patched_fields, stored_at, source_handoff, task_summary, session_closed, session_closed_at, schema_version. HANDOFF_CONFLICT (nothing saved): expected_source is stale; re-read and re-apply.`;

// ── Zod Schemas for update_handoff ──────────────────────────────────

const arrayOpSchema = z
  .object({
    op: z.enum(["append", "remove", "replace"]),
    items: z.array(z.string()),
  })
  .nullable()
  .optional();

/**
 * Fields treated as user-supplied content on create_handoff / update_handoff
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
  // ── create_handoff ─────────────────────────────────────────────
  registerTool(
    mcpServer,
    "create_handoff",
    STORE_HANDOFF_DESCRIPTION,
    {
      operational_state: z
        .object({
          sleep_hours: z.string().optional(),
          physical_state: z.string().optional(),
          energy_level: z.string().optional(),
          mood: z.string().optional(),
        })
        .optional()
        .describe("The user's current state as free text: sleep_hours, physical_state, energy_level, mood."),
      active_context: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Free-form working state: where work stopped, next steps, open decisions. Optional session_meta: {label (YYYY-MM-DD-vNN), surface, model}."
        ),
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
        .optional()
        .describe("Deprecated and ignored: handoff task arrays are stripped. Use create_task / update_task."),
      tone_notes: z.string().optional().describe("Guidance for the next session on how to approach the user."),
      timezone: z
        .string()
        .optional()
        .describe("IANA timezone, e.g. 'America/New_York'; used to show times in the user's local time."),
      final: z
        .boolean()
        .optional()
        .describe("true on the last write of a session: marks the session closed. Default false."),
    },
    async (args) => {
      const argsBytes = Buffer.byteLength(JSON.stringify(args), "utf-8");
      console.log(`[create_handoff] args size: ${argsBytes} bytes`);

      if (!hasAnyContent(args as Record<string, unknown>, STORE_CONTENT_FIELDS)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                code: "EMPTY_HANDOFF",
                message:
                  "create_handoff requires at least one content field (operational_state, active_context, tone_notes, or timezone).",
              }),
            },
          ],
        };
      }

      try {
        validatePayloadSize(args, LIMITS.STORE_HANDOFF_BYTES, "create_handoff payload");
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
        logTaskArrayDeprecation("create_handoff");
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
        console.warn("[create_handoff] change-log append failed:", (err as Error).message)
      );

      // Fire-and-forget background indexing — MUST NOT block or fail the handoff
      indexHandoff(filename, handoff).catch(err =>
        console.warn("[create_handoff] Background indexing failed:", (err as Error).message)
      );

      // Fire-and-forget entity extraction
      if (config.entityExtractionEnabled && config.entityExtractionAsync) {
        const handoffText = extractHandoffText(handoff as Record<string, unknown>);
        extractAndStore("handoff", filename, handoffText).catch(err =>
          console.warn("[create_handoff] Background entity extraction failed:", (err as Error).message)
        );
      }

      // Fire-and-forget compaction of the prior handoff. Non-fatal.
      if (previousFilename && previousFilename !== filename) {
        compactPreviousHandoff(previousFilename).catch(err =>
          console.warn("[create_handoff] Compaction failed:", (err as Error).message)
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
          "'full' (default); 'work' drops sleep_hours, physical_state and other personal fields; 'personal' drops active_context."
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
      // markers are dropped on update_handoff, so a "cold_start" result here
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
              filename: latestFilename,
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

  // ── update_handoff ─────────────────────────────────────────────
  registerTool(
    mcpServer,
    "update_handoff",
    PATCH_HANDOFF_DESCRIPTION,
    {
      operational_state: z
        .record(z.string(), z.string().optional())
        .nullable()
        .optional()
        .describe("Keys to set (sleep_hours, physical_state, energy_level, mood); each replaces that key. null = unchanged."),
      active_context: z
        .record(z.string(), z.unknown())
        .nullable()
        .optional()
        .describe("Top-level keys to set; each replaces that key's whole value, other keys are kept. null = unchanged."),
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
        .optional()
        .describe("Deprecated no-op, accepted and ignored. Use create_task / update_task."),
      tone_notes: z.string().nullable().optional().describe("New tone_notes, replacing the old text. null = unchanged."),
      timezone: z.string().nullable().optional().describe("New IANA timezone, e.g. 'Europe/Berlin'. null = unchanged."),
      final: z
        .boolean()
        .optional()
        .describe("true on the last write of a session: marks it closed. Default false; a call without it reopens a closed session."),
      expected_source: z
        .string()
        .optional()
        .describe(
          "filename from get_latest_handoff (or your last create_handoff / update_handoff). If a newer handoff exists: HANDOFF_CONFLICT, nothing saved."
        ),
    },
    async (args) => {
      const argsBytes = Buffer.byteLength(JSON.stringify(args), "utf-8");
      console.log(`[update_handoff] args size: ${argsBytes} bytes`);

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
                  "update_handoff requires at least one content field (operational_state, active_context, tone_notes, or timezone) or final=true. Null values are treated as no-op.",
              }),
            },
          ],
        };
      }

      try {
        validatePayloadSize(args, LIMITS.PATCH_HANDOFF_BYTES, "update_handoff payload");
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
                message: "No handoff exists to patch. Use create_handoff to create one first.",
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
                message: "No handoff exists to patch. Use create_handoff to create one first.",
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
        logTaskArrayDeprecation("update_handoff");
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
        console.warn("[update_handoff] change-log append failed:", (err as Error).message)
      );

      // Fire-and-forget background indexing
      indexHandoff(newFilename, merged as Record<string, unknown>).catch(err =>
        console.warn("[update_handoff] Background indexing failed:", (err as Error).message)
      );

      // Fire-and-forget entity extraction
      if (config.entityExtractionEnabled && config.entityExtractionAsync) {
        const handoffText = extractHandoffText(merged as Record<string, unknown>);
        extractAndStore("handoff", newFilename, handoffText).catch(err =>
          console.warn("[update_handoff] Background entity extraction failed:", (err as Error).message)
        );
      }

      // task_summary on update_handoff response reflects authoritative
      // Postgres state, not the legacy handoff arrays (now stripped).
      const dynamicSummary = await computeDynamicTaskSummary();
      const taskSummary = dynamicSummary ?? computeTaskSummary(merged);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              filename: newFilename,
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
