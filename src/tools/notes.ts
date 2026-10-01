import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { query } from "../db/client.js";
import { withTransaction, appendChange } from "../db/changes.js";
import { indexNote } from "../embeddings/indexer.js";
import { config } from "../config.js";
import { extractAndStore } from "../entities/pipeline.js";
import { countOccurrences, literalReplace, appendWithNewline } from "./note-edits.js";

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

const UPDATE_NOTE_DESC = `Update fields on an existing note. All fields are optional — only provided fields are modified. Tags and related_task_ids are full-replacement (provide complete arrays). Re-embeds on content change. For small edits to an existing note's content, prefer str_replace_note (exact-text replace) or append_note (add to the end) — they avoid resending the full content.`;

const STR_REPLACE_NOTE_DESC = `Replace an exact span of text inside an existing note's content without resending the whole note. Prefer this over update_note for small edits to long notes (changing a status line, fixing a sentence, updating a value) — update_note requires the complete new content, costs tokens for the entire note, and risks silently dropping lines you didn't mean to touch.

Workflow: call get_note first so old_str is copied exactly from the current content.

Parameters:
- id (required): UUID of the note to edit.
- old_str (required, non-empty): the exact text to find. Literal match — case-sensitive, whitespace-sensitive, NOT a regex (characters like . * $ ( ) are matched as-is).
- new_str (required, may be empty): the replacement text, inserted verbatim (no $& / $1 substitution). An empty string deletes old_str.
- replace_all (optional, default false): when true, replace every occurrence; when false, old_str must occur exactly once.

Errors (returned as {error: true, message, code, ...}):
- VALIDATION_ERROR — old_str is empty.
- NOT_FOUND — no note with that id.
- NO_MATCH — old_str does not occur in the content (match_count: 0). Re-read the note with get_note and copy the text exactly.
- AMBIGUOUS_MATCH — old_str occurs more than once and replace_all is false (match_count gives the number of occurrences). Widen old_str with surrounding text until it is unique, or pass replace_all: true if every occurrence should change.

Returns a compact confirmation WITHOUT the note content: {id, title, updated_at, replacements, content_length}. replacements is the number of occurrences replaced; content_length is the new content length (JavaScript string length, i.e. UTF-16 code units). Title, tags, and other fields are unchanged — use update_note for those. Re-embeds the note for search.`;

const APPEND_NOTE_DESC = `Append text to the end of an existing note's content without resending the whole note. Prefer this over update_note for logs, running journals, and dated entries (e.g. "2026-01-15: Acme Corp rollout finished") — it costs tokens only for the new text and cannot accidentally drop existing lines.

Parameters:
- id (required): UUID of the note to append to.
- content (required, non-empty): the text to append. It always starts on a new line: if the existing content is non-empty and does not already end with a newline, exactly one newline is inserted first. If the existing content is empty, the result is just the new text.

Errors (returned as {error: true, message, code}):
- VALIDATION_ERROR — content is empty.
- NOT_FOUND — no note with that id.

Returns a compact confirmation WITHOUT the note content: {id, title, updated_at, content_length}. content_length is the new total content length (JavaScript string length, i.e. UTF-16 code units). Concurrent appends to the same note are serialized, so none are lost. Re-embeds the note for search.`;

const DELETE_NOTE_DESC = `Permanently delete a note by UUID. Also removes its entry from the embeddings index. Knowledge entries are intended to be permanent — use this only for corrections or cleanup. Deletion cannot be undone.`;

// ── Partial content edits ────────────────────────────────────────

type ContentEdit =
  | { ok: true; content: string; replacements?: number }
  | { ok: false; message: string; code: string; match_count: number };

/**
 * Shared body for str_replace_note / append_note: lock the row FOR UPDATE,
 * compute the new content, write it and the change-log row in one
 * transaction, then fire-and-forget re-index + entity extraction exactly as
 * update_note does. The response is compact — no `content` echo.
 */
