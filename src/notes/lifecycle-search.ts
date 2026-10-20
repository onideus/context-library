import type { PoolClient } from "pg";
import {
  fetchNoteLifecycle,
  resolveChainHeads,
  searchCandidatePredicateSql,
  type NoteLifecycleRow,
} from "./store.js";
import type { EffectiveNoteStatus, NoteScope, Provenance } from "./store.js";
import type { SearchResultRow } from "../tools/search.js";

/**
 * Search-time note lifecycle: "redirect, do not hide"
 * (docs/design/note-lifecycle.md section 6).
 *
 * A superseded note that matches a query is replaced, in the result list, by
 * the head of its supersession chain, and the response says so. Expired notes
 * are dropped unless the caller opts in. The decision logic is pure
 * (`applyLifecycleRedirect`) so it can be tested without a database or an
 * embedding server; `redirectNoteRows` is the thin I/O wrapper search_context
 * uses to feed it.
 *
 * Lifecycle state is read from `notes` at query time and never from
 * `embeddings.metadata` (the sync path cannot refresh a copy there).
 */

export interface RedirectOptions {
  /** true = leave superseded notes as themselves (flagged and noticed). */
  includeSuperseded: boolean;
  /** true = keep expired notes (flagged and noticed). */
  includeExpired: boolean;
  /**
   * Rows for chain heads that are not among the input rows, keyed by note id
   * (e.g. the head's own embeddings row). A head absent from both the input
   * rows and this map is built from its lifecycle `text_preview`.
   */
  headRows?: ReadonlyMap<string, SearchResultRow>;
}

export type LifecycleNoticeKind =
  /** A superseded candidate was replaced by its chain head (subject = the head shown). */
  | "redirect"
  /** include_superseded: a superseded note is returned as itself (subject = that note). */
  | "superseded_returned"
  /** include_expired: an expired note is returned (subject = that note). */
  | "expired_returned"
  /** A superseded candidate was dropped because its chain head is expired (subject = null). */
  | "expired_head"
  /** A superseded candidate could not be followed to a shown head and is returned as itself (subject = that note). */
  | "unresolved";

/**
 * One lifecycle notice with enough structure for a caller that truncates the
 * result list afterwards to keep only the notices that are still true.
 */
export interface LifecycleNotice {
  text: string;
  kind: LifecycleNoticeKind;
  /**
   * Id of the note, among the returned rows, this notice describes; null when
   * the notice is about a candidate that was dropped (nothing shown).
   */
  subject: string | null;
  /** Index, in the INPUT rows, of the candidate that triggered the notice. */
  position: number;
}

export interface RedirectResult {
  rows: SearchResultRow[];
  notices: LifecycleNotice[];
  /** Candidates replaced by a different note (the chain head). */
  redirected: number;
}

// ── SQL fragments ────────────────────────────────────────────────────

/**
 * The lifecycle filter for search_context's embeddings queries, or "" when
 * notes are not in scope. A hashed `IN (subquery)`, never a join (design
 * section 6.3). Superseded notes stay candidates - they are redirected
 * afterwards - even when their own valid_until has passed (supersession wins
 * over expiry); only COMPUTED-expired notes (unless `includeExpired`) and
 * orphaned embeddings (no `notes` row) drop.
 */
export function noteLifecycleFilterSql(opts: {
  notesInScope: boolean;
  includeExpired: boolean;
}): string {
  if (!opts.notesInScope) return "";
  const predicate = searchCandidatePredicateSql("notes", { includeExpired: opts.includeExpired });
  return `AND (content_type <> 'note' OR content_id IN (SELECT id::text FROM notes WHERE ${predicate}))`;
}

/** Are notes searchable under this `content_types` filter? (omitted/empty = all types) */
export function notesInScope(contentTypes?: readonly string[] | null): boolean {
  return !contentTypes?.length || contentTypes.includes("note");
}

