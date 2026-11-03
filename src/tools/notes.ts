import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, strReplaceNoteAdapter } from "./tool-aliases.js";
import { pool, query } from "../db/client.js";
import { withTransaction } from "../db/changes.js";
import { indexNote } from "../embeddings/indexer.js";
import { config } from "../config.js";
import { extractAndStore } from "../entities/pipeline.js";
import { appendWithNewline, applyEdits, type ContentEdit } from "./note-edits.js";
import {
  EFFECTIVE_NOTE_STATUSES,
  PROVENANCE_VALUES,
  conflictCode,
  conflictMessage,
  deleteNoteInTx,
  effectiveStatus,
  effectiveStatusSql,
  insertNoteInTx,
  parseIsoWithOffset,
  pruneNoteHistoryInTx,
  resolveChainHeads,
  searchCandidatePredicateSql,
  supersedeNoteInTx,
  updateNoteInTx,
  type EffectiveNoteStatus,
  type NoteLifecycleRow,
  type NoteRow,
  type NotePatch,
  type NoteVersionRow,
  type NoteWriteConflict,
} from "../notes/store.js";
import {
  applyLifecycleRedirect,
  keepShownNotices,
  lifecycleFromNoteRow,
  lifecycleNextStep,
} from "../notes/lifecycle-search.js";
import type { SearchResultRow } from "./search.js";

// ── Types ────────────────────────────────────────────────────────

/**
 * Full note shape for get/create/update/search responses. `status` is the
 * COMPUTED lifecycle status (active | superseded | expired): expiry is never
 * stored, it is derived from valid_until (design section 3.3).
 */
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
    status: effectiveStatus(row),
    superseded_by: row.superseded_by,
    superseded_at: row.superseded_at,
    valid_until: row.valid_until,
    provenance: row.provenance,
    version: row.version,
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
    status: effectiveStatus(row),
    valid_until: row.valid_until,
    superseded_by: row.superseded_by,
    provenance: row.provenance,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * History snapshots are built by Postgres (to_jsonb), so their timestamps are
 * strings like "2026-03-01T09:30:00.123456+00:00". Normalise to the same
 * millisecond-precision "Z" form node-postgres Dates serialise to, so a
 * history entry and the current row render timestamps identically.
 */
function snapshotTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}

/** The embedding indexer takes ISO strings; node-postgres returns Dates. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function indexPayload(row: NoteRow) {
  return {
    title: row.title,
    content: row.content,
    domain: row.domain,
    tags: row.tags,
    scope: row.scope,
    created_at: toIso(row.created_at),
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

const VALID_UNTIL_ERROR =
  "valid_until must be an ISO-8601 date-time with an explicit offset, e.g. 2026-12-31T00:00:00Z";

/**
 * Map a write conflict from the shared note store to a tool response.
 * not_found is a plain NOT_FOUND error; every other kind carries the note as
 * it is now under `current` (same shape as update_artifact's STATUS_CONFLICT)
 * so the caller can re-read, reconcile, and retry.
 */
function conflictResponse(
  conflict: NoteWriteConflict,
  id: string,
  opts: { successorId?: string } = {}
) {
  if (conflict.kind === "not_found") {
    const message =
      conflict.missing === "superseded_by" && opts.successorId
        ? `Successor note not found: ${opts.successorId}`
        : conflictMessage(conflict, id);
    return errorResponse(message, "NOT_FOUND");
  }
  const body: Record<string, unknown> = {
    error: true,
    code: conflictCode(conflict),
    message: conflictMessage(conflict, id),
    current: formatNote(conflict.current),
  };
  if (conflict.kind === "invalid_successor" && conflict.successor) {
    body.successor = formatNote(conflict.successor);
  }
  return jsonResponse(body);
}

// ── Zod Schemas ──────────────────────────────────────────────────

const scopeEnum = z.enum(["work", "personal", "shared"]);
const listOrderByEnum = z.enum(["created_at", "updated_at"]);
const orderDirEnum = z.enum(["asc", "desc"]);
const provenanceEnum = z.enum(PROVENANCE_VALUES);
const statusFilterEnum = z.enum(EFFECTIVE_NOTE_STATUSES);

// ── Tool Descriptions ────────────────────────────────────────────

