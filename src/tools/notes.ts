import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { query } from "../db/client.js";
import { withTransaction, appendChange } from "../db/changes.js";
import { indexNote } from "../embeddings/indexer.js";
import { config } from "../config.js";
import { extractAndStore } from "../entities/pipeline.js";

// ── Types ────────────────────────────────────────────────────────

interface NoteRow {
  id: string;
  title: string;
  content: string;
  domain: string | null;
  tags: string[];
  scope: string;
  source_url: string | null;
  related_task_ids: string[];
  created_at: string;
  updated_at: string;
}

function formatNote(row: NoteRow) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    domain: row.domain,
    tags: row.tags || [],
    scope: row.scope,
    source_url: row.source_url,
    related_task_ids: row.related_task_ids || [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function formatNoteListItem(row: NoteRow) {
  return {
    id: row.id,
    title: row.title,
    domain: row.domain,
    scope: row.scope,
    tags: row.tags || [],
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

// ── Zod Schemas ──────────────────────────────────────────────────

const scopeEnum = z.enum(["work", "personal", "shared"]);
const listOrderByEnum = z.enum(["created_at", "updated_at"]);
const orderDirEnum = z.enum(["asc", "desc"]);

// ── Tool Descriptions ────────────────────────────────────────────

const CREATE_NOTE_DESC = `Create a permanent knowledge entry. Use for decisions made, approaches tried, constraints discovered, patterns identified, article takeaways, and connections between ideas — anything that should survive across sessions and never be compacted away.

Context Library has four content primitives — tasks, handoffs, artifacts, and notes. Notes are distinct from the others:
- Tasks are action items with a lifecycle (open → completed). "Research X" is a task.
- Handoffs are ephemeral session state that gets compacted over time.
- Artifacts are generated outputs with a status lifecycle (draft → ready → completed). A produced CC prompt is an artifact.
- Notes are permanent interpretation — the reasoning, the decision, the insight. "After researching X, we decided Y because Z" is knowledge.

Use the 'domain' field to categorize (e.g., 'architecture', 'security', 'career', 'health'). Tags are free-form and compose with domain. The 'scope' field separates work/personal/shared knowledge. Provide 'source_url' when capturing takeaways from external material. Set 'related_task_ids' to link a note back to the tasks that produced it.

Scope routing: scope is required. If the user's request is clearly personal (health, family, finance), pass scope='personal'. If clearly work-related, pass scope='work'. If the note is reusable across contexts (architecture decisions, OSS project notes, language patterns), pass scope='shared'. When ambiguous, ask before storing.

Content can be long — notes do not compact.`;

const GET_NOTE_DESC = `Retrieve a single note by its UUID. Returns the full note object including content.`;

const LIST_NOTES_DESC = `List knowledge entries with optional filters and pagination. Returns metadata only (id, title, domain, scope, tags, timestamps) — NOT the full content. Call get_note for the body.

Defaults to newest-first by created_at. Filter by scope, domain, or tags (ANY-match). Use search_notes or search_context when you want relevance ranking instead of filtered browsing.

Scope filter: when scope is omitted, this tool returns notes across all scopes (work, personal, shared). Pass scope='work', 'personal', or 'shared' to restrict results.`;

const SEARCH_NOTES_DESC = `Full-text search across note titles and content. Uses PostgreSQL FTS with English stemming, ranked by relevance. Returns matching notes WITH full content (unlike list_notes).

Use search_notes when looking for a specific decision or pattern: "What did we decide about X?", "Is there a note about Y?" It queries only the notes table, making it faster for targeted knowledge lookup. Prefer search_context when you need cross-primitive results (handoffs + notes + artifacts in one query). Prefer search_notes when you specifically want decisions and patterns.

CALL THIS WHEN:
- You need to verify a prior decision before making a recommendation
- The topic touches a domain where decisions have been documented (architecture, security, career, health)
- You are about to create or update an artifact and need to check for related decisions
- The user asks "what did we decide about X" or "is there a rule for Y"

DO NOT CALL WHEN:
- search_context already returned relevant notes in this turn
- The question is about ephemeral session state (use get_latest_handoff)

CONSEQUENCE OF SKIPPING: You will re-derive decisions that were already made, potentially reaching different conclusions.

Scope filter: when scope is omitted, this tool searches notes across all scopes. Pass scope='work', 'personal', or 'shared' to restrict results to a single context.

Filter by scope and domain. For cross-type semantic search that finds relevant notes alongside handoffs and tasks, use search_context with content_types: ["note"] instead — this tool only searches within the notes table.`;

const UPDATE_NOTE_DESC = `Update fields on an existing note. All fields are optional — only provided fields are modified. Tags and related_task_ids are full-replacement (provide complete arrays). Re-embeds on content change.`;

const DELETE_NOTE_DESC = `Permanently delete a note by UUID. Also removes its entry from the embeddings index. Knowledge entries are intended to be permanent — use this only for corrections or cleanup. Deletion cannot be undone.`;

// ── Tool Registration ────────────────────────────────────────────

export function registerNoteTools(mcpServer: McpServer): void {
  // ── create_note ──────────────────────────────────────────────
  mcpServer.tool(
    "create_note",
    CREATE_NOTE_DESC,
    {
      title: z.string().describe("Short descriptive title for the knowledge entry"),
      content: z.string().describe("The knowledge content — decisions, insights, patterns, takeaways. Can be long."),
      scope: scopeEnum.describe(
        "'work', 'personal', or 'shared' (required). Pass 'shared' when the knowledge is reusable across contexts (architecture decisions, OSS project notes)."
      ),
      domain: z.string().optional().describe("Knowledge domain for categorization (e.g., 'architecture', 'security', 'career', 'health')"),
      tags: z.array(z.string()).optional().describe("Free-form tags for categorization"),
      source_url: z.string().optional().describe("URL of the source material, if applicable"),
      related_task_ids: z.array(z.string()).optional().describe("UUIDs of related tasks, if applicable"),
    },
    async (args) => {
      if (!args.title?.trim()) {
        return errorResponse("title is required", "VALIDATION_ERROR");
      }
      if (!args.content?.trim()) {
        return errorResponse("content is required", "VALIDATION_ERROR");
      }

      try {
        const row = await withTransaction(async (client) => {
          const result = await client.query<NoteRow>(
            `INSERT INTO notes (title, content, domain, tags, scope, source_url, related_task_ids)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [
              args.title,
              args.content,
              args.domain ?? null,
              args.tags ?? [],
              args.scope,
              args.source_url ?? null,
              args.related_task_ids ?? [],
            ]
          );
          const inserted = result.rows[0];
          await appendChange(client, "note", inserted.id, "insert");
          return inserted;
        });
        indexNote(row.id, {
          title: row.title,
          content: row.content,
          domain: row.domain,
          tags: row.tags,
          scope: row.scope,
          created_at: row.created_at,
        }).catch((err) =>
          console.warn("[create_note] Background indexing failed:", (err as Error).message)
        );
        if (config.entityExtractionEnabled && config.entityExtractionAsync) {
          const noteText = [row.title, row.content].filter(Boolean).join("\n");
          extractAndStore("note", row.id, noteText).catch((err) =>
            console.warn("[create_note] Background entity extraction failed:", (err as Error).message)
          );
        }
        return jsonResponse({
          id: row.id,
          title: row.title,
          created_at: row.created_at,
        });
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );

  // ── get_note ─────────────────────────────────────────────────
  mcpServer.tool(
    "get_note",
    GET_NOTE_DESC,
    {
      id: z.string().describe("UUID of the note to retrieve"),
    },
    async (args) => {
      try {
        const result = await query<NoteRow>(
          "SELECT * FROM notes WHERE id = $1",
          [args.id]
        );
        if (result.rows.length === 0) {
          return errorResponse(`Note not found: ${args.id}`, "NOT_FOUND");
        }
        return jsonResponse(formatNote(result.rows[0]));
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );

  // ── list_notes ───────────────────────────────────────────────
  mcpServer.tool(
    "list_notes",
    LIST_NOTES_DESC,
    {
      limit: z.number().min(1).max(100).optional().describe("Max results (1-100, default 20)"),
      offset: z.number().min(0).optional().describe("Offset for pagination (default 0)"),
      scope: scopeEnum.nullable().optional().describe("Filter by scope (null/omitted = all scopes)"),
      domain: z.string().optional().describe("Filter by domain"),
      tags: z.array(z.string()).optional().describe("Filter by tags (ANY match)"),
      order_by: listOrderByEnum.optional().describe("Sort field (default: 'created_at')"),
      order_dir: orderDirEnum.optional().describe("Sort direction (default: 'desc')"),
    },
    async (args) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (args.scope) {
          conditions.push(`scope = $${paramIdx++}`);
          params.push(args.scope);
        }

        if (args.domain) {
          conditions.push(`domain = $${paramIdx++}`);
          params.push(args.domain);
        }

        if (args.tags && args.tags.length > 0) {
          conditions.push(`tags && $${paramIdx++}`);
          params.push(args.tags);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
        const offset = Math.max(args.offset ?? 0, 0);
        const orderBy = args.order_by ?? "created_at";
        const orderDir = (args.order_dir ?? "desc").toUpperCase();
        const orderClause = `ORDER BY ${orderBy} ${orderDir} NULLS LAST`;

        const countResult = await query<{ count: string }>(
          `SELECT COUNT(*) as count FROM notes ${where}`,
          params
        );
        const totalCount = parseInt(countResult.rows[0].count, 10);

        const dataResult = await query<NoteRow>(
          `SELECT * FROM notes ${where} ${orderClause} LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
          [...params, limit, offset]
        );

        return jsonResponse({
          notes: dataResult.rows.map(formatNoteListItem),
          total_count: totalCount,
          limit,
          offset,
        });
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );

  // ── search_notes ─────────────────────────────────────────────
  mcpServer.tool(
    "search_notes",
    SEARCH_NOTES_DESC,
    {
      query: z.string().describe("Full-text search query"),
      scope: scopeEnum.nullable().optional().describe("Filter by scope"),
      domain: z.string().optional().describe("Filter by domain"),
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

        if (args.scope) {
          conditions.push(`scope = $${paramIdx++}`);
          params.push(args.scope);
        }

        if (args.domain) {
          conditions.push(`domain = $${paramIdx++}`);
          params.push(args.domain);
        }

        const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
        const where = conditions.join(" AND ");

        const countResult = await query<{ count: string }>(
          `SELECT COUNT(*) as count FROM notes WHERE ${where}`,
          params
        );
        const totalCount = parseInt(countResult.rows[0].count, 10);

        const dataResult = await query<NoteRow & { rank: number }>(
          `SELECT *, ts_rank(
            to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, '')),
            plainto_tsquery('english', $1)
          ) AS rank
          FROM notes WHERE ${where}
          ORDER BY rank DESC
          LIMIT $${paramIdx}`,
          [...params, limit]
        );

        return jsonResponse({
          notes: dataResult.rows.map((row) => ({
            ...formatNote(row),
            rank: row.rank,
          })),
          total_count: totalCount,
          next_step: totalCount > 0
            ? "Notes contain documented decisions. Reference them by title in your response. Do not re-derive conclusions that contradict these notes."
            : "No matching notes found. If making a new decision on this topic, consider creating a note to document it.",
        });
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );

  // ── update_note ──────────────────────────────────────────────
  mcpServer.tool(
    "update_note",
    UPDATE_NOTE_DESC,
    {
      id: z.string().describe("UUID of the note to update"),
      title: z.string().optional().describe("New title"),
      content: z.string().optional().describe("New content"),
      domain: z.string().nullable().optional().describe("New domain, or null to clear"),
      tags: z.array(z.string()).optional().describe("New tags (full replacement)"),
      scope: scopeEnum.optional().describe("New scope"),
      source_url: z.string().nullable().optional().describe("New source URL, or null to clear"),
      related_task_ids: z.array(z.string()).optional().describe("New related task IDs (full replacement)"),
    },
    async (args) => {
      try {
        const existing = await query<NoteRow>(
          "SELECT * FROM notes WHERE id = $1",
          [args.id]
        );
        if (existing.rows.length === 0) {
          return errorResponse(`Note not found: ${args.id}`, "NOT_FOUND");
        }

        const sets: string[] = [];
        const params: unknown[] = [];
        let paramIdx = 1;

        if (args.title !== undefined) {
          sets.push(`title = $${paramIdx++}`);
          params.push(args.title);
        }
        if (args.content !== undefined) {
          sets.push(`content = $${paramIdx++}`);
          params.push(args.content);
        }
        if (args.domain !== undefined) {
          sets.push(`domain = $${paramIdx++}`);
          params.push(args.domain);
        }
        if (args.tags !== undefined) {
          sets.push(`tags = $${paramIdx++}`);
          params.push(args.tags);
        }
        if (args.scope !== undefined) {
          sets.push(`scope = $${paramIdx++}`);
          params.push(args.scope);
        }
        if (args.source_url !== undefined) {
          sets.push(`source_url = $${paramIdx++}`);
          params.push(args.source_url);
        }
        if (args.related_task_ids !== undefined) {
          sets.push(`related_task_ids = $${paramIdx++}`);
          params.push(args.related_task_ids);
        }

        if (sets.length === 0) {
          return errorResponse("No updates provided", "VALIDATION_ERROR");
        }

        const row = await withTransaction(async (client) => {
          const upd = await client.query<NoteRow>(
            `UPDATE notes SET ${sets.join(", ")} WHERE id = $${paramIdx} RETURNING *`,
            [...params, args.id]
          );
          if (upd.rows.length === 0) {
            // Concurrent DELETE landed between the SELECT above and this
            // UPDATE. Skip the change-log write — mirrors update_task /
            // update_artifact so we don't append a phantom `note:update`
            // tombstone-adjacent row for a note that no longer exists.
            return null;
          }
          await appendChange(client, "note", args.id, "update");
          return upd.rows[0];
        });

        if (row === null) {
          return errorResponse(`Note not found: ${args.id}`, "NOT_FOUND");
        }

        const contentChanged =
          args.title !== undefined ||
          args.content !== undefined ||
          args.domain !== undefined ||
          args.tags !== undefined;
        if (contentChanged) {
          indexNote(row.id, {
            title: row.title,
            content: row.content,
            domain: row.domain,
            tags: row.tags,
            scope: row.scope,
            created_at: row.created_at,
          }).catch((err) =>
            console.warn("[update_note] Background indexing failed:", (err as Error).message)
          );
          if (config.entityExtractionEnabled && config.entityExtractionAsync) {
            const noteText = [row.title, row.content].filter(Boolean).join("\n");
            extractAndStore("note", row.id, noteText).catch((err) =>
              console.warn("[update_note] Background entity extraction failed:", (err as Error).message)
            );
          }
        }

        return jsonResponse(formatNote(row));
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );

  // ── delete_note ──────────────────────────────────────────────
  mcpServer.tool(
    "delete_note",
    DELETE_NOTE_DESC,
    {
      id: z.string().describe("UUID of the note to delete"),
    },
    async (args) => {
      try {
        const deleted = await withTransaction(async (client) => {
          const result = await client.query<{ id: string }>(
            "DELETE FROM notes WHERE id = $1 RETURNING id",
            [args.id]
          );
          if (result.rows.length === 0) return null;
          await appendChange(client, "note", args.id, "delete");
          return result.rows[0];
        });
        if (deleted === null) {
          return errorResponse(`Note not found: ${args.id}`, "NOT_FOUND");
        }

        // Remove from embeddings index — fire-and-forget, but awaited briefly
        // so typical callers see a clean state. Errors are logged, not thrown.
        try {
          await query(
            "DELETE FROM embeddings WHERE content_type = 'note' AND content_id = $1",
            [args.id]
          );
        } catch (err) {
          console.warn(
            "[delete_note] Failed to remove embedding:",
            (err as Error).message
          );
        }

        return jsonResponse({ deleted: true, id: args.id });
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );
}