/**
 * Is this the Postgres error for a missing lifecycle column or table - i.e.
 * migration 013 has not been applied? 42703 = undefined_column,
 * 42P01 = undefined_table. Used to degrade search to un-filtered rather than
 * failing every default search on a database that has not migrated.
 */
export function isMissingLifecycleSchemaError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === "42703" || code === "42P01";
}

// ── Notices ──────────────────────────────────────────────────────────

const MAX_TITLE_IN_NOTICE = 80;

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

function clip(title: string): string {
  return title.length > MAX_TITLE_IN_NOTICE ? `${title.slice(0, MAX_TITLE_IN_NOTICE - 1)}…` : title;
}

/** "<id8>… ('<title>')" — how a note is referred to inside a notice. */
function ref(id: string, title: string): string {
  return `${shortId(id)} ('${clip(title)}')`;
}

function label(id: string, title: string): string {
  return `Note ${ref(id, title)}`;
}

/** " on YYYY-MM-DD" from an ISO timestamp, or "" when there is none. */
function onDate(iso: string | null): string {
  return iso ? ` on ${iso.slice(0, 10)}` : "";
}

/** A redirect happened: the old note matched, the head is shown. */
export function redirectNotice(old: NoteLifecycleRow, head: NoteLifecycleRow): string {
  const chain = old.superseded_by !== null && old.superseded_by !== head.id;
  const by = chain ? "superseded (through a chain of replacements) by" : "superseded by";
  return `${label(old.id, old.title)} matched but was ${by} ${ref(head.id, head.title)}${onDate(
    old.superseded_at
  )} — showing the successor.`;
}

/** The old note matched but its chain ends in an expired note that is not being shown. */
function expiredHeadNotice(old: NoteLifecycleRow, head: NoteLifecycleRow): string {
  return `${label(old.id, old.title)} matched but was superseded by ${ref(
    head.id,
    head.title
  )}, which expired${onDate(head.valid_until)}; there is no current version to show. Pass include_expired to see it.`;
}

/** include_superseded: a superseded note is returned as itself. */
export function supersededReturnedNotice(info: NoteLifecycleRow): string {
  const succ = info.superseded_by
    ? ` ${ref(info.superseded_by, info.successor_title ?? "title unavailable")}`
    : " a newer note";
  return `${label(info.id, info.title)} is superseded by${succ}${onDate(info.superseded_at)}; cite the successor.`;
}

/** The superseded note is returned as itself because its current successor cannot be shown. */
function unresolvedNotice(info: NoteLifecycleRow): string {
  const succ = info.superseded_by
    ? ` ${ref(info.superseded_by, info.successor_title ?? "title unavailable")}`
    : " a newer note";
  return `${label(info.id, info.title)} is superseded by${succ}${onDate(
    info.superseded_at
  )}, but the current version could not be shown here (not found, or outside the filters applied); treat this note as outdated.`;
}

/** include_expired: an expired note is returned. */
export function expiredReturnedNotice(info: NoteLifecycleRow): string {
  return `${label(info.id, info.title)} expired${onDate(info.valid_until)}.`;
}

/**
 * The `next_step` sentence(s) that match the notices actually being reported,
 * or "" when there are none. "Cite the successor shown" is only said when a
 * successor really is shown; expired-only notices get a different warning.
 */
export function lifecycleNextStep(notices: readonly LifecycleNotice[]): string {
  const kinds = new Set(notices.map((n) => n.kind));
  const parts: string[] = [];
  if (kinds.has("redirect")) {
    parts.push(
      "Lifecycle notices present (see lifecycle_notices): cite the successor notes shown, not the superseded notes they replace."
    );
  }
  if (kinds.has("superseded_returned") || kinds.has("unresolved")) {
    parts.push(
      "Superseded notes in these results are flagged (see lifecycle_notices): cite the successor of each, not the superseded note."
    );
  }
  if (kinds.has("expired_returned") || kinds.has("expired_head")) {
    parts.push("Expired notes were omitted or are flagged (see lifecycle_notices) - do not treat them as current.");
  }
  return parts.join(" ");
}

