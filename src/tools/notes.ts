import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pool, query } from "../db/client.js";
import { withTransaction } from "../db/changes.js";
import { indexNote } from "../embeddings/indexer.js";
import { config } from "../config.js";
import { extractAndStore } from "../entities/pipeline.js";
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

const PROVENANCE_STEERING = `Provenance: set 'provenance' on every note to record where its content came from.
- 'stated' — the user said it directly (e.g. "Jane Developer said the Acme Corp cutover is 12 March").
- 'decided' — a decision reached in conversation and agreed by the user.
- 'inferred' — your own conclusion from evidence the user did not confirm.
- 'fetched' — captured from external material (also set source_url).
- 'derived' — computed or aggregated from other notes, tasks, or handoffs.
Be honest: 'inferred' is correct whenever the user did not confirm the claim — a wrong 'stated' or 'decided' will be treated as the user's own words in future sessions and never challenged.`;

const CREATE_NOTE_DESC = `Create a permanent knowledge entry. Use for decisions made, approaches tried, constraints discovered, patterns identified, article takeaways, and connections between ideas — anything that should survive across sessions and never be compacted away.

Context Library has four content primitives — tasks, handoffs, artifacts, and notes. Notes are distinct from the others:
- Tasks are action items with a lifecycle (open → completed). "Research X" is a task.
- Handoffs are ephemeral session state that gets compacted over time.
- Artifacts are generated outputs with a status lifecycle (draft → ready → completed). A produced CC prompt is an artifact.
- Notes are permanent interpretation — the reasoning, the decision, the insight. "After researching X, we decided Y because Z" is knowledge.

Use the 'domain' field to categorize (e.g., 'architecture', 'security', 'career', 'health'). Tags are free-form and compose with domain. The 'scope' field separates work/personal/shared knowledge. Provide 'source_url' when capturing takeaways from external material. Set 'related_task_ids' to link a note back to the tasks that produced it.

Scope routing: scope is required. If the user's request is clearly personal (health, family, finance), pass scope='personal'. If clearly work-related, pass scope='work'. If the note is reusable across contexts (architecture decisions, OSS project notes, language patterns), pass scope='shared'. When ambiguous, ask before storing.

Content can be long — notes do not compact. Notes are versioned: every later edit keeps the prior version (see get_note_history), and a note whose facts change should be edited with update_note, or retired with supersede_note once a newer note replaces it.

${PROVENANCE_STEERING}

Expiry: set 'valid_until' (ISO-8601 date-time WITH an explicit offset, e.g. 2026-12-31T00:00:00Z) when the knowledge has a known end date — a freeze window, a trial period, a deadline-bound constraint. After that instant the note reads status 'expired' (computed; nothing is deleted or hidden). Omit it for knowledge that does not lapse. A date-time without an offset is rejected with VALIDATION_ERROR.

Returns { id, title, created_at, version (starts at 1), status, provenance, valid_until }, plus a 'hint' when provenance was omitted.`;

const GET_NOTE_DESC = `Retrieve a single note by its UUID. Returns the full note object including content.

Lifecycle fields: 'status' is 'active', 'superseded' (replaced by a newer note — see 'successor'), or 'expired' (valid_until has passed; computed at read time). 'successor' is { id, title } for a superseded note, otherwise null. 'supersedes' lists the ids of notes this one replaced. 'provenance' says where the content came from (null = not recorded). 'version' is the note's edit counter — pass it as expected_version to update_note or supersede_note to guard against overwriting a concurrent edit. Use get_note_history to read what earlier versions said.`;

const LIST_NOTES_DESC = `List knowledge entries with optional filters and pagination. Returns metadata only (id, title, domain, scope, tags, status, valid_until, superseded_by, provenance, version, timestamps) — NOT the full content. Call get_note for the body.

Defaults to newest-first by created_at. Filter by scope, domain, tags (ANY-match), or lifecycle status. Use search_notes or search_context when you want relevance ranking instead of filtered browsing.

Scope filter: when scope is omitted, this tool returns notes across all scopes (work, personal, shared). Pass scope='work', 'personal', or 'shared' to restrict results.

Status filter: when status is omitted, notes of every status are listed (this is an inventory, not retrieval). Pass status='active' for current knowledge only, 'superseded' for notes that have been replaced, or 'expired' for notes whose valid_until has passed.`;

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

