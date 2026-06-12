import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { read } from "../storage/json-store.js";
import type { Handoff } from "../storage/schemas.js";
import {
  HANDOFFS_DIR,
  SCHEMA_VERSION,
  computeElapsedSeconds,
  computeSameCalendarDay,
  computeTaskSummary,
  filterByScope,
  formatStoredAtLocal,
  localIsoTimestamp,
} from "./handoff.js";
import { computeDynamicTaskSummary } from "./task-summary.js";
import { computeDynamicArtifactSummary } from "./artifact-summary.js";

const FILENAME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]+\.json$/;

/** Parse a handoff filename prefix (YYYY-MM-DDThh-mm-ss-mssZ) back into an ISO-8601 timestamp. */
function parseFilenameTimestamp(filename: string): string | null {
  const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`;
}

function jsonResponse(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

// ── Tool Descriptions ──────────────────────────────────────────────

const LIST_HANDOFFS_DESCRIPTION = `List historical handoffs as metadata (NOT full content). Use this to discover which handoff to retrieve via get_handoff when the user references a session by date or label. Results sort by stored_at descending (newest first).

This complements get_latest_handoff: use get_latest_handoff for the current session boundary, list_handoffs + get_handoff for digging into past sessions.

Parameters:
- limit (optional, default 10, max 50): Page size
- offset (optional, default 0): Pagination offset
- after (optional): ISO date/timestamp — only include handoffs stored after this
- before (optional): ISO date/timestamp — only include handoffs stored before this

Returns: {handoffs: [{filename, stored_at, session_label, size_bytes, has_tasks, schema_version}], total_count, limit, offset}

The metadata is intentionally lightweight. Call get_handoff with a filename to load full content for a specific entry.`;

const GET_HANDOFF_DESCRIPTION = `Retrieve a specific historical handoff by filename (obtained from list_handoffs). Returns the same enriched response shape as get_latest_handoff, including elapsed_seconds, task_summary, artifact_summary, and scope filtering.

Use this after list_handoffs identifies the target session. For the most recent handoff, use get_latest_handoff directly — it's faster than listing then fetching.

Parameters:
- filename (required): Exact filename from list_handoffs (must not contain '/' or '..')
- scope (optional, default "full"): "full" | "work" | "personal" — same semantics as get_latest_handoff

Returns: The handoff content filtered by scope plus retrieved_at, elapsed_seconds, same_calendar_day, task_summary, artifact_summary, applied_scope, filtered_fields (if scope != full), schema_version.

artifact_summary scopes recently_completed to artifacts whose status transitioned to 'completed' after this handoff's stored_at — useful for spotting in-flight items the handoff narrates that have since finished. Null when Postgres is unavailable.

Errors: Returns {error: true, code: "NOT_FOUND"} if the filename doesn't exist or fails validation, or {error: true, code: "PARSE_ERROR"} if the file exists but is not valid JSON.`;

// ── Tool Registration ──────────────────────────────────────────────

export function registerHandoffNavTools(mcpServer: McpServer): void {
  // ── list_handoffs ──────────────────────────────────────────────
  mcpServer.tool(
    "list_handoffs",
    LIST_HANDOFFS_DESCRIPTION,
    {
      limit: z.number().min(1).max(50).optional().default(10),
      offset: z.number().min(0).optional().default(0),
      after: z.string().optional().describe("ISO date — handoffs stored after this date"),
      before: z.string().optional().describe("ISO date — handoffs stored before this date"),
    },
    async (args) => {
      const limit = args.limit ?? 10;
      const offset = args.offset ?? 0;
      const afterMs = args.after ? Date.parse(args.after) : null;
      const beforeMs = args.before ? Date.parse(args.before) : null;

      const dir = HANDOFFS_DIR();
      let entries: string[];
      try {
        entries = (await readdir(dir)).filter(
          (f) => f.endsWith(".json") && !f.startsWith(".tmp-")
        );
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return jsonResponse({ handoffs: [], total_count: 0, limit, offset });
        }
        throw err;
      }

      // Build { filename, storedAt } pairs and apply date filters
      const dated: Array<{ filename: string; storedAt: string; storedAtMs: number }> = [];
      for (const filename of entries) {
        const storedAt = parseFilenameTimestamp(filename);
        if (!storedAt) continue;
        const storedAtMs = Date.parse(storedAt);
        if (afterMs !== null && !isNaN(afterMs) && storedAtMs <= afterMs) continue;
        if (beforeMs !== null && !isNaN(beforeMs) && storedAtMs >= beforeMs) continue;
        dated.push({ filename, storedAt, storedAtMs });
      }

      // Sort descending (newest first)
      dated.sort((a, b) => b.storedAtMs - a.storedAtMs);

      const totalCount = dated.length;
      const page = dated.slice(offset, offset + limit);

      const handoffs = await Promise.all(
        page.map(async ({ filename, storedAt }) => {
          const filepath = join(dir, filename);
          let sizeBytes = 0;
          try {
            sizeBytes = (await stat(filepath)).size;
          } catch {
            // Missing/unreadable — treat as 0
          }

          let sessionLabel: string | null = null;
          let hasTasks = false;
          let schemaVersion: string | null = null;
          try {
            const handoff = await read<Record<string, unknown>>(filepath);
            if (handoff) {
              const activeContext = handoff.active_context as Record<string, unknown> | undefined;
              const sessionMeta = activeContext?.session_meta as Record<string, unknown> | undefined;
              if (sessionMeta && typeof sessionMeta.label === "string") {
                sessionLabel = sessionMeta.label;
              }
              hasTasks = handoff.tasks !== undefined && handoff.tasks !== null;
              if (typeof handoff.schema_version === "string") {
                schemaVersion = handoff.schema_version;
              }
            }
          } catch {
            // Corrupt or unreadable file — leave fields as defaults
          }

          return {
            filename,
            stored_at: storedAt,
            session_label: sessionLabel,
            size_bytes: sizeBytes,
            has_tasks: hasTasks,
            schema_version: schemaVersion,
          };
        })
      );

      return jsonResponse({
        handoffs,
        total_count: totalCount,
        limit,
        offset,
      });
    }
  );

  // ── get_handoff ────────────────────────────────────────────────
  mcpServer.tool(
    "get_handoff",
    GET_HANDOFF_DESCRIPTION,
    {
      filename: z.string().describe("Exact handoff filename from list_handoffs"),
      scope: z
        .enum(["full", "work", "personal"])
        .optional()
        .default("full")
        .describe("Filter scope: 'full' (default), 'work', or 'personal'"),
    },
    async (args) => {
      // Path traversal prevention: reject any filename with separators or parent refs
      if (
        !args.filename ||
        args.filename.includes("/") ||
        args.filename.includes("\\") ||
        args.filename.includes("..") ||
        !FILENAME_PATTERN.test(args.filename)
      ) {
        return jsonResponse({
          error: true,
          code: "NOT_FOUND",
          message: "Invalid or unknown filename",
        });
      }

      const filepath = join(HANDOFFS_DIR(), args.filename);
      // read() rethrows JSON.parse errors — a corrupt file must surface as a
      // tool error, not an unhandled exception (list_handoffs tolerates the
      // same case by returning null metadata)
      let handoff: Handoff | null;
      try {
        handoff = await read<Handoff>(filepath);
      } catch {
        return jsonResponse({
          error: true,
          code: "PARSE_ERROR",
          message: "Handoff file exists but could not be parsed",
        });
      }
      if (!handoff) {
        return jsonResponse({
          error: true,
          code: "NOT_FOUND",
          message: "Handoff not found",
        });
      }

      const scope = args.scope ?? "full";
      const { result: filtered, filteredFields } = filterByScope(handoff, scope);

      // Prefer dynamic (Postgres) summary; fall back to handoff-based counts.
      // Sequence to share a single Postgres-availability gate — skip artifact summary on failure.
      const dynamic = await computeDynamicTaskSummary();
      const artifactSummary =
        dynamic !== null ? await computeDynamicArtifactSummary(handoff.stored_at) : null;
      const taskSummary = dynamic ?? computeTaskSummary(handoff);

      return jsonResponse({
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
      });
    }
  );
}