/**
 * Keep only the notices that are still true after a caller truncated the
 * result list: a notice about a shown note survives only if that note is among
 * `shownNoteIds`; a notice about a dropped candidate survives only if the
 * candidate sat within the first `limit` input positions (it could have made
 * the page).
 */
export function keepShownNotices(
  notices: readonly LifecycleNotice[],
  shownNoteIds: ReadonlySet<string>,
  limit: number
): LifecycleNotice[] {
  return notices.filter((n) => (n.subject !== null ? shownNoteIds.has(n.subject) : n.position < limit));
}

// ── Adapters ─────────────────────────────────────────────────────────

/**
 * Lifecycle facts from a `notes` row that already carries its computed status
 * (`effective_status`, evaluated by Postgres) and, optionally, the direct
 * successor's title from a self-join. search_notes uses this so its FTS query
 * doubles as the lifecycle fetch.
 */
export function lifecycleFromNoteRow(row: {
  id: string;
  title: string;
  content: string;
  scope: NoteScope;
  created_at: Date | string;
  effective_status: EffectiveNoteStatus;
  superseded_by: string | null;
  superseded_at: Date | string | null;
  valid_until: Date | string | null;
  provenance: Provenance | null;
  version: number;
  successor_title?: string | null;
}): NoteLifecycleRow {
  const iso = (v: Date | string | null): string | null =>
    v === null ? null : v instanceof Date ? v.toISOString() : String(v);
  return {
    id: row.id,
    title: row.title,
    status: row.effective_status,
    superseded_by: row.superseded_by,
    superseded_at: iso(row.superseded_at),
    valid_until: iso(row.valid_until),
    provenance: row.provenance,
    version: row.version,
    successor_title: row.successor_title ?? null,
    scope: row.scope,
    created_at: iso(row.created_at) ?? "",
    text_preview: `${row.title}\n${row.content}`.slice(0, 500),
  };
}

// ── Pure redirect / merge ────────────────────────────────────────────

// Number(): raw SQL rows can carry numeric/bigint columns as strings.
const scoreOf = (row: SearchResultRow): number => Number(row.rrf_score ?? row.similarity ?? 0);

function scoringOf(row: SearchResultRow): Partial<SearchResultRow> {
  return {
    similarity: row.similarity,
    rrf_score: row.rrf_score,
    semantic_rank: row.semantic_rank,
    fulltext_rank: row.fulltext_rank,
    graph_rank: row.graph_rank,
    graph_score: row.graph_score,
    graph_path: row.graph_path,
  };
}

function annotation(info: NoteLifecycleRow): Partial<SearchResultRow> {
  return {
    note_status: info.status,
    superseded_by: info.superseded_by,
    superseded_at: info.superseded_at,
    valid_until: info.valid_until,
    successor_title: info.status === "superseded" ? info.successor_title : null,
  };
}

function unionOf(a: readonly string[] | undefined, b: readonly string[]): string[] {
  return [...new Set([...(a ?? []), ...b])];
}

/** Build a row for a note that has no embeddings row (e.g. inserted by sync, not yet embedded). */
function synthesiseRow(info: NoteLifecycleRow): SearchResultRow {
  return {
    content_type: "note",
    content_id: info.id,
    content_text: info.text_preview,
    metadata: { note_id: info.id, scope: info.scope, created_at: info.created_at },
    similarity: 0,
  };
}