const CREATE_NOTE_DESC = `Save permanent knowledge: a decision and why, a constraint, a pattern, a lesson, a source's takeaways. If it replaces an older note, create it, then call supersede_note on the old one.

provenance is optional but set it on every note (omitting it returns a hint): 'stated' = the user said it; 'decided' = agreed in conversation; 'inferred' = your unconfirmed conclusion; 'fetched' = external material (set source_url); 'derived' = computed from other records. Use 'inferred' whenever the user did not confirm.

valid_until needs an explicit offset (Z or ±hh:mm), else VALIDATION_ERROR; after it the note reads 'expired'.

Returns: id, title, created_at, version, status, provenance, valid_until, hint (when provenance was omitted).`;

const GET_NOTE_DESC = `Get one note by id, with content. status is 'active', 'superseded' or 'expired' (computed from valid_until). successor is {id, title} when superseded; supersedes lists the ids this note replaced. Pass version as expected_version when writing.

Returns every note field (content, status, version, provenance, valid_until, …) plus successor and supersedes. NOT_FOUND if missing.`;

const LIST_NOTES_DESC = `List notes by filter, metadata only (get_note returns the content). Defaults: every scope and status, newest first.

Returns: notes [{id, title, domain, scope, tags, status, valid_until, superseded_by, provenance, version, created_at, updated_at}], total_count, limit, offset.`;

const SEARCH_NOTES_DESC = `Keyword search (full-text, English stemming) over note titles and content, ranked; returns full notes. search_context covers all content types.

CALL THIS WHEN: a prior decision may constrain a recommendation; the user asks what was decided; before creating a note on a topic.
DO NOT CALL WHEN: search_context already returned the relevant notes this turn, or the question is about session state.
CONSEQUENCE OF SKIPPING: you re-derive settled decisions and may contradict them.

Lifecycle: a matching superseded note is replaced by the head of its supersession chain, matched ids in matched_via. Expired notes are omitted; if the chain ends in an expired note, nothing is shown and a notice says so. The scope and domain filters apply to the successor too: if it falls outside them, the superseded note comes back as itself, flagged. Read lifecycle_notices when non-empty; cite successors, never superseded notes.

Returns: notes[] (with successor_title, matched_via, rank), total_count (before redirection), redirected (superseded matches replaced by a returned successor), lifecycle_notices[], next_step.`;

const UPDATE_NOTE_DESC = `Change fields of a note. Sent fields replace the stored values, omitted ones are kept; tags and related_task_ids replace the whole list. null clears only domain, source_url, provenance or valid_until (clearing valid_until revives an expired note). Small content changes: edit_note or append_note.

Use it to correct a note that is still true; for a replaced decision, use supersede_note. Editing a superseded or expired note is allowed and versioned.

Errors: VERSION_CONFLICT (stale expected_version; nothing written, current holds the note), VALIDATION_ERROR (valid_until without offset, or no field).

Returns the note plus changed (false for a no-op; version unchanged).`;

const EDIT_NOTE_DESC = `Replace exact text inside a note's content without resending it. Call get_note first, copy each old_str exactly, and pass its version as expected_version.

Edits apply in order, each to the previous result; all apply or none do. old_str must occur exactly once unless replace_all is true. The result may be empty. Editing a superseded or expired note is allowed and versioned.

Errors (nothing written): NOT_FOUND; VERSION_CONFLICT (stale expected_version, checked first; current holds the note); NO_MATCH / AMBIGUOUS_MATCH with edit_index, match_count.

Returns, without content: id, title, version, changed, updated_at, replacements (per edit), content_length.`;

const APPEND_NOTE_DESC = `Add text to the end of a note, on a new line, without resending it; suited to logs and dated entries. Appending to a superseded or expired note is allowed and versioned.

Errors: VALIDATION_ERROR (empty content), NOT_FOUND, VERSION_CONFLICT (nothing written; current holds the note).

Returns, without content: id, title, version, changed, updated_at, content_length.`;

const DELETE_NOTE_DESC = `Permanently delete a note and its version history. This is the only way to remove a note and cannot be undone: use it only for a note that should never have existed; when knowledge changed, use supersede_note. Notes it had superseded are re-pointed to its successor, or reactivated if it had none.

Returns: deleted, id, relinked [{id, status, superseded_by}]. NOT_FOUND if missing.`;

const SUPERSEDE_NOTE_DESC = `Retire a note that a newer note replaces (a decision reversed, a fact changed). The old note keeps its content and history and gets status 'superseded'. To fix a note that is still true, edit it instead.

Create the successor first: it must exist, be active (not superseded or expired) and differ from the old note, else INVALID_SUCCESSOR. An already-superseded note returns STATUS_CONFLICT; a stale expected_version, VERSION_CONFLICT.

Search then redirects matches of the old note to the successor and reports it in lifecycle_notices. No undo: only delete_note on the successor reverses it, deleting it and reactivating every note it superseded.

Returns: superseded {id, title, version, superseded_by, superseded_at}, successor {id, title}. NOT_FOUND names the missing id.`;