async function editNoteContent(
  id: string,
  toolName: string,
  edit: (content: string) => ContentEdit
) {
  const outcome = await withTransaction(async (client) => {
    const locked = await client.query<NoteRow>(
      "SELECT * FROM notes WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (locked.rows.length === 0) return null;

    const result = edit(locked.rows[0].content);
    if (!result.ok) return { kind: "rejected" as const, result };

    const upd = await client.query<NoteRow>(
      "UPDATE notes SET content = $1 WHERE id = $2 RETURNING *",
      [result.content, id]
    );
    if (upd.rows.length === 0) {
      // Same guard shape as update_note: never append a change row for a
      // note that no longer exists.
      return null;
    }
    await appendChange(client, "note", id, "update");
    return { kind: "updated" as const, row: upd.rows[0], replacements: result.replacements };
  });

  if (outcome === null) {
    return errorResponse(`Note not found: ${id}`, "NOT_FOUND");
  }
  if (outcome.kind === "rejected") {
    const { message, code, match_count } = outcome.result;
    return jsonResponse({ error: true, message, code, match_count });
  }

  const { row, replacements } = outcome;
  indexNote(row.id, {
    title: row.title,
    content: row.content,
    domain: row.domain,
    tags: row.tags,
    scope: row.scope,
    created_at: row.created_at,
  }).catch((err) =>
    console.warn(`[${toolName}] Background indexing failed:`, (err as Error).message)
  );
  if (config.entityExtractionEnabled && config.entityExtractionAsync) {
    const noteText = [row.title, row.content].filter(Boolean).join("\n");
    extractAndStore("note", row.id, noteText).catch((err) =>
      console.warn(`[${toolName}] Background entity extraction failed:`, (err as Error).message)
    );
  }

  return jsonResponse({
    id: row.id,
    title: row.title,
    updated_at: row.updated_at,
    ...(replacements !== undefined ? { replacements } : {}),
    content_length: row.content.length,
  });
}

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

  // ── str_replace_note ─────────────────────────────────────────
  mcpServer.tool(
    "str_replace_note",
    STR_REPLACE_NOTE_DESC,
    {
      id: z.string().describe("UUID of the note to edit"),
      old_str: z
        .string()
        .describe("Exact text to find (literal, case- and whitespace-sensitive, not a regex)"),
      new_str: z
        .string()
        .describe("Replacement text, inserted verbatim. Empty string deletes old_str"),
      replace_all: z
        .boolean()
        .optional()
        .describe("Replace every occurrence instead of requiring exactly one (default false)"),
    },
    async (args) => {
      if (!args.old_str) {
        return errorResponse("old_str must be a non-empty string", "VALIDATION_ERROR");
      }
      try {
        return await editNoteContent(args.id, "str_replace_note", (content) => {
          const matchCount = countOccurrences(content, args.old_str);
          if (matchCount === 0) {
            return {
              ok: false,
              message: "old_str was not found in the note content. Call get_note and copy the text exactly.",
              code: "NO_MATCH",
              match_count: 0,
            };
          }
          if (matchCount > 1 && !args.replace_all) {
            return {
              ok: false,
              message: `old_str matches ${matchCount} times. Widen old_str with surrounding text to make it unique, or pass replace_all: true.`,
              code: "AMBIGUOUS_MATCH",
              match_count: matchCount,
            };
          }
          const replaceAll = args.replace_all === true;
          return {
            ok: true,
            content: literalReplace(content, args.old_str, args.new_str, replaceAll),
            replacements: replaceAll ? matchCount : 1,
          };
        });
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );

  // ── append_note ──────────────────────────────────────────────
  mcpServer.tool(
    "append_note",
    APPEND_NOTE_DESC,
    {
      id: z.string().describe("UUID of the note to append to"),
      content: z
        .string()
        .describe("Text to append; starts on a new line after the existing content"),
    },
    async (args) => {
      if (!args.content) {
        return errorResponse("content must be a non-empty string", "VALIDATION_ERROR");
      }
      try {
        return await editNoteContent(args.id, "append_note", (content) => ({
          ok: true,
          content: appendWithNewline(content, args.content),
        }));
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
