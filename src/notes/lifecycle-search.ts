import type { PoolClient } from "pg";
import {
  fetchNoteLifecycle,
  lifecyclePredicateSql,
  resolveChainHeads,
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

/** Appended to `next_step` whenever a response carries lifecycle notices. */
export const LIFECYCLE_NEXT_STEP =
  "Lifecycle notices present (see lifecycle_notices): cite the successor notes shown, not the superseded notes they replace.";

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

export interface RedirectResult {
  rows: SearchResultRow[];
  notices: string[];
  /** Candidates replaced by a different note (the chain head). */
  redirected: number;
}

// ── SQL fragments ────────────────────────────────────────────────────

/**
 * The lifecycle filter for search_context's embeddings queries, or "" when
 * notes are not in scope. A hashed `IN (subquery)`, never a join, so the
 * planner keeps the HNSW index-ordered scan (design section 6.3). Superseded
 * notes stay candidates — they are redirected afterwards; only expired notes
 * (unless `includeExpired`) and orphaned embeddings (no `notes` row) drop.
 */
export function noteLifecycleFilterSql(opts: {
  notesInScope: boolean;
  includeExpired: boolean;
}): string {
  if (!opts.notesInScope) return "";
  const predicate = lifecyclePredicateSql("notes", {
    excludeSuperseded: false,
    excludeExpired: !opts.includeExpired,
  });
  return `AND (content_type <> 'note' OR content_id IN (SELECT id::text FROM notes WHERE ${predicate}))`;
}

/** Are notes searchable under this `content_types` filter? (omitted/empty = all types) */
export function notesInScope(contentTypes?: readonly string[] | null): boolean {
  return !contentTypes?.length || contentTypes.includes("note");
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

/** include_expired: an expired note is returned. */
export function expiredReturnedNotice(info: NoteLifecycleRow): string {
  return `${label(info.id, info.title)} expired${onDate(info.valid_until)}.`;
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
 *   candidate the two merge — the better score wins and `matched_via`
 *   accumulates — so a chain never yields two rows. A head that is expired
 *   (and not opted in) drops the candidate with a notice; a head that is
 *   itself still superseded (chain deeper than the walk cap) or missing leaves
 *   the candidate as itself, flagged, rather than hiding knowledge.
 *
 * `lifecycleById` must contain every candidate note AND every head. Pure: no
 * I/O, no clock — `status` was computed by the database.
 */
export function applyLifecycleRedirect(
  rows: SearchResultRow[],
  lifecycleById: ReadonlyMap<string, NoteLifecycleRow>,
  headById: ReadonlyMap<string, string>,
  opts: RedirectOptions
): RedirectResult {
  const notices: string[] = [];
  const out: SearchResultRow[] = [];
  const indexByNoteId = new Map<string, number>();
  const expiredNoticed = new Set<string>();
  let redirected = 0;

  const directById = new Map<string, SearchResultRow>();
  for (const r of rows) {
    if (r.content_type === "note" && !directById.has(r.content_id)) directById.set(r.content_id, r);
  }

  /** Add or merge one note into `out`. `identity` supplies the text; `scoring` the ranks. */
  const place = (
    noteId: string,
    identity: SearchResultRow,
    scoring: SearchResultRow,
    via: readonly string[]
  ): void => {
    const info = lifecycleById.get(noteId);
    if (!info) return;
    const at = indexByNoteId.get(noteId);
    if (at === undefined) {
      indexByNoteId.set(noteId, out.length);
      out.push({
        ...identity,
        ...scoringOf(scoring),
        ...annotation(info),
        matched_via: unionOf(undefined, via),
      });
      return;
    }
    const existing = out[at];
    const better = scoreOf(scoring) > scoreOf(existing) ? scoring : existing;
    out[at] = {
      ...existing,
      ...scoringOf(better),
      matched_via: unionOf(existing.matched_via, via),
    };
  };

  const noticeExpiredReturned = (info: NoteLifecycleRow): void => {
    if (info.status !== "expired" || expiredNoticed.has(info.id)) return;
    expiredNoticed.add(info.id);
    notices.push(expiredReturnedNotice(info));
  };

  for (const row of rows) {
    if (row.content_type !== "note") {
      out.push(row);
      continue;
    }
    const info = lifecycleById.get(row.content_id);
    if (!info) continue;

    if (info.status === "expired") {
      if (!opts.includeExpired) continue;
      place(info.id, row, row, []);
      noticeExpiredReturned(info);
      continue;
    }

    if (info.status === "active") {
      place(info.id, row, row, []);
      continue;
    }

    // Superseded.
    const keepAsItself = (): void => {
      place(info.id, row, row, []);
      notices.push(supersededReturnedNotice(info));
    };
    if (opts.includeSuperseded) {
      keepAsItself();
      continue;
    }
    const headId = headById.get(info.id);
    const head = headId ? lifecycleById.get(headId) : undefined;
    if (!headId || !head || head.status === "superseded") {
      // Unresolvable chain (should not happen under the NO ACTION FK): show
      // the superseded note itself, flagged, rather than lose the knowledge.
      keepAsItself();
      continue;
    }
    if (head.status === "expired" && !opts.includeExpired) {
      notices.push(expiredHeadNotice(info, head));
      continue;
    }
    const identity = directById.get(headId) ?? opts.headRows?.get(headId) ?? synthesiseRow(head);
    place(headId, identity, row, [info.id]);
    redirected++;
    notices.push(redirectNotice(info, head));
    noticeExpiredReturned(head);
  }

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
