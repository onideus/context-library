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

const LIST_HANDOFFS_DESCRIPTION = `List past handoffs as metadata only, newest first, to find a session by date or label; load one with get_handoff.

Returns: handoffs [{filename, stored_at, session_label, size_bytes, …}], total_count, limit, offset.`;

const GET_HANDOFF_DESCRIPTION = `Load one past handoff by filename (from list_handoffs), with the same scope filter and live summaries as get_latest_handoff.

Returns the handoff fields plus task_summary, artifact_summary (recently_completed: since this handoff), elapsed_seconds, same_calendar_day, applied_scope, filtered_fields, other metadata. Errors: NOT_FOUND, PARSE_ERROR.`;

// ── Tool Registration ──────────────────────────────────────────────

export function registerHandoffNavTools(mcpServer: McpServer): void {
  // ── list_handoffs ──────────────────────────────────────────────
  mcpServer.tool(
    "list_handoffs",
    LIST_HANDOFFS_DESCRIPTION,
    {
      limit: z.number().min(1).max(50).optional().default(10).describe("Page size (default 10)."),
      offset: z.number().min(0).optional().default(0).describe("Entries to skip (default 0)."),
      after: z.string().optional().describe("ISO date or timestamp: only handoffs stored after it."),
      before: z.string().optional().describe("ISO date or timestamp: only handoffs stored before it."),
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
      filename: z.string().describe("Exact filename from list_handoffs."),
      scope: z
        .enum(["full", "work", "personal"])
        .optional()
        .default("full")
        .describe("'full' (default), 'work' or 'personal'; the same filter as get_latest_handoff."),
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