/**
 * Apply the lifecycle rules to a candidate list.
 *
 * - Non-note rows pass through untouched and keep their position.
 * - A note with no lifecycle entry no longer exists (deleted between the
 *   candidate query and this one) and is dropped.
 * - An expired note is dropped unless `includeExpired` (the SQL filter already
 *   removed most; this is the defensive second line, and the notice source
 *   for the opt-in case).
 * - A superseded note is, unless `includeSuperseded`, replaced by the head of
 *   its chain (`headById`). The head takes the candidate's score and position
 *   and records the candidate id in `matched_via`. If the head was also a
 *   candidate the two merge - the better score wins and `matched_via`
 *   accumulates - so a chain never yields two rows. A head that is expired
 *   (and not opted in) drops the candidate with a notice; a head that is
 *   itself still superseded (chain deeper than the walk cap), missing, or
 *   absent from `lifecycleById` (e.g. outside the caller's filters) leaves the
 *   candidate as itself, flagged, rather than hiding knowledge.
 * - A redirected head that did not itself match carries `rerank_text`: the
 *   content_text of the best-scoring candidate that was redirected to it, so a
 *   cross-encoder scores the wording that actually matched. A head that also
 *   matched directly keeps its own text (no `rerank_text`).
 *
 * Every notice is structured (kind / subject / position) so a caller that
 * truncates the rows afterwards can keep only the notices still true.
 *
 * `lifecycleById` must contain every candidate note AND every head. Pure: no
 * I/O, no clock - `status` was computed by the database.
 */
export function applyLifecycleRedirect(
  rows: SearchResultRow[],
  lifecycleById: ReadonlyMap<string, NoteLifecycleRow>,
  headById: ReadonlyMap<string, string>,
  opts: RedirectOptions
): RedirectResult {
  const notices: LifecycleNotice[] = [];
  const out: SearchResultRow[] = [];
  const indexByNoteId = new Map<string, number>();
  const expiredNoticed = new Set<string>();
  let redirected = 0;

  const directById = new Map<string, SearchResultRow>();
  for (const r of rows) {
    if (r.content_type === "note" && !directById.has(r.content_id)) directById.set(r.content_id, r);
  }

  /**
   * Add or merge one note into `out`. `identity` supplies the text; `scoring`
   * the ranks. `redirectedFrom` is set when the note is shown in place of a
   * superseded candidate.
   */
  const place = (
    noteId: string,
    identity: SearchResultRow,
    scoring: SearchResultRow,
    via: readonly string[],
    redirectedFrom?: SearchResultRow
  ): void => {
    const info = lifecycleById.get(noteId);
    if (!info) return;
    // A head that also matched directly is reranked on its own text.
    const carryText = redirectedFrom !== undefined && !directById.has(noteId);
    const at = indexByNoteId.get(noteId);
    if (at === undefined) {
      indexByNoteId.set(noteId, out.length);
      out.push({
        ...identity,
        ...scoringOf(scoring),
        ...annotation(info),
        matched_via: unionOf(undefined, via),
        ...(carryText ? { rerank_text: redirectedFrom.content_text } : {}),
      });
      return;
    }
    const existing = out[at];
    const scoringWins = scoreOf(scoring) > scoreOf(existing);
    const better = scoringWins ? scoring : existing;
    out[at] = {
      ...existing,
      ...scoringOf(better),
      matched_via: unionOf(existing.matched_via, via),
      ...(carryText && (scoringWins || existing.rerank_text === undefined)
        ? { rerank_text: redirectedFrom.content_text }
        : {}),
    };
  };

  const noticeExpiredReturned = (info: NoteLifecycleRow, position: number): void => {
    if (info.status !== "expired" || expiredNoticed.has(info.id)) return;
    expiredNoticed.add(info.id);
    notices.push({ text: expiredReturnedNotice(info), kind: "expired_returned", subject: info.id, position });
  };

  rows.forEach((row, position) => {
    if (row.content_type !== "note") {
      out.push(row);
      return;
    }
    const info = lifecycleById.get(row.content_id);
    if (!info) return;

    if (info.status === "expired") {
      if (!opts.includeExpired) return;
      place(info.id, row, row, []);
      noticeExpiredReturned(info, position);
      return;
    }

    if (info.status === "active") {
      place(info.id, row, row, []);
      return;
    }

    // Superseded.
    if (opts.includeSuperseded) {
      place(info.id, row, row, []);
      notices.push({ text: supersededReturnedNotice(info), kind: "superseded_returned", subject: info.id, position });
      return;
    }
    const headId = headById.get(info.id);
    const head = headId ? lifecycleById.get(headId) : undefined;
    if (!headId || !head || head.status === "superseded") {
      // Unresolvable chain (should not happen under the NO ACTION FK) or a
      // head the caller could not show: show the superseded note itself,
      // flagged, rather than lose the knowledge.
      place(info.id, row, row, []);
      notices.push({ text: unresolvedNotice(info), kind: "unresolved", subject: info.id, position });
      return;
    }
    if (head.status === "expired" && !opts.includeExpired) {
      notices.push({ text: expiredHeadNotice(info, head), kind: "expired_head", subject: null, position });
      return;
    }
    const identity = directById.get(headId) ?? opts.headRows?.get(headId) ?? synthesiseRow(head);
    place(headId, identity, row, [info.id], row);
    redirected++;
    notices.push({ text: redirectNotice(info, head), kind: "redirect", subject: headId, position });
    noticeExpiredReturned(head, position);
  });

  return { rows: out, notices, redirected };
}