Lifecycle: a note can be superseded by a newer note, or expire (valid_until in the past). By default this tool REDIRECTS: when a superseded note matches, the result for it is replaced by the note that currently stands in its place (the head of its supersession chain), keeping the old note's relevance rank, and its matched_via lists the superseded note id(s) that matched. If the current note also matched directly, the two merge into one result. Expired notes are omitted (a superseded note is still redirected even if its own valid_until has passed). If a superseded note matched but its chain ends in an expired note, nothing is shown for it and a notice says so - do not treat the old note as current. The scope and domain filters apply to the successor too: if the successor lies outside the filter, the superseded note is returned as itself, flagged status 'superseded', with a notice. 'lifecycle_notices' holds one plain-English line per redirect (and per expired or superseded note you opted to see) - READ it whenever it is non-empty, and cite the successor, never the superseded note. Pass include_superseded: true to get superseded notes as themselves (flagged, with successor_title), include_expired: true to include expired notes (flagged). Each result carries status (active | superseded | expired), superseded_by, superseded_at, successor_title (null unless superseded), valid_until, provenance, version, matched_via ([] when it matched directly).

Returns: { notes[], total_count, redirected, lifecycle_notices[], next_step }. total_count counts the matching candidates BEFORE redirection; because redirects can merge or drop results, notes.length may be smaller than total_count or limit (redirected is the number of superseded matches that were replaced by a returned successor — several matches can collapse into one successor). Notices describe only the page returned.

Filter by scope and domain. For cross-type semantic search that finds relevant notes alongside handoffs and tasks, use search_context with content_types: ["note"] instead — this tool only searches within the notes table.`;

const UPDATE_NOTE_DESC = `Update fields on an existing note. All fields are optional — only provided fields are modified, and at least one must be given. Tags and related_task_ids are full-replacement (provide complete arrays). Pass null to clear domain, source_url, provenance, or valid_until. Re-embeds on title/content/domain/tags change.

Version history: every note has a 'version' counter. Every edit that actually changes something records the prior version (readable later with get_note_history) and bumps the counter. An edit that changes nothing is a true no-op: the response has changed: false and the version does not move.

Edit precondition: pass expected_version (the 'version' you saw in get_note or in a previous response) to be sure you are editing the note you read. It is enforced whenever present, whatever fields the call changes. If the note has moved on, nothing is written and you get VERSION_CONFLICT with the note as it is now under 'current' — re-read, reconcile, and retry with the new version. Omit expected_version for a last-writer-wins edit (the overwritten content is still kept in history).

Valid_until: ISO-8601 date-time WITH an explicit offset (e.g. 2026-12-31T00:00:00Z); a value without an offset is rejected. Pass null to clear it, which revives an expired note.

This tool cannot change a note's lifecycle status. To retire a note in favour of a newer one, call supersede_note. Editing a superseded or expired note is allowed and versioned; its status is unaffected.

${PROVENANCE_STEERING} Pass provenance: null to clear it.

Returns the full updated note plus 'changed' (false when the call was a no-op).`;

const DELETE_NOTE_DESC = `Permanently delete a note by UUID. Also removes its entry from the embeddings index and its entire version history. Knowledge entries are intended to be permanent — use this only for mistakes (a note that should never have existed); use supersede_note when the knowledge simply changed. Deletion cannot be undone.

Deleting a note that sits in a supersession chain splices the chain so no note is left pointing at nothing: notes that the deleted note had superseded are re-pointed to the deleted note's own successor, or reactivated (status back to 'active') when the deleted note was the end of the chain. The response lists every affected note under 'relinked' as { id, status, superseded_by }.

Returns { deleted: true, id, relinked }.`;

const SUPERSEDE_NOTE_DESC = `Retire a note because a newer note replaces it. The old note is kept — content and history intact — and marked status 'superseded' with 'superseded_by' pointing at the successor and 'superseded_at' recording when. Use this when the knowledge CHANGED (a decision was reversed, a fact was updated); use delete_note only for mistakes, and update_note to fix or extend a note that is still true.