const GET_NOTE_HISTORY_DESC = `Read a note's version history: what it said before each edit, what changed and which tool changed it. Newest first; entry 0 is the current version.

CALL THIS WHEN: a note reads differently than expected; after VERSION_CONFLICT; the user asks what a note used to say or when it changed.
DO NOT CALL WHEN: finding notes (search_notes) or reading only the current text (get_note).
CONSEQUENCE OF SKIPPING: you may overwrite another writer's change unseen, or misreport what a note said.

Each entry is a full snapshot plus changed_fields, changed_via and changed_at for the edit that replaced it (empty on the current entry). changed_via names the writing tool ('sql' = outside the tools); 'edit_note' and 'str_replace_note' are the same kind of edit.

Returns: id, current_version, total_entries, entries, limit, offset. NOT_FOUND if missing.`;

const PRUNE_NOTE_HISTORY_DESC = `Delete old versions from one note's history, keeping the newest keep_last; the note and its version number do not change. Irreversible. History is otherwise kept and exported, so this is the only way to remove text edited out of a note (e.g. a pasted secret).

Returns: id, current_version, deleted, remaining. NOT_FOUND if missing.`;

// ── Partial content edits ────────────────────────────────────────

type ContentEditOutcome =
  | { kind: "conflict"; conflict: NoteWriteConflict }
  | { kind: "rejected"; result: Extract<ContentEdit, { ok: false }> }
  | { kind: "updated"; row: NoteRow; changed: boolean; replacements?: number | number[] };

/**
 * Shared body for edit_note / append_note (and the deprecated str_replace_note
 * alias, which writes as edit_note): lock the row FOR UPDATE, compute the new
 * content from it, and write it through updateNoteInTx in the same
 * transaction — so these tools get update_note's version history
 * (changed_via = the tool name), true-no-op semantics, change-log row, and
 * history retention. Post-commit re-index + entity extraction mirror
 * update_note. The response is compact — no `content` echo.
 */