// ── I/O wrapper for search_context ───────────────────────────────────

/**
 * Fetch lifecycle for every note candidate, walk superseded chains to their
 * heads, load rows for heads that are not already candidates (preferring the
 * head's own embeddings row), and apply the redirect. Typical cost: one
 * query when no candidate is superseded; up to four when redirects occur.
 */
export async function redirectNoteRows(
  exec: { query: PoolClient["query"] },
  rows: SearchResultRow[],
  opts: Pick<RedirectOptions, "includeSuperseded" | "includeExpired">
): Promise<RedirectResult> {
  const noteIds = [...new Set(rows.filter((r) => r.content_type === "note").map((r) => r.content_id))];
  if (noteIds.length === 0) return { rows, notices: [], redirected: 0 };

  const lifecycle = await fetchNoteLifecycle(exec, noteIds);
  const heads = new Map<string, string>();
  const headRows = new Map<string, SearchResultRow>();

  if (!opts.includeSuperseded) {
    const supersededIds = [...lifecycle.values()].filter((n) => n.status === "superseded").map((n) => n.id);
    if (supersededIds.length > 0) {
      for (const [from, to] of await resolveChainHeads(exec, supersededIds)) heads.set(from, to);

      const unknown = [...new Set(heads.values())].filter((id) => !lifecycle.has(id));
      if (unknown.length > 0) {
        for (const [id, info] of await fetchNoteLifecycle(exec, unknown)) lifecycle.set(id, info);
      }

      // Heads that will actually be shown but are not already candidates.
      const present = new Set(noteIds);
      const needRows = [...new Set(heads.values())].filter((id) => {
        if (present.has(id)) return false;
        const info = lifecycle.get(id);
        return info !== undefined && (info.status === "active" || (info.status === "expired" && opts.includeExpired));
      });
      if (needRows.length > 0) {
        const emb = await exec.query<{
          content_type: string;
          content_id: string;
          content_text: string;
          metadata: Record<string, unknown>;
        }>(
          `SELECT content_type, content_id, LEFT(content_text, 500) AS content_text, metadata
             FROM embeddings
            WHERE content_type = 'note' AND content_id = ANY($1::text[])`,
          [needRows]
        );
        for (const e of emb.rows) {
          headRows.set(e.content_id, {
            content_type: e.content_type,
            content_id: e.content_id,
            content_text: e.content_text,
            metadata: e.metadata ?? {},
            similarity: 0,
          });
        }
      }
    }
  }

  return applyLifecycleRedirect(rows, lifecycle, heads, { ...opts, headRows });
}