Workflow: (1) create the successor first with create_note — it must already exist; (2) call supersede_note({ id: <old note>, superseded_by: <new note> }). Both notes must be active: a superseded or expired note cannot be the successor (INVALID_SUCCESSOR), and a note cannot supersede itself (INVALID_SUCCESSOR). If the old note is already superseded you get STATUS_CONFLICT with the note as it is now under 'current' (its 'superseded_by' shows what replaced it). Pass expected_version (from get_note) to guard against the old note being edited concurrently: a stale value returns VERSION_CONFLICT with the current note.

Superseded notes keep their content and are marked status 'superseded' with superseded_by pointing at the successor; get_note on the successor lists the old note under 'supersedes'. Search follows the chain for readers: search_notes and search_context redirect from a superseded note to its successor by default and say so in lifecycle_notices (pass include_superseded: true to see superseded notes themselves), so superseding does not hide the old wording from a query that only matches it. There is no un-supersede tool. If you superseded the WRONG note, the only recovery is delete_note on the successor — which PERMANENTLY deletes the successor and its history, and reactivates (or re-points down the chain) EVERY note that successor had superseded, not just the one you meant. Do that only when the successor was created for this supersession alone and you will re-create it; otherwise tell the user and leave the chain as it is.

Returns { superseded: { id, title, version, superseded_by, superseded_at }, successor: { id, title } }. Errors: NOT_FOUND (either id missing; the message says which), VERSION_CONFLICT, STATUS_CONFLICT, INVALID_SUCCESSOR.`;

const GET_NOTE_HISTORY_DESC = `Read the version history of a note: what it said before each edit, which fields changed, and which tool made the change. Entries are newest-first; entry 0 is the current version (is_current: true), followed by earlier versions. Each entry carries the full prior content: version, title, content, domain, tags, scope, source_url, related_task_ids, provenance, valid_until, status (the stored lifecycle status, 'active' or 'superseded'; expiry is not stored, so compare valid_until), superseded_by, superseded_at, changed_fields, changed_via, changed_at, is_current.

For an earlier version, changed_fields / changed_via / changed_at describe the edit that REPLACED that version (for example changed_fields ["content"], changed_via "update_note"). The current entry has changed_fields [] and changed_via null, and its changed_at is the note's last-modified time. changed_via is the tool that wrote the change; "sql" means a writer outside the tools.

CALL THIS WHEN:
- A note reads differently than you expected, or its content seems to have changed since you last saw it
- You received VERSION_CONFLICT from update_note or supersede_note and need to see what the other writer changed
- The user asks what a note used to say, when it changed, or what changed
- You are about to revert or rewrite a note and want to see the prior wording first

DO NOT CALL WHEN:
- You want to browse or find notes (use list_notes or search_notes)
- You want the current fact only (use get_note)

CONSEQUENCE OF SKIPPING: You may overwrite another writer's change without seeing it, or misreport what a note used to say.

Parameters: limit (1-50, default 10) and offset (default 0, counts from entry 0) page through long histories. Returns { id, current_version, total_entries, entries, limit, offset }. NOT_FOUND if the note does not exist. History is removed with the note when it is deleted, and can be trimmed with prune_note_history.`;

const PRUNE_NOTE_HISTORY_DESC = `Delete old versions from one note's history, keeping only the newest keep_last prior versions. The note itself (its current content) is not changed.

This is the ONLY way to remove content that was edited out of a note: version history otherwise persists indefinitely and is included in exports. Use it when something sensitive (a pasted secret, a mistaken personal detail) was edited out of a note and must not survive in history, or to trim a very long history. keep_last: 0 purges all history. This is irreversible: pruned versions can no longer be read with get_note_history. The note's current version number is unchanged.