async function editNoteContent(
  id: string,
  via: "edit_note" | "append_note",
  expectedVersion: number | undefined,
  edit: (content: string) => ContentEdit
) {
  const outcome = await withTransaction(async (client): Promise<ContentEditOutcome> => {
    const locked = await client.query<NoteRow>(
      "SELECT * FROM notes WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (locked.rows.length === 0) {
      return { kind: "conflict", conflict: { kind: "not_found", missing: "id" } };
    }
    const current = locked.rows[0];
    // A stale expected_version means old_str was copied from content that has
    // since changed, so it outranks NO_MATCH / AMBIGUOUS_MATCH.
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      return { kind: "conflict", conflict: { kind: "version_conflict", current } };
    }

    const result = edit(current.content);
    if (!result.ok) return { kind: "rejected", result };

    // Pin the write to the version the edit was computed from. The row lock
    // already guarantees it; updateNoteInTx re-locking the row is a no-op.
    const write = await updateNoteInTx(
      client,
      id,
      { content: result.content },
      { expectedVersion: current.version, via }
    );
    if (!write.ok) return { kind: "conflict", conflict: write.conflict };
    return {
      kind: "updated",
      row: write.value.row,
      changed: write.value.changed,
      replacements: result.replacements,
    };
  });

  if (outcome.kind === "conflict") {
    return conflictResponse(outcome.conflict, id);
  }
  if (outcome.kind === "rejected") {
    const { message, code, match_count, edit_index } = outcome.result;
    return jsonResponse({
      error: true,
      message,
      code,
      ...(edit_index !== undefined ? { edit_index } : {}),
      match_count,
    });
  }

  const { row, changed, replacements } = outcome;
  if (changed) {
    indexNote(row.id, indexPayload(row)).catch((err) =>
      console.warn(`[${via}] Background indexing failed:`, (err as Error).message)
    );
    if (config.entityExtractionEnabled && config.entityExtractionAsync) {
      const noteText = [row.title, row.content].filter(Boolean).join("\n");
      extractAndStore("note", row.id, noteText).catch((err) =>
        console.warn(`[${via}] Background entity extraction failed:`, (err as Error).message)
      );
    }
  }

  return jsonResponse({
    id: row.id,
    title: row.title,
    version: row.version,
    changed,
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
      title: z.string().describe("Short descriptive title."),
      content: z.string().describe("The knowledge itself; can be long."),
      scope: scopeEnum.describe(
        "'work', 'personal', or 'shared' (reusable across both). Ask when unclear."
      ),
      domain: z.string().optional().describe("Category, e.g. 'architecture', 'security', 'health'."),
      tags: z.array(z.string()).optional().describe("Free-form tags."),
      source_url: z.string().optional().describe("URL of the source material."),
      related_task_ids: z.array(z.string()).optional().describe("UUIDs of related tasks."),
      provenance: provenanceEnum.optional().describe(
        "Where the content came from (see the tool description). Use 'inferred' unless the user confirmed it."
      ),
      valid_until: z.string().optional().describe(
        "Expiry: ISO-8601 date-time with offset, e.g. '2026-12-31T00:00:00Z'. Omit if it does not lapse."
      ),
    },
    async (args) => {
      if (!args.title?.trim()) {
        return errorResponse("title is required", "VALIDATION_ERROR");
      }
      if (!args.content?.trim()) {
        return errorResponse("content is required", "VALIDATION_ERROR");
      }

      let validUntil: string | null = null;
      if (args.valid_until !== undefined) {
        validUntil = parseIsoWithOffset(args.valid_until);
        if (validUntil === null) {
          return errorResponse(VALID_UNTIL_ERROR, "VALIDATION_ERROR");
        }
      }

      try {
        const { row } = await withTransaction((client) =>
          insertNoteInTx(client, {
            title: args.title,
            content: args.content,
            scope: args.scope,
            domain: args.domain ?? null,
            tags: args.tags ?? [],
            source_url: args.source_url ?? null,
            related_task_ids: args.related_task_ids ?? [],
            provenance: args.provenance ?? null,
            valid_until: validUntil,
          })
        );
        indexNote(row.id, indexPayload(row)).catch((err) =>
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
          version: row.version,
          status: effectiveStatus(row),
          provenance: row.provenance,
          valid_until: row.valid_until,
          ...(args.provenance === undefined
            ? {
                hint: "Provenance was not set. On your next write, set provenance ('stated', 'decided', 'inferred', 'fetched', or 'derived') so future sessions know how far to trust this note; update_note can add it to this one.",
              }
            : {}),
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
      id: z.string().describe("Note id (UUID)."),
    },
    async (args) => {
      try {
        // Select only succ.title from the join: a bare succ.* would clobber
        // n.id (and every other n.* column) in node-postgres's row object.
        const result = await query<
          NoteRow & { effective_status: string; successor_title: string | null }
        >(
          `SELECT n.*, ${effectiveStatusSql("n")} AS effective_status, succ.title AS successor_title
             FROM notes n
             LEFT JOIN notes succ ON succ.id = n.superseded_by
            WHERE n.id = $1`,
          [args.id]
        );
        if (result.rows.length === 0) {
          return errorResponse(`Note not found: ${args.id}`, "NOT_FOUND");
        }
        const row = result.rows[0];
        const predecessors = await query<{ id: string }>(
          "SELECT id FROM notes WHERE superseded_by = $1 ORDER BY created_at",
          [args.id]
        );
        return jsonResponse({
          ...formatNote(row),
          status: row.effective_status,
          successor: row.superseded_by
            ? { id: row.superseded_by, title: row.successor_title }
            : null,
          supersedes: predecessors.rows.map((r) => r.id),
        });
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
      limit: z.number().min(1).max(100).optional().describe("Max results (default 20)."),
      offset: z.number().min(0).optional().describe("Rows to skip (default 0)."),
      scope: scopeEnum.nullable().optional().describe("Scope filter; omit or null = all."),
      domain: z.string().optional().describe("Domain filter (exact match)."),
      tags: z.array(z.string()).optional().describe("Match notes with ANY of these tags."),
      status: statusFilterEnum.nullable().optional().describe(
        "Lifecycle filter ('expired' = valid_until has passed); omit or null = all."
      ),
      order_by: listOrderByEnum.optional().describe("Sort field (default 'created_at')."),
      order_dir: orderDirEnum.optional().describe("Sort direction (default 'desc')."),
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

        if (args.status) {
          conditions.push(`${effectiveStatusSql("notes")} = $${paramIdx++}`);
          params.push(args.status);
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
      query: z.string().describe("Search words; every word must match (stemmed)."),
      scope: scopeEnum.nullable().optional().describe("Scope filter; omit or null = all."),
      domain: z.string().optional().describe("Domain filter (exact match)."),
      limit: z.number().min(1).max(50).optional().describe("Max results (default 10)."),
      include_superseded: z
        .boolean()
        .optional()
        .describe(
          "true: return superseded notes as themselves (status 'superseded') instead of redirecting. Default false."
        ),
      include_expired: z
        .boolean()
        .optional()
        .describe(
          "true: include notes whose valid_until has passed, flagged status 'expired'. Default false."
        ),
    },
    async (args) => {
      if (!args.query?.trim()) {
        return errorResponse("query is required", "VALIDATION_ERROR");
      }

      try {
        const includeSuperseded = args.include_superseded ?? false;
        const includeExpired = args.include_expired ?? false;

        // Candidates span every status except COMPUTED-expired (unless opted
        // in): a superseded note stays a candidate even if its own valid_until
        // has passed, because supersession wins over expiry and the note must
        // be redirected to its successor. Superseded candidates are redirected
        // to the chain head below ("redirect, do not hide", design section
        // 6.1), so a query that only matches the OLD wording still finds the
        // knowledge. Columns are qualified because the data query self-joins
        // `notes`.
        const conditions: string[] = [
          `to_tsvector('english', coalesce(notes.title, '') || ' ' || coalesce(notes.content, '')) @@ plainto_tsquery('english', $1)`,
          searchCandidatePredicateSql("notes", { includeExpired }),
        ];
        const params: unknown[] = [args.query];
        let paramIdx = 2;

        if (args.scope) {
          conditions.push(`notes.scope = $${paramIdx++}`);
          params.push(args.scope);
        }

        if (args.domain) {
          conditions.push(`notes.domain = $${paramIdx++}`);
          params.push(args.domain);
        }

        const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
        // Over-fetch so merges and drops during redirection do not leave the
        // page short; the redirected list is sliced back to `limit` below.
        const fetchLimit = Math.min(limit * 2, 100);
        const where = conditions.join(" AND ");

        const countResult = await query<{ count: string }>(
          `SELECT COUNT(*) as count FROM notes WHERE ${where}`,
          params
        );
        const totalCount = parseInt(countResult.rows[0].count, 10);

        type Candidate = NoteRow & {
          rank: number;
          effective_status: EffectiveNoteStatus;
          successor_title: string | null;
        };
        const dataResult = await query<Candidate>(
          `SELECT notes.*,
                  ${effectiveStatusSql("notes")} AS effective_status,
                  succ.title AS successor_title,
                  ts_rank(
                    to_tsvector('english', coalesce(notes.title, '') || ' ' || coalesce(notes.content, '')),
                    plainto_tsquery('english', $1)
                  ) AS rank
             FROM notes
             LEFT JOIN notes succ ON succ.id = notes.superseded_by
            WHERE ${where}
            ORDER BY rank DESC, notes.created_at DESC, notes.id
            LIMIT $${paramIdx}`,
          [...params, fetchLimit]
        );

        // Lifecycle facts for the candidates come straight from the rows.
        const noteById = new Map<string, Candidate>();
        const lifecycle = new Map<string, NoteLifecycleRow>();
        for (const row of dataResult.rows) {
          noteById.set(row.id, row);
          lifecycle.set(row.id, lifecycleFromNoteRow(row));
        }

        // Follow-ups (only when something is superseded): walk chains to their
        // heads, then load heads that were not themselves candidates.
        const heads = new Map<string, string>();
        if (!includeSuperseded) {
          const supersededIds = dataResult.rows
            .filter((r) => r.effective_status === "superseded")
            .map((r) => r.id);
          if (supersededIds.length > 0) {
            for (const [from, to] of await resolveChainHeads(pool, supersededIds)) heads.set(from, to);
            const missing = [...new Set(heads.values())].filter((id) => !noteById.has(id));
            if (missing.length > 0) {
              // A redirect must not smuggle in a note the caller's scope /
              // domain filter excludes: heads are fetched under the same
              // filters, and a head that does not come back leaves its
              // candidate shown as itself (flagged superseded, with a notice).
              const headConditions = ["notes.id = ANY($1::uuid[])"];
              const headParams: unknown[] = [missing];
              if (args.scope) {
                headParams.push(args.scope);
                headConditions.push(`notes.scope = $${headParams.length}`);
              }
              if (args.domain) {
                headParams.push(args.domain);
                headConditions.push(`notes.domain = $${headParams.length}`);
              }
              const headResult = await query<Candidate>(
                `SELECT notes.*, ${effectiveStatusSql("notes")} AS effective_status,
                        NULL::text AS successor_title, 0::real AS rank
                   FROM notes WHERE ${headConditions.join(" AND ")}`,
                headParams
              );
              for (const row of headResult.rows) {
                noteById.set(row.id, row);
                lifecycle.set(row.id, lifecycleFromNoteRow(row));
              }
            }
          }
        }

        // The pure redirect operates on search-result rows; a candidate's
        // ts_rank rides in rrf_score so "best score wins" works on merge.
        const candidateRows: SearchResultRow[] = dataResult.rows.map((r) => ({
          content_type: "note",
          content_id: r.id,
          content_text: "",
          metadata: {},
          rrf_score: r.rank,
        }));
        const redirect = applyLifecycleRedirect(candidateRows, lifecycle, heads, {
          includeSuperseded,
          includeExpired,
        });

        const shown = redirect.rows.slice(0, limit);
        const notes = shown.map((r) => {
          const row = noteById.get(r.content_id)!;
          return {
            ...formatNote(row),
            // Computed by Postgres (same clock as the candidate predicate).
            status: r.note_status ?? row.effective_status,
            successor_title: r.successor_title ?? null,
            matched_via: r.matched_via ?? [],
            rank: r.rrf_score ?? 0,
          };
        });

        // Only report notices that are still true of the page returned.
        const keptNotices = keepShownNotices(redirect.notices, new Set(shown.map((r) => r.content_id)), limit);
        const redirectedCount = keptNotices.filter((n) => n.kind === "redirect").length;

        let nextStep: string;
        if (notes.length > 0) {
          nextStep =
            "Notes contain documented decisions. Reference them by title in your response. Do not re-derive conclusions that contradict these notes.";
        } else if (keptNotices.length > 0) {
          nextStep =
            "Matching notes exist but none is current - read lifecycle_notices before creating a new note on this topic.";
        } else {
          nextStep =
            "No matching notes found. If making a new decision on this topic, consider creating a note to document it.";
        }
        const lifecycleStep = lifecycleNextStep(keptNotices);
        if (lifecycleStep) nextStep += ` ${lifecycleStep}`;

        return jsonResponse({
          notes,
          total_count: totalCount,
          redirected: redirectedCount,
          lifecycle_notices: keptNotices.map((n) => n.text),
          next_step: nextStep,
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
      id: z.string().describe("Note id (UUID)."),
      title: z.string().optional().describe("New title."),
      content: z.string().optional().describe("New full content, replacing the old."),
      domain: z.string().nullable().optional().describe("New domain; null clears."),
      tags: z.array(z.string()).optional().describe("New tags; replaces the whole list."),
      scope: scopeEnum.optional().describe("New scope."),
      source_url: z.string().nullable().optional().describe("New source URL; null clears."),
      related_task_ids: z.array(z.string()).optional().describe("Related task UUIDs; replaces the whole list."),
      provenance: provenanceEnum.nullable().optional().describe(
        "stated, decided, inferred (your unconfirmed conclusion), fetched or derived; null clears. Use 'inferred' unless the user confirmed it."
      ),
      valid_until: z.string().nullable().optional().describe(
        "Expiry: ISO-8601 date-time with offset, e.g. '2026-12-31T00:00:00Z'; null clears."
      ),
      expected_version: z.number().int().min(1).optional().describe(
        "Note version you last read. Enforced when present (mismatch: VERSION_CONFLICT, nothing written); omit for last-writer-wins."
      ),
    },
    async (args) => {
      // Build the patch. expected_version is a precondition, not an update:
      // it alone does not count as "an update provided".
      const patch: NotePatch = {};
      if (args.title !== undefined) patch.title = args.title;
      if (args.content !== undefined) patch.content = args.content;
      if (args.domain !== undefined) patch.domain = args.domain;
      if (args.tags !== undefined) patch.tags = args.tags;
      if (args.scope !== undefined) patch.scope = args.scope;
      if (args.source_url !== undefined) patch.source_url = args.source_url;
      if (args.related_task_ids !== undefined) patch.related_task_ids = args.related_task_ids;
      if (args.provenance !== undefined) patch.provenance = args.provenance;
      if (args.valid_until !== undefined) {
        if (args.valid_until === null) {
          patch.valid_until = null;
        } else {
          const normalised = parseIsoWithOffset(args.valid_until);
          if (normalised === null) {
            return errorResponse(VALID_UNTIL_ERROR, "VALIDATION_ERROR");
          }
          patch.valid_until = normalised;
        }
      }

      if (Object.keys(patch).length === 0) {
        return errorResponse("No updates provided", "VALIDATION_ERROR");
      }

      try {
        const result = await withTransaction((client) =>
          updateNoteInTx(client, args.id, patch, {
            expectedVersion: args.expected_version,
            via: "update_note",
          })
        );

        if (!result.ok) {
          return conflictResponse(result.conflict, args.id);
        }
        const { row, changed } = result.value;

        // Re-index and re-extract only when something actually changed AND
        // one of the indexed fields was part of the patch.
        const indexedFieldTouched =
          args.title !== undefined ||
          args.content !== undefined ||
          args.domain !== undefined ||
          args.tags !== undefined;
        if (changed && indexedFieldTouched) {
          indexNote(row.id, indexPayload(row)).catch((err) =>
            console.warn("[update_note] Background indexing failed:", (err as Error).message)
          );
          if (config.entityExtractionEnabled && config.entityExtractionAsync) {
            const noteText = [row.title, row.content].filter(Boolean).join("\n");
            extractAndStore("note", row.id, noteText).catch((err) =>
              console.warn("[update_note] Background entity extraction failed:", (err as Error).message)
            );
          }
        }

        return jsonResponse({ ...formatNote(row), changed });
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );

  // ── edit_note ────────────────────────────────────────────────
  registerTool(
    mcpServer,
    "edit_note",
    EDIT_NOTE_DESC,
    {
      id: z.string().describe("Note id (UUID)."),
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
      expected_version: z.number().int().min(1).optional().describe(
        "Note version you last read. Enforced when present (mismatch: VERSION_CONFLICT, nothing written); omit for last-writer-wins."
      ),
    },
    async (args) => {
      try {
        return await editNoteContent(args.id, "edit_note", args.expected_version, (content) => {
          const result = applyEdits(content, args.edits);
          if (!result.ok) {
            const message =
              result.code === "NO_MATCH"
                ? `edits[${result.edit_index}].old_str was not found in the note content (after applying earlier edits). Call get_note and copy the text exactly.`
                : `edits[${result.edit_index}].old_str matches ${result.match_count} times. Widen old_str with surrounding text to make it unique, or pass replace_all: true.`;
            return {
              ok: false,
              message,
              code: result.code,
              edit_index: result.edit_index,
              match_count: result.match_count,
            };
          }
          return { ok: true, content: result.content, replacements: result.replacements };
        });
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    },
    {
      str_replace_note: strReplaceNoteAdapter((id, expectedVersion, edit) =>
        editNoteContent(id, "edit_note", expectedVersion, edit)
      ),
    }
  );

  // ── append_note ──────────────────────────────────────────────
  mcpServer.tool(
    "append_note",
    APPEND_NOTE_DESC,
    {
      id: z.string().describe("Note id (UUID)."),
      content: z
        .string()
        .describe("Text to append (non-empty); starts on a new line."),
      expected_version: z.number().int().min(1).optional().describe(
        "The note's version as you last read it; on mismatch VERSION_CONFLICT. Usually omitted for logs."
      ),
    },
    async (args) => {
      if (!args.content) {
        return errorResponse("content must be a non-empty string", "VALIDATION_ERROR");
      }
      try {
        return await editNoteContent(args.id, "append_note", args.expected_version, (content) => ({
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
      id: z.string().describe("Note id (UUID)."),
    },
    async (args) => {
      try {
        const outcome = await withTransaction((client) =>
          deleteNoteInTx(client, args.id, { via: "delete_note" })
        );
        if (outcome === null) {
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

        return jsonResponse({
          deleted: true,
          id: args.id,
          relinked: outcome.relinked.map((r) => ({
            id: r.id,
            status: effectiveStatus(r),
            superseded_by: r.superseded_by,
          })),
        });
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );

  // ── supersede_note ───────────────────────────────────────────
  mcpServer.tool(
    "supersede_note",
    SUPERSEDE_NOTE_DESC,
    {
      id: z.string().describe("Id of the OLD note being retired; it must not already be superseded."),
      superseded_by: z.string().describe(
        "Id of the successor note, which must already exist and be active (create it first with create_note)."
      ),
      expected_version: z.number().int().min(1).optional().describe(
        "The OLD note's version as you last read it; on mismatch VERSION_CONFLICT, nothing written."
      ),
    },
    async (args) => {
      try {
        const result = await withTransaction((client) =>
          supersedeNoteInTx(client, args.id, args.superseded_by, {
            expectedVersion: args.expected_version,
            via: "supersede_note",
          })
        );

        if (!result.ok) {
          return conflictResponse(result.conflict, args.id, { successorId: args.superseded_by });
        }
        const { old, successor } = result.value;
        return jsonResponse({
          superseded: {
            id: old.id,
            title: old.title,
            version: old.version,
            superseded_by: old.superseded_by,
            superseded_at: old.superseded_at,
          },
          successor: { id: successor.id, title: successor.title },
        });
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );

  // ── get_note_history ─────────────────────────────────────────
  mcpServer.tool(
    "get_note_history",
    GET_NOTE_HISTORY_DESC,
    {
      id: z.string().describe("Note id (UUID)."),
      limit: z.number().int().min(1).max(50).optional().describe("Max entries (default 10)."),
      offset: z.number().int().min(0).optional().describe(
        "Entries to skip from the newest (entry 0 is the current version). Default 0."
      ),
    },
    async (args) => {
      const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
      const offset = Math.max(args.offset ?? 0, 0);

      try {
        // One REPEATABLE READ transaction so the current row, the history
        // count, and the history page all describe the same instant — a
        // concurrent edit cannot duplicate or drop an entry between reads.
        const page = await withTransaction(async (client) => {
          await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
          const current = await client.query<NoteRow>(
            "SELECT * FROM notes WHERE id = $1",
            [args.id]
          );
          if (current.rows.length === 0) return null;

          const count = await client.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM note_versions WHERE note_id = $1",
            [args.id]
          );
          const historyCount = parseInt(count.rows[0]?.count ?? "0", 10);

          // Entry 0 is the current row; history rows follow, newest first.
          // `offset` counts from entry 0, so the history window is shifted by
          // one when the current row is on this page.
          const includeCurrent = offset === 0;
          const historyOffset = Math.max(offset - 1, 0);
          const historyLimit = includeCurrent ? limit - 1 : limit;
          let history: NoteVersionRow[] = [];
          if (historyLimit > 0) {
            const res = await client.query<NoteVersionRow>(
              `SELECT note_id, version, snapshot, changed_fields, changed_via, changed_at
                 FROM note_versions
                WHERE note_id = $1
                ORDER BY version DESC
                LIMIT $2 OFFSET $3`,
              [args.id, historyLimit, historyOffset]
            );
            history = res.rows;
          }
          return { current: current.rows[0], historyCount, includeCurrent, history };
        });

        if (page === null) {
          return errorResponse(`Note not found: ${args.id}`, "NOT_FOUND");
        }

        const { current, historyCount, includeCurrent, history } = page;
        const entries: Array<Record<string, unknown>> = [];
        if (includeCurrent) {
          entries.push({
            version: current.version,
            title: current.title,
            content: current.content,
            domain: current.domain,
            tags: current.tags || [],
            scope: current.scope,
            source_url: current.source_url,
            related_task_ids: current.related_task_ids || [],
            provenance: current.provenance,
            valid_until: current.valid_until,
            status: current.status,
            superseded_by: current.superseded_by,
            superseded_at: current.superseded_at,
            changed_fields: [],
            changed_via: null,
            changed_at: current.updated_at,
            is_current: true,
          });
        }
        for (const h of history) {
          const snap = h.snapshot;
          entries.push({
            version: h.version,
            title: snap.title ?? null,
            content: snap.content ?? null,
            domain: snap.domain ?? null,
            tags: snap.tags ?? [],
            scope: snap.scope ?? null,
            source_url: snap.source_url ?? null,
            related_task_ids: snap.related_task_ids ?? [],
            provenance: snap.provenance ?? null,
            valid_until: snapshotTime(snap.valid_until),
            status: snap.status ?? null,
            superseded_by: snap.superseded_by ?? null,
            superseded_at: snapshotTime(snap.superseded_at),
            changed_fields: h.changed_fields,
            changed_via: h.changed_via,
            changed_at: h.changed_at,
            is_current: false,
          });
        }

        return jsonResponse({
          id: args.id,
          current_version: current.version,
          total_entries: 1 + historyCount,
          entries,
          limit,
          offset,
        });
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );

  // ── prune_note_history ───────────────────────────────────────
  mcpServer.tool(
    "prune_note_history",
    PRUNE_NOTE_HISTORY_DESC,
    {
      id: z.string().describe("Note id (UUID)."),
      keep_last: z.number().int().min(0).describe(
        "Number of newest prior versions to keep; 0 deletes all history."
      ),
    },
    async (args) => {
      try {
        const outcome = await withTransaction((client) =>
          pruneNoteHistoryInTx(client, args.id, args.keep_last)
        );
        if (outcome === null) {
          return errorResponse(`Note not found: ${args.id}`, "NOT_FOUND");
        }
        return jsonResponse({
          id: args.id,
          current_version: outcome.row.version,
          deleted: outcome.deleted,
          remaining: outcome.remaining,
        });
      } catch (err) {
        return errorResponse((err as Error).message, "DB_ERROR");
      }
    }
  );
}