Returns { id, current_version, deleted (history rows removed), remaining (history rows kept) }. NOT_FOUND if the note does not exist.`;

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
      provenance: provenanceEnum.optional().describe(
        "Where the content came from: 'stated' (user said it), 'decided' (agreed in conversation), 'inferred' (your own conclusion, unconfirmed), 'fetched' (external material), 'derived' (computed from other notes/tasks/handoffs). Be honest — 'inferred' whenever the user did not confirm."
      ),
      valid_until: z.string().optional().describe(
        "Expiry instant as an ISO-8601 date-time WITH an explicit offset (e.g. '2026-12-31T00:00:00Z'). After it the note reads status 'expired'. Omit for knowledge that does not lapse."
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
      id: z.string().describe("UUID of the note to retrieve"),
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
      limit: z.number().min(1).max(100).optional().describe("Max results (1-100, default 20)"),
      offset: z.number().min(0).optional().describe("Offset for pagination (default 0)"),
      scope: scopeEnum.nullable().optional().describe("Filter by scope (null/omitted = all scopes)"),
      domain: z.string().optional().describe("Filter by domain"),
      tags: z.array(z.string()).optional().describe("Filter by tags (ANY match)"),
      status: statusFilterEnum.nullable().optional().describe(
        "Filter by computed lifecycle status: 'active', 'superseded', or 'expired' (null/omitted = all statuses)"
      ),
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
      query: z.string().describe("Full-text search query"),
      scope: scopeEnum.nullable().optional().describe("Filter by scope"),
      domain: z.string().optional().describe("Filter by domain"),
      limit: z.number().min(1).max(50).optional().describe("Max results (1-50, default 10)"),
      include_superseded: z
        .boolean()
        .optional()
        .describe(
          "false (default): a superseded note that matches is replaced by its current successor (see matched_via and lifecycle_notices). true: return superseded notes as themselves, flagged status 'superseded' with successor_title."
        ),
      include_expired: z
        .boolean()
        .optional()
        .describe(
          "false (default): notes whose valid_until has passed are omitted. true: include them, flagged status 'expired'."
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
      id: z.string().describe("UUID of the note to update"),
      title: z.string().optional().describe("New title"),
      content: z.string().optional().describe("New content"),
      domain: z.string().nullable().optional().describe("New domain, or null to clear"),
      tags: z.array(z.string()).optional().describe("New tags (full replacement)"),
      scope: scopeEnum.optional().describe("New scope"),
      source_url: z.string().nullable().optional().describe("New source URL, or null to clear"),
      related_task_ids: z.array(z.string()).optional().describe("New related task IDs (full replacement)"),
      provenance: provenanceEnum.nullable().optional().describe(
        "Where the content came from: 'stated', 'decided', 'inferred', 'fetched', or 'derived'; null clears it. Be honest — 'inferred' whenever the user did not confirm."
      ),
      valid_until: z.string().nullable().optional().describe(
        "Expiry instant as an ISO-8601 date-time WITH an explicit offset (e.g. '2026-12-31T00:00:00Z'), or null to clear it (revives an expired note)"
      ),
      expected_version: z.number().int().min(1).optional().describe(
        "Optimistic-concurrency precondition: the note's 'version' as you last saw it (from get_note or a previous response). Enforced whenever present; on mismatch nothing is written and VERSION_CONFLICT returns the current note. Omit for last-writer-wins."
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

  // ── delete_note ──────────────────────────────────────────────
  mcpServer.tool(
    "delete_note",
    DELETE_NOTE_DESC,
    {
      id: z.string().describe("UUID of the note to delete"),
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
      id: z.string().describe("UUID of the OLD note being retired (it must be active)"),
      superseded_by: z.string().describe(
        "UUID of the successor note that replaces it. The successor must already exist and be active (create it first with create_note)."
      ),
      expected_version: z.number().int().min(1).optional().describe(
        "Optional precondition on the OLD note's 'version' (from get_note). Enforced whenever present; on mismatch nothing is written and VERSION_CONFLICT returns the current note."
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
      id: z.string().describe("UUID of the note whose history to read"),
      limit: z.number().int().min(1).max(50).optional().describe("Max entries (1-50, default 10)"),
      offset: z.number().int().min(0).optional().describe(
        "Entries to skip, counted from the newest entry (the current version is entry 0). Default 0."
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
      id: z.string().describe("UUID of the note whose history to prune"),
      keep_last: z.number().int().min(0).describe(
        "How many of the newest prior versions to keep. 0 purges all history. Irreversible."
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
