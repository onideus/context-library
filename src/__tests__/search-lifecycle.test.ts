import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  applyLifecycleRedirect,
  isMissingLifecycleSchemaError,
  keepShownNotices,
  lifecycleNextStep,
  redirectNoteRows,
  type LifecycleNotice,
  type RedirectOptions,
  type RedirectResult,
} from "../notes/lifecycle-search.js";
import { searchCandidatePredicateSql, type NoteLifecycleRow } from "../notes/store.js";
import {
  buildGraphOnlyFetchSql,
  buildSearchContextSql,
  fuseRrf,
  type SearchContextSqlInput,
  type SearchResultRow,
} from "../tools/search.js";

/**
 * Search-time note lifecycle ("redirect, do not hide", design section 6):
 *
 *   1. applyLifecycleRedirect / helpers  - pure redirect, merge, notice logic
 *   2. buildSearchContextSql             - pure SQL assembly (placeholders, filter placement)
 *   3. search_notes via the server       - Postgres-gated
 *   4. search_context SQL + redirect     - Postgres-gated, embeddings rows inserted
 *                                          directly with fixed vectors
 *   5. search_context THROUGH THE TOOL   - Postgres-gated, against an in-test HTTP
 *                                          stub standing in for the embedding and
 *                                          reranker servers
 *   6. SQL shape guard                   - the lifecycle filter is a hashed subquery
 *                                          on the embeddings scan
 *
 * Postgres-gated suites skip when Postgres is unavailable. All content is
 * fictional.
 */

const TEST_PORT = 3198;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_DATA_DIR = join(process.cwd(), "data", "test-search-lifecycle");

const PG_DATABASE = "cl_test_search_lifecycle";
const PG_USER = process.env.PGUSER ?? "cl";
const PG_PASSWORD = process.env.PGPASSWORD ?? "test";
const PG_HOST = process.env.PGHOST ?? "localhost";
const PG_PORT = process.env.PGPORT ?? "5432";

let serverProcess: ChildProcess;

async function waitForServer(url: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

async function parseSseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) throw new Error(`No data line in SSE response. Body:\n${text}`);
  return JSON.parse(dataLine.slice(5).trim());
}

function jsonrpc(method: string, params?: Record<string, unknown>, id = 1) {
  return { jsonrpc: "2.0", method, ...(params ? { params } : {}), id };
}

async function mcpPost(body: unknown) {
  return fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
    },
    body: JSON.stringify(body),
  });
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const res = await mcpPost(jsonrpc("tools/call", { name, arguments: args }));
  expect(res.status).toBe(200);
  const data = (await parseSseResponse(res)) as any;
  return JSON.parse(data.result.content[0].text);
}

async function checkPostgres(): Promise<boolean> {
  try {
    const pg = await import("pg");

    // Ensure the test database exists - connect to default 'postgres' first.
    const admin = new pg.default.Client({
      host: PG_HOST,
      port: parseInt(PG_PORT),
      user: PG_USER,
      password: PG_PASSWORD,
      database: "postgres",
    });
    await admin.connect();
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [PG_DATABASE]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${PG_DATABASE}`);
    }
    await admin.end();

    const client = new pg.default.Client({
      host: PG_HOST,
      port: parseInt(PG_PORT),
      user: PG_USER,
      password: PG_PASSWORD,
      database: PG_DATABASE,
    });
    await client.connect();

    // Clean slate for test isolation. Drop the whole schema rather than
    // individual tables: dropping _migrations makes the server re-apply all
    // migrations, and any table left over from a previous run would abort
    // the migration runner with "already exists".
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");

    await client.end();
    return true;
  } catch {
    return false;
  }
}

const pgAvailable = await checkPostgres();

if (!pgAvailable) {
  console.log("\n" + "=".repeat(60));
  console.log("  NOTICE: PostgreSQL not available");
  console.log("  Search Lifecycle gated suites will be SKIPPED");
  console.log("=".repeat(60) + "\n");
}

// ─────────────────────────────────────────────────────────────────
// Fixtures for the pure suites
// ─────────────────────────────────────────────────────────────────

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function info(id: string, over: Partial<NoteLifecycleRow> = {}): NoteLifecycleRow {
  return {
    id,
    title: `Title ${id.slice(0, 4)}`,
    status: "active",
    superseded_by: null,
    superseded_at: null,
    valid_until: null,
    provenance: "stated",
    version: 1,
    successor_title: null,
    scope: "work",
    created_at: "2026-03-01T00:00:00.000Z",
    text_preview: `preview of ${id.slice(0, 4)}`,
    ...over,
  };
}

function noteRow(id: string, score: number, text = `text of ${id.slice(0, 4)}`): SearchResultRow {
  return {
    content_type: "note",
    content_id: id,
    content_text: text,
    metadata: { note_id: id, scope: "work", created_at: "2026-03-01T00:00:00.000Z" },
    similarity: 0.5,
    rrf_score: score,
    semantic_rank: 1,
    fulltext_rank: null,
  };
}

function otherRow(type: string, id: string, score: number): SearchResultRow {
  return {
    content_type: type,
    content_id: id,
    content_text: `text of ${id}`,
    metadata: type === "handoff" ? { source_file: id.split("#")[0] } : {},
    similarity: 0.5,
    rrf_score: score,
  };
}

const KEEP: RedirectOptions = { includeSuperseded: false, includeExpired: false };

const texts = (r: Pick<RedirectResult, "notices">): string[] => r.notices.map((n) => n.text);

/** A superseded by B (single hop), both known. */
function singleHop(over: { aTitle?: string; bTitle?: string } = {}) {
  const aTitle = over.aTitle ?? "Acme Corp Friday deploys";
  const bTitle = over.bTitle ?? "Acme Corp deploy freeze";
  const lifecycle = new Map<string, NoteLifecycleRow>([
    [
      A,
      info(A, {
        title: aTitle,
        status: "superseded",
        superseded_by: B,
        superseded_at: "2026-05-02T09:30:00.000Z",
        successor_title: bTitle,
      }),
    ],
    [B, info(B, { title: bTitle })],
  ]);
  return { lifecycle, heads: new Map([[A, B]]) };
}

// ─────────────────────────────────────────────────────────────────
// 1. applyLifecycleRedirect and helpers (pure)
// ─────────────────────────────────────────────────────────────────

describe("applyLifecycleRedirect", () => {
  it("replaces a superseded candidate with its head, keeping the candidate's score and recording matched_via", () => {
    const { lifecycle, heads } = singleHop();
    const headRows = new Map([[B, noteRow(B, 0, "successor text")]]);

    const out = applyLifecycleRedirect([noteRow(A, 0.05, "stale text")], lifecycle, heads, { ...KEEP, headRows });

    expect(out.rows).toHaveLength(1);
    const r = out.rows[0];
    expect(r.content_id).toBe(B);
    expect(r.content_text).toBe("successor text");
    expect(r.rrf_score).toBe(0.05);
    expect(r.matched_via).toEqual([A]);
    expect(r.note_status).toBe("active");
    expect(r.successor_title).toBeNull();
    expect(out.redirected).toBe(1);
    expect(out.notices).toHaveLength(1);
  });

  it("emits the documented notice wording for a redirect, as a structured notice", () => {
    const { lifecycle, heads } = singleHop();
    const out = applyLifecycleRedirect([noteRow(A, 0.05)], lifecycle, heads, KEEP);
    expect(out.notices).toEqual([
      {
        text: "Note aaaaaaaa… ('Acme Corp Friday deploys') matched but was superseded by bbbbbbbb… ('Acme Corp deploy freeze') on 2026-05-02 — showing the successor.",
        kind: "redirect",
        subject: B,
        position: 0,
      },
    ]);
  });

  it("keeps the redirected row at the candidate's position and leaves other content types alone; notice position is the input index", () => {
    const { lifecycle, heads } = singleHop();
    const handoff = otherRow("handoff", "2026-03-01T00-00-00-000Z-aaaa1111.json#chunk_0", 0.06);
    const task = otherRow("task", "task-1", 0.04);

    const out = applyLifecycleRedirect([handoff, noteRow(A, 0.05), task], lifecycle, heads, KEEP);

    expect(out.rows.map((r) => r.content_id)).toEqual([handoff.content_id, B, "task-1"]);
    expect(out.rows[0]).toBe(handoff);
    expect(out.rows[2]).toBe(task);
    expect(out.notices[0].position).toBe(1);
  });

  it("builds the head row from lifecycle text_preview when no head row is supplied", () => {
    const { lifecycle, heads } = singleHop();
    const out = applyLifecycleRedirect([noteRow(A, 0.05)], lifecycle, heads, KEEP);
    expect(out.rows[0].content_text).toBe(`preview of ${B.slice(0, 4)}`);
    expect(out.rows[0].metadata).toMatchObject({ note_id: B, scope: "work" });
  });

  it("merges when the head was also matched directly: one row, best score, matched_via accumulated", () => {
    const { lifecycle, heads } = singleHop();

    // head first, lower score than the redirected candidate
    const a = applyLifecycleRedirect([noteRow(B, 0.02, "head text"), noteRow(A, 0.05)], lifecycle, heads, KEEP);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]).toMatchObject({ content_id: B, content_text: "head text", rrf_score: 0.05, matched_via: [A] });

    // candidate first, head directly matched with a higher score
    const b = applyLifecycleRedirect([noteRow(A, 0.02), noteRow(B, 0.05, "head text")], lifecycle, heads, KEEP);
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0]).toMatchObject({ content_id: B, content_text: "head text", rrf_score: 0.05, matched_via: [A] });

    // a direct match still counts as a redirect for the superseded candidate
    expect(a.redirected).toBe(1);
    expect(b.redirected).toBe(1);
  });

  it("collapses a whole chain into one row listing every superseded note that matched", () => {
    const lifecycle = new Map<string, NoteLifecycleRow>([
      [A, info(A, { status: "superseded", superseded_by: B, superseded_at: "2026-04-01T00:00:00.000Z", successor_title: "Mid" })],
      [B, info(B, { title: "Mid", status: "superseded", superseded_by: C, superseded_at: "2026-05-01T00:00:00.000Z", successor_title: "Head" })],
      [C, info(C, { title: "Head" })],
    ]);
    const heads = new Map([
      [A, C],
      [B, C],
    ]);

    const out = applyLifecycleRedirect([noteRow(A, 0.05), noteRow(B, 0.04)], lifecycle, heads, KEEP);

    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ content_id: C, rrf_score: 0.05, matched_via: [A, B] });
    expect(out.redirected).toBe(2);
    expect(out.notices).toHaveLength(2);
    // A is two hops from the head, so the notice says so rather than claiming a direct replacement.
    expect(texts(out)[0]).toContain("through a chain of replacements");
    expect(texts(out)[1]).not.toContain("through a chain of replacements");
    expect(out.notices.map((n) => n.position)).toEqual([0, 1]);
  });

  it("drops the candidate when the head is expired and include_expired is off, with a subject-less notice", () => {
    const { lifecycle, heads } = singleHop();
    lifecycle.set(B, info(B, { title: "Acme Corp deploy freeze", status: "expired", valid_until: "2026-06-30T00:00:00.000Z" }));

    const out = applyLifecycleRedirect([noteRow(A, 0.05)], lifecycle, heads, KEEP);

    expect(out.rows).toHaveLength(0);
    expect(out.redirected).toBe(0);
    expect(out.notices).toHaveLength(1);
    expect(out.notices[0]).toMatchObject({ kind: "expired_head", subject: null, position: 0 });
    expect(out.notices[0].text).toContain("expired on 2026-06-30");
    expect(out.notices[0].text).toContain("include_expired");
  });

  it("shows an expired head when include_expired is on, flagged and noticed", () => {
    const { lifecycle, heads } = singleHop();
    lifecycle.set(B, info(B, { title: "Acme Corp deploy freeze", status: "expired", valid_until: "2026-06-30T00:00:00.000Z" }));

    const out = applyLifecycleRedirect([noteRow(A, 0.05)], lifecycle, heads, { ...KEEP, includeExpired: true });

    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ content_id: B, note_status: "expired", matched_via: [A] });
    expect(out.notices.map((n) => n.kind)).toEqual(["redirect", "expired_returned"]);
    expect(out.notices[1].subject).toBe(B);
    expect(texts(out)[1]).toMatch(/^Note bbbbbbbb… \('Acme Corp deploy freeze'\) expired on 2026-06-30\.$/);
  });

  it("include_superseded leaves a superseded row as itself, with successor info and a notice", () => {
    const { lifecycle, heads } = singleHop();

    const out = applyLifecycleRedirect([noteRow(A, 0.05, "stale text")], lifecycle, heads, {
      ...KEEP,
      includeSuperseded: true,
    });

    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({
      content_id: A,
      content_text: "stale text",
      rrf_score: 0.05,
      note_status: "superseded",
      superseded_by: B,
      superseded_at: "2026-05-02T09:30:00.000Z",
      successor_title: "Acme Corp deploy freeze",
      matched_via: [],
    });
    expect(out.redirected).toBe(0);
    expect(out.notices).toEqual([
      {
        text: "Note aaaaaaaa… ('Acme Corp Friday deploys') is superseded by bbbbbbbb… ('Acme Corp deploy freeze') on 2026-05-02; cite the successor.",
        kind: "superseded_returned",
        subject: A,
        position: 0,
      },
    ]);
  });

  it("drops an expired candidate unless include_expired, and notices it when kept", () => {
    const lifecycle = new Map([[D, info(D, { title: "Holiday freeze", status: "expired", valid_until: "2026-03-31T23:00:00.000Z" })]]);

    const hidden = applyLifecycleRedirect([noteRow(D, 0.05)], lifecycle, new Map(), KEEP);
    expect(hidden.rows).toHaveLength(0);
    expect(hidden.notices).toEqual([]);

    const shown = applyLifecycleRedirect([noteRow(D, 0.05)], lifecycle, new Map(), { ...KEEP, includeExpired: true });
    expect(shown.rows).toHaveLength(1);
    expect(shown.rows[0]).toMatchObject({ note_status: "expired", valid_until: "2026-03-31T23:00:00.000Z", matched_via: [] });
    expect(shown.notices).toEqual([
      { text: "Note dddddddd… ('Holiday freeze') expired on 2026-03-31.", kind: "expired_returned", subject: D, position: 0 },
    ]);
  });

  it("annotates direct active matches with an empty matched_via and no notices", () => {
    const lifecycle = new Map([[B, info(B)]]);
    const out = applyLifecycleRedirect([noteRow(B, 0.05)], lifecycle, new Map(), KEEP);
    expect(out.rows[0]).toMatchObject({
      content_id: B,
      note_status: "active",
      superseded_by: null,
      successor_title: null,
      matched_via: [],
    });
    expect(out.rows[0].rerank_text).toBeUndefined();
    expect(out.notices).toEqual([]);
    expect(out.redirected).toBe(0);
  });

  it("drops a note row that no longer exists, and shows a superseded note flagged when its chain cannot be resolved", () => {
    const lifecycle = new Map<string, NoteLifecycleRow>([
      [A, info(A, { title: "Orphaned chain", status: "superseded", superseded_by: B, superseded_at: "2026-05-02T00:00:00.000Z", successor_title: null })],
    ]);

    const out = applyLifecycleRedirect([noteRow(C, 0.06), noteRow(A, 0.05)], lifecycle, new Map(), KEEP);

    // C has no lifecycle entry (deleted since the candidate query): gone.
    // A cannot reach a head: shown as itself and flagged, never silently lost.
    expect(out.rows.map((r) => r.content_id)).toEqual([A]);
    expect(out.rows[0].note_status).toBe("superseded");
    expect(out.notices).toHaveLength(1);
    expect(out.notices[0]).toMatchObject({ kind: "unresolved", subject: A, position: 1 });
    expect(out.notices[0].text).toContain("treat this note as outdated");
    expect(out.redirected).toBe(0);
  });

  it("treats a head the caller could not load (e.g. outside its filters) as unresolved: the candidate is kept as itself", () => {
    const { lifecycle, heads } = singleHop();
    lifecycle.delete(B); // head is in headById but absent from lifecycleById

    const out = applyLifecycleRedirect([noteRow(A, 0.05)], lifecycle, heads, KEEP);

    expect(out.rows.map((r) => r.content_id)).toEqual([A]);
    expect(out.rows[0]).toMatchObject({ note_status: "superseded", successor_title: "Acme Corp deploy freeze" });
    expect(out.notices[0]).toMatchObject({ kind: "unresolved", subject: A });
    expect(out.notices[0].text).toContain("outside the filters applied");
  });

  it("does not mutate its input rows", () => {
    const { lifecycle, heads } = singleHop();
    const input = [noteRow(A, 0.05)];
    const snapshot = JSON.stringify(input);
    applyLifecycleRedirect(input, lifecycle, heads, KEEP);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("compares scores numerically even when raw SQL rows carry them as strings", () => {
    const { lifecycle, heads } = singleHop();
    const a = noteRow(A, 0.0);
    (a as any).rrf_score = "0.0300";
    const b = noteRow(B, 0.0);
    (b as any).rrf_score = "0.0090";
    const out = applyLifecycleRedirect([b, a], lifecycle, heads, KEEP);
    expect(out.rows).toHaveLength(1);
    expect(Number(out.rows[0].rrf_score)).toBe(0.03);
  });

  describe("rerank_text (a redirected head is reranked on the wording that matched)", () => {
    it("carries the redirected candidate's text on a head that did not itself match", () => {
      const { lifecycle, heads } = singleHop();
      const headRows = new Map([[B, noteRow(B, 0, "successor wording")]]);

      const out = applyLifecycleRedirect([noteRow(A, 0.05, "matched old wording")], lifecycle, heads, { ...KEEP, headRows });

      expect(out.rows[0].content_text).toBe("successor wording");
      expect(out.rows[0].rerank_text).toBe("matched old wording");
    });

    it("uses the best-scoring candidate's text when several candidates redirect to one head", () => {
      const lifecycle = new Map<string, NoteLifecycleRow>([
        [A, info(A, { status: "superseded", superseded_by: C, superseded_at: "2026-04-01T00:00:00.000Z" })],
        [B, info(B, { status: "superseded", superseded_by: C, superseded_at: "2026-04-02T00:00:00.000Z" })],
        [C, info(C)],
      ]);
      const heads = new Map([
        [A, C],
        [B, C],
      ]);

      const lowFirst = applyLifecycleRedirect([noteRow(A, 0.03, "low wording"), noteRow(B, 0.05, "high wording")], lifecycle, heads, KEEP);
      expect(lowFirst.rows[0].rerank_text).toBe("high wording");

      const highFirst = applyLifecycleRedirect([noteRow(B, 0.05, "high wording"), noteRow(A, 0.03, "low wording")], lifecycle, heads, KEEP);
      expect(highFirst.rows[0].rerank_text).toBe("high wording");
    });

    it("keeps the head's own text (no rerank_text) when the head also matched directly, in either order", () => {
      const { lifecycle, heads } = singleHop();

      const headFirst = applyLifecycleRedirect([noteRow(B, 0.02, "head text"), noteRow(A, 0.05, "old text")], lifecycle, heads, KEEP);
      expect(headFirst.rows[0].content_text).toBe("head text");
      expect(headFirst.rows[0].rerank_text).toBeUndefined();

      const candFirst = applyLifecycleRedirect([noteRow(A, 0.05, "old text"), noteRow(B, 0.02, "head text")], lifecycle, heads, KEEP);
      expect(candFirst.rows[0].content_text).toBe("head text");
      expect(candFirst.rows[0].rerank_text).toBeUndefined();
    });

    it("sets no rerank_text under include_superseded", () => {
      const { lifecycle, heads } = singleHop();
      const out = applyLifecycleRedirect([noteRow(A, 0.05)], lifecycle, heads, { ...KEEP, includeSuperseded: true });
      expect(out.rows[0].rerank_text).toBeUndefined();
    });
  });
});

describe("keepShownNotices", () => {
  const n = (kind: LifecycleNotice["kind"], subject: string | null, position: number): LifecycleNotice => ({
    text: `${kind}:${subject}:${position}`,
    kind,
    subject,
    position,
  });

  it("keeps a notice about a note only when that note is among the shown ones", () => {
    const notices = [n("redirect", B, 0), n("redirect", C, 1), n("superseded_returned", A, 2)];
    const kept = keepShownNotices(notices, new Set([B, A]), 5);
    expect(kept.map((x) => x.text)).toEqual(["redirect:" + B + ":0", "superseded_returned:" + A + ":2"]);
  });

  it("keeps a notice about a dropped candidate only if the candidate sat inside the first `limit` positions", () => {
    const notices = [n("expired_head", null, 0), n("expired_head", null, 4), n("expired_head", null, 5)];
    expect(keepShownNotices(notices, new Set(), 5).map((x) => x.position)).toEqual([0, 4]);
    expect(keepShownNotices(notices, new Set(), 1).map((x) => x.position)).toEqual([0]);
  });
});

describe("lifecycleNextStep", () => {
  const notice = (kind: LifecycleNotice["kind"]): LifecycleNotice => ({ text: kind, kind, subject: null, position: 0 });

  it("is empty when there are no notices", () => {
    expect(lifecycleNextStep([])).toBe("");
  });

  it("tells the reader to cite the successor shown only when a redirect is reported", () => {
    expect(lifecycleNextStep([notice("redirect")])).toContain("cite the successor notes shown");
    expect(lifecycleNextStep([notice("expired_returned")])).not.toContain("successor");
    expect(lifecycleNextStep([notice("expired_head")])).not.toContain("successor");
  });

  it("warns that expired notes are not current for expired-only notices", () => {
    for (const kind of ["expired_returned", "expired_head"] as const) {
      expect(lifecycleNextStep([notice(kind)])).toContain("do not treat them as current");
    }
  });

  it("covers flagged superseded notes (include_superseded / unresolved)", () => {
    for (const kind of ["superseded_returned", "unresolved"] as const) {
      expect(lifecycleNextStep([notice(kind)])).toContain("cite the successor of each");
    }
  });
});

describe("isMissingLifecycleSchemaError", () => {
  it("recognises undefined_column (42703) and undefined_table (42P01)", () => {
    expect(isMissingLifecycleSchemaError({ code: "42703" })).toBe(true);
    expect(isMissingLifecycleSchemaError(Object.assign(new Error('column "valid_until" does not exist'), { code: "42703" }))).toBe(true);
    expect(isMissingLifecycleSchemaError({ code: "42P01" })).toBe(true);
  });

  it("rejects other Postgres errors and non-errors", () => {
    expect(isMissingLifecycleSchemaError({ code: "23505" })).toBe(false);
    expect(isMissingLifecycleSchemaError({ code: "57014" })).toBe(false);
    expect(isMissingLifecycleSchemaError(new Error("boom"))).toBe(false);
    expect(isMissingLifecycleSchemaError(null)).toBe(false);
    expect(isMissingLifecycleSchemaError(undefined)).toBe(false);
    expect(isMissingLifecycleSchemaError("42703")).toBe(false);
  });
});

describe("searchCandidatePredicateSql", () => {
  it("keeps superseded rows as candidates even when their own valid_until has passed", () => {
    const sql = searchCandidatePredicateSql("n", { includeExpired: false });
    expect(sql).toBe("(n.status = 'superseded' OR n.valid_until IS NULL OR n.valid_until > now())");
  });

  it("is TRUE when expired rows are included", () => {
    expect(searchCandidatePredicateSql("n", { includeExpired: true })).toBe("TRUE");
  });
});

// ─────────────────────────────────────────────────────────────────
// 2. buildSearchContextSql (pure)
// ─────────────────────────────────────────────────────────────────

const FILTER_RE = /content_type <> 'note' OR content_id IN \(SELECT id::text FROM notes WHERE /g;
const countOf = (sql: string, re: RegExp) => (sql.match(re) ?? []).length;

function baseInput(over: Partial<SearchContextSqlInput> = {}): SearchContextSqlInput {
  return {
    pgVector: "[0.1,0.2]",
    threshold: 0.15,
    ftsQuery: "deploy schedule",
    hybrid: true,
    overFetchLimit: 20,
    ...over,
  };
}

describe("buildSearchContextSql", () => {
  it("puts the lifecycle subquery filter in each hybrid CTE exactly once and in the pure-vector query once", () => {
    const hybrid = buildSearchContextSql(baseInput());
    expect(countOf(hybrid.sql, FILTER_RE)).toBe(2);
    // one occurrence inside each CTE body
    const [semantic, fulltext] = hybrid.sql.split("fulltext AS");
    expect(countOf(semantic, FILTER_RE)).toBe(1);
    expect(countOf(fulltext, FILTER_RE)).toBe(1);
    expect(hybrid.lifecycleFilterApplied).toBe(true);

    const vector = buildSearchContextSql(baseInput({ hybrid: false }));
    expect(countOf(vector.sql, FILTER_RE)).toBe(1);
    expect(vector.lifecycleFilterApplied).toBe(true);
  });

  it("never references notes when the content_types filter excludes notes", () => {
    for (const hybrid of [true, false]) {
      const built = buildSearchContextSql(baseInput({ hybrid, contentTypes: ["handoff"] }));
      expect(built.sql).not.toMatch(/notes/);
      expect(countOf(built.sql, FILTER_RE)).toBe(0);
      expect(built.lifecycleFilterApplied).toBe(false);
    }
    const mixed = buildSearchContextSql(baseInput({ contentTypes: ["handoff", "task", "artifact"] }));
    expect(mixed.sql).not.toMatch(/notes/);
  });

  it("includes the filter when notes are in scope, explicitly or by omission", () => {
    for (const contentTypes of [undefined, [], ["note"], ["note", "handoff"]] as (string[] | undefined)[]) {
      const { sql } = buildSearchContextSql(baseInput({ contentTypes }));
      expect(countOf(sql, FILTER_RE)).toBe(2);
    }
  });

  it("omitLifecycleFilter removes the filter entirely (no reference to notes) and leaves the params untouched", () => {
    for (const hybrid of [true, false]) {
      const withFilter = buildSearchContextSql(baseInput({ hybrid, contentTypes: ["note"], after: "2026-01-01T00:00:00Z" }));
      const omitted = buildSearchContextSql(baseInput({ hybrid, contentTypes: ["note"], after: "2026-01-01T00:00:00Z", omitLifecycleFilter: true }));
      expect(omitted.sql).not.toMatch(/notes/);
      expect(omitted.lifecycleFilterApplied).toBe(false);
      expect(withFilter.lifecycleFilterApplied).toBe(true);
      expect(omitted.params).toEqual(withFilter.params);
    }
  });

  it("flips the expired clause with include_expired and keeps the orphan-dropping subquery either way", () => {
    const hide = buildSearchContextSql(baseInput());
    expect(hide.sql).toContain("notes.status = 'superseded' OR notes.valid_until IS NULL OR notes.valid_until > now()");
    expect(hide.sql).not.toContain("WHERE TRUE");

    const show = buildSearchContextSql(baseInput({ includeExpired: true }));
    expect(show.sql).not.toContain("valid_until");
    expect(countOf(show.sql, /SELECT id::text FROM notes WHERE TRUE\)/g)).toBe(2);
  });

  it("keeps superseded notes as candidates at selection, even if their own valid_until has passed (they are redirected afterwards)", () => {
    const { sql } = buildSearchContextSql(baseInput());
    // status is consulted only to EXEMPT superseded rows from the expiry test,
    // never to exclude them
    expect(sql).toContain("notes.status = 'superseded' OR");
    expect(sql).not.toMatch(/status\s*=\s*'active'/);
    expect(sql).not.toMatch(/status\s*<>/);
  });

  it("numbers placeholders consistently for every combination of mode, content types, dates and flags", () => {
    const modes = [true, false];
    const typeFilters: (string[] | undefined)[] = [undefined, [], ["handoff"], ["note"], ["note", "handoff"]];
    const dateCombos = [
      {},
      { after: "2026-01-01T00:00:00Z" },
      { before: "2026-12-31T00:00:00Z" },
      { after: "2026-01-01T00:00:00Z", before: "2026-12-31T00:00:00Z" },
    ];
    let combinations = 0;
    for (const hybrid of modes) {
      for (const contentTypes of typeFilters) {
        for (const dates of dateCombos) {
          for (const includeExpired of [false, true]) {
            for (const omitLifecycleFilter of [false, true]) {
              const input = baseInput({ hybrid, contentTypes, includeExpired, omitLifecycleFilter, ...dates });
              const { sql, params } = buildSearchContextSql(input);
              combinations++;

              const used = new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => parseInt(m[1], 10)));
              // every param is referenced, none beyond the end, no gaps
              expect([...used].sort((x, y) => x - y)).toEqual(params.map((_, i) => i + 1));
              expect(sql).not.toContain("$DATE");

              // layout: vector, threshold, [fts], [content_types], dates..., limit
              expect(params[0]).toBe(input.pgVector);
              expect(params[1]).toBe(input.threshold);
              let i = 2;
              if (hybrid) expect(params[i++]).toBe(input.ftsQuery);
              if (contentTypes?.length) expect(params[i++]).toEqual(contentTypes);
              if (dates.after) expect(params[i++]).toBe(dates.after);
              if (dates.before) expect(params[i++]).toBe(dates.before);
              expect(params[i++]).toBe(input.overFetchLimit);
              expect(i).toBe(params.length);
            }
          }
        }
      }
    }
    expect(combinations).toBe(2 * 5 * 4 * 2 * 2);
  });
});

describe("buildGraphOnlyFetchSql", () => {
  it("adds the lifecycle filter only when a requested key is a note", () => {
    expect(countOf(buildGraphOnlyFetchSql(["note", "handoff"]), FILTER_RE)).toBe(1);
    expect(buildGraphOnlyFetchSql(["handoff", "task"])).not.toMatch(/notes/);
    expect(buildGraphOnlyFetchSql(["note"], { includeExpired: true })).toContain("WHERE TRUE");
    expect(buildGraphOnlyFetchSql(["note"])).toContain("valid_until > now()");
    expect(buildGraphOnlyFetchSql(["note"])).toContain("notes.status = 'superseded' OR");
  });

  it("omitLifecycleFilter drops it even for note keys", () => {
    expect(buildGraphOnlyFetchSql(["note"], { omitLifecycleFilter: true })).not.toMatch(/notes/);
  });
});

// ─────────────────────────────────────────────────────────────────
// Gated helpers
// ─────────────────────────────────────────────────────────────────

/** 768-dim constant vector, or a unit basis vector, as a pgvector literal. */
const DIM = 768;
const constVec = (v = 0.01) => `[${new Array(DIM).fill(v).join(",")}]`;
function basisVec(axis: number): string {
  const a = new Array(DIM).fill(0);
  a[axis] = 1;
  return `[${a.join(",")}]`;
}

async function connectPg() {
  const pg = await import("pg");
  const client = new pg.default.Client({
    host: PG_HOST,
    port: parseInt(PG_PORT),
    user: PG_USER,
    password: PG_PASSWORD,
    database: PG_DATABASE,
  });
  await client.connect();
  return client;
}
type PgClient = Awaited<ReturnType<typeof connectPg>>;

/** Shared by the gated suites; assigned in the outer beforeAll. */
let client: PgClient;

// ── In-test stand-in for the embedding and reranker servers ────────

/**
 * A bag-of-words embedding: each word (3+ chars) lights up 8 hash-chosen
 * dimensions with hash-chosen signs; the vector is normalised. The same text
 * always yields the same vector, texts that share words have positive cosine
 * similarity, and texts that share none are near-orthogonal - enough for
 * retrieval behaviour to be driven by wording while staying deterministic.
 */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/^search_(query|document):\s*/, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
}

function stubVector(text: string): number[] {
  const v = new Array(DIM).fill(0);
  for (const word of wordsOf(text)) {
    const h = createHash("sha256").update(word).digest();
    for (let k = 0; k < 8; k++) {
      v[h.readUInt16BE(k * 2) % DIM] += h[16 + k] & 1 ? 1 : -1;
    }
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) {
    v[0] = 1;
    return v;
  }
  return v.map((x) => x / norm);
}

interface Stub {
  url: string;
  /** identity: keep fusion order; overlap: score = share of query words in the text; off: HTTP 503. */
  rerankMode: "identity" | "overlap" | "off";
  lastRerank: { query: string; texts: string[] } | null;
  close(): Promise<void>;
}

async function startStub(): Promise<Stub> {
  const stub: Stub = { url: "", rerankMode: "identity", lastRerank: null, close: async () => {} };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      try {
        const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
        if (req.method === "GET" && req.url === "/health") return send(200, { status: "ok" });
        if (req.method === "POST" && req.url === "/v1/embeddings") {
          const { input } = JSON.parse(body);
          const inputs: string[] = Array.isArray(input) ? input : [input];
          return send(200, { data: inputs.map((t, index) => ({ index, embedding: stubVector(t) })) });
        }
        if (req.method === "POST" && req.url === "/rerank") {
          const { query, texts } = JSON.parse(body) as { query: string; texts: string[] };
          stub.lastRerank = { query, texts };
          if (stub.rerankMode === "off") return send(503, { error: "reranker off" });
          const q = new Set(wordsOf(query));
          return send(
            200,
            texts.map((t, index) => {
              if (stub.rerankMode === "identity") return { index, score: 1 / (1 + index) };
              const words = new Set(wordsOf(t));
              const hit = [...q].filter((w) => words.has(w)).length;
              return { index, score: q.size ? hit / q.size : 0 };
            })
          );
        }
        send(404, { error: "not found" });
      } catch (err) {
        send(500, { error: String(err) });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return stub;
}

let stub: Stub;

/** Fire-and-forget indexing lands asynchronously; wait until every note has its embeddings row. */
async function waitForEmbeddings(ids: string[], timeoutMs = 8_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await client.query(
      "SELECT content_id FROM embeddings WHERE content_type = 'note' AND content_id = ANY($1::text[])",
      [ids]
    );
    if (res.rowCount === new Set(ids).size) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Embeddings for ${ids.join(", ")} did not appear within ${timeoutMs}ms`);
}

/** Create a note and wait for its (stubbed) embedding, so later direct writes to `embeddings` cannot race it. */
async function mkNote(overrides: Record<string, unknown> = {}) {
  const created = await callTool("create_note", {
    title: "Acme Corp deploy schedule",
    content: "Acme Corp deploys on Fridays.",
    scope: "work",
    provenance: "stated",
    ...overrides,
  });
  expect(created.error).toBeUndefined();
  await waitForEmbeddings([created.id]);
  return created as { id: string; title: string; version: number; [key: string]: any };
}

async function supersede(oldId: string, newId: string) {
  const res = await callTool("supersede_note", { id: oldId, superseded_by: newId });
  expect(res.error).toBeUndefined();
  return res;
}

async function insertEmbedding(
  c: PgClient,
  type: string,
  id: string,
  text: string,
  vec: string,
  metadata: Record<string, unknown> = {}
) {
  await c.query(
    `INSERT INTO embeddings (content_type, content_id, content_text, embedding, metadata)
     VALUES ($1, $2, $3, $4::vector, $5::jsonb)`,
    [type, id, text, vec, JSON.stringify(metadata)]
  );
}

// ─────────────────────────────────────────────────────────────────
// Gated suites
// ─────────────────────────────────────────────────────────────────

describe.skipIf(!pgAvailable)("Search lifecycle (Postgres)", () => {
  beforeAll(async () => {
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
    await mkdir(TEST_DATA_DIR, { recursive: true });

    // Stand-in for the embedding server (and reranker): the spawned server's
    // fire-and-forget note indexing and its search_context calls both go here,
    // so the tool handler runs for real without TEI.
    stub = await startStub();

    serverProcess = spawn("npx", ["tsx", "src/server.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MCP_PORT: String(TEST_PORT),
        DATA_DIR: TEST_DATA_DIR,
        PGHOST: PG_HOST,
        PGPORT: PG_PORT,
        PGUSER: PG_USER,
        PGPASSWORD: PG_PASSWORD,
        PGDATABASE: PG_DATABASE,
        EMBEDDING_URL: stub.url,
        RERANKER_URL: stub.url,
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });

    // Continuously drain child stdio so pipe buffers don't fill and block the
    // child process when this suite runs alongside other parallel workers
    // (same pattern as server.test.ts / handoff-nav.test.ts). Swap the no-op
    // handlers for process.stderr.write(d) when debugging.
    serverProcess.stderr?.on("data", () => {});
    serverProcess.stdout?.on("data", () => {});

    await waitForServer(BASE_URL);
    client = await connectPg();
  }, 30_000);

  afterAll(async () => {
    await client?.end().catch(() => {});
    if (serverProcess) {
      if (process.platform === "win32" && serverProcess.pid) {
        // shell: true makes serverProcess the cmd.exe wrapper, and SIGTERM
        // never reaches the tsx/node grandchildren. An orphaned server keeps
        // the port bound and would answer the NEXT run's requests against a
        // database that run has just wiped, so kill the whole tree.
        spawnSync("taskkill", ["/pid", String(serverProcess.pid), "/T", "/F"]);
      } else {
        serverProcess.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 500));
        if (!serverProcess.killed) serverProcess.kill("SIGKILL");
      }
    }
    await stub?.close();
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it("search_notes and search_context advertise the lifecycle flags and keep their steering structure", async () => {
    const res = await mcpPost(jsonrpc("tools/list"));
    const data = (await parseSseResponse(res)) as any;
    const tools: any[] = data.result.tools;
    const byName = (n: string) => tools.find((t) => t.name === n);

    for (const name of ["search_notes", "search_context"]) {
      const tool = byName(name);
      expect(tool.inputSchema.properties.include_superseded.type).toBe("boolean");
      expect(tool.inputSchema.properties.include_expired.type).toBe("boolean");
      expect(tool.description).toContain("CALL THIS WHEN");
      expect(tool.description).toContain("DO NOT CALL");
      expect(tool.description).toContain("CONSEQUENCE OF SKIPPING");
      expect(tool.description).toContain("Lifecycle");
      expect(tool.description).toContain("lifecycle_notices");
      expect(tool.description).toContain("matched_via");
      expect(tool.description).toMatch(/which expired|chain ends in an expired note/);
      expect(tool.description).toContain("redirected");
    }
    expect(byName("search_context").description).toContain("note_status");
    // Documented behaviour of the date window and of the scope/domain filters.
    expect(byName("search_context").description).toContain("successor shown by a redirect");
    expect(byName("search_context").description).toContain("pass include_superseded: true when asking about historical state");
    expect(byName("search_notes").description).toContain("scope and domain filters apply to the successor too");

    const supersedeDesc = byName("supersede_note").description as string;
    expect(supersedeDesc).toContain("redirect");
    expect(supersedeDesc).toContain("lifecycle_notices");
    expect(supersedeDesc).not.toMatch(/does not (yet )?redirect/i);
  });

  // ── search_notes through the server ─────────────────────────────

  describe("search_notes", () => {
    it("redirects a hit on superseded wording to the successor, with matched_via, a notice and next_step", async () => {
      const a = await mkNote({ title: "Acme Corp Friday deploys", content: "Acme Corp deploys on Fridays using the kestrelfrost release train." });
      const b = await mkNote({ title: "Acme Corp deploy freeze", content: "Acme Corp froze Friday deploys; releases now ship on Tuesdays." });
      await supersede(a.id, b.id);

      const res = await callTool("search_notes", { query: "kestrelfrost" });

      expect(res.error).toBeUndefined();
      expect(res.notes).toHaveLength(1);
      const n = res.notes[0];
      expect(n.id).toBe(b.id);
      expect(n.title).toBe("Acme Corp deploy freeze");
      expect(n.content).toContain("Tuesdays");
      expect(n.status).toBe("active");
      expect(n.matched_via).toEqual([a.id]);
      expect(n.successor_title).toBeNull();
      expect(n.superseded_by).toBeNull();
      expect(n.rank).toBeGreaterThan(0);
      expect(res.redirected).toBe(1);
      expect(res.total_count).toBe(1);
      expect(res.lifecycle_notices).toHaveLength(1);
      expect(res.lifecycle_notices[0]).toContain(`Note ${a.id.slice(0, 8)}… ('Acme Corp Friday deploys') matched but was superseded by ${b.id.slice(0, 8)}… ('Acme Corp deploy freeze') on `);
      expect(res.lifecycle_notices[0]).toMatch(/ on \d{4}-\d{2}-\d{2} — showing the successor\.$/);
      expect(res.next_step).toContain("cite the successor");
    });

    it("include_superseded returns the superseded note itself with successor_title and a notice", async () => {
      const a = await mkNote({ title: "Gate policy old", content: "The gate policy requires two approvals, per the quillmoor runbook." });
      const b = await mkNote({ title: "Gate policy new", content: "The gate policy now requires one approval." });
      await supersede(a.id, b.id);

      const res = await callTool("search_notes", { query: "quillmoor", include_superseded: true });

      expect(res.notes).toHaveLength(1);
      const n = res.notes[0];
      expect(n.id).toBe(a.id);
      expect(n.status).toBe("superseded");
      expect(n.superseded_by).toBe(b.id);
      expect(n.superseded_at).toBeTruthy();
      expect(n.successor_title).toBe("Gate policy new");
      expect(n.matched_via).toEqual([]);
      expect(res.redirected).toBe(0);
      expect(res.lifecycle_notices).toHaveLength(1);
      expect(res.lifecycle_notices[0]).toContain("is superseded by");
      expect(res.lifecycle_notices[0]).toContain("cite the successor");
      expect(res.next_step).toContain("cite the successor");
    });

    it("an unremarkable active match carries no notices, an empty matched_via and no successor wording", async () => {
      const n = await mkNote({ title: "Plain note", content: "A plain note about the glimmerwick pipeline." });

      const res = await callTool("search_notes", { query: "glimmerwick" });

      expect(res.notes).toHaveLength(1);
      expect(res.notes[0]).toMatchObject({ id: n.id, status: "active", matched_via: [], successor_title: null, provenance: "stated", version: 1 });
      expect(res.lifecycle_notices).toEqual([]);
      expect(res.redirected).toBe(0);
      expect(res.next_step).not.toContain("cite the successor");
    });

    it("hides an expired note by default and returns it, flagged, with include_expired", async () => {
      const c = await mkNote({ title: "Holiday freeze", content: "Deploy freeze over the emberlark holiday window.", valid_until: "2020-01-01T00:00:00Z" });

      const hidden = await callTool("search_notes", { query: "emberlark" });
      expect(hidden.notes).toEqual([]);
      expect(hidden.total_count).toBe(0);
      expect(hidden.next_step).toContain("No matching notes found");

      const shown = await callTool("search_notes", { query: "emberlark", include_expired: true });
      expect(shown.notes).toHaveLength(1);
      expect(shown.notes[0]).toMatchObject({ id: c.id, status: "expired", matched_via: [] });
      expect(shown.total_count).toBe(1);
      expect(shown.lifecycle_notices).toEqual([`Note ${c.id.slice(0, 8)}… ('Holiday freeze') expired on 2020-01-01.`]);
      // an expired-only notice must not tell the reader to cite a successor that is not there
      expect(shown.next_step).toContain("do not treat them as current");
      expect(shown.next_step).not.toContain("cite the successor");
    });

    it("redirects an old note to the HEAD of a chain and collapses the whole chain into one row", async () => {
      const a = await mkNote({ title: "Runbook v1", content: "Runbook step list, original orchidvale edition." });
      const b = await mkNote({ title: "Runbook v2", content: "Runbook step list, revised orchidvale edition." });
      const c = await mkNote({ title: "Runbook v3", content: "Runbook step list, third revision with new steps." });
      await supersede(a.id, b.id);
      await supersede(b.id, c.id);

      // A and B both match "orchidvale"; the head C does not.
      const res = await callTool("search_notes", { query: "orchidvale" });

      expect(res.notes).toHaveLength(1);
      expect(res.notes[0].id).toBe(c.id);
      expect([...res.notes[0].matched_via].sort()).toEqual([a.id, b.id].sort());
      expect(res.total_count).toBe(2);
      expect(res.redirected).toBe(2);
      expect(res.lifecycle_notices).toHaveLength(2);

      // Only A matches: still lands on C, not on the intermediate B.
      const onlyA = await callTool("search_notes", { query: "original orchidvale" });
      expect(onlyA.notes.map((n: any) => n.id)).toEqual([c.id]);
      expect(onlyA.notes[0].matched_via).toEqual([a.id]);
      expect(onlyA.lifecycle_notices[0]).toContain("through a chain of replacements");
    });

    it("merges into ONE row when the head also matched directly", async () => {
      const a = await mkNote({ title: "Rotation old", content: "On-call rotation changes weekly at willowmere." });
      const b = await mkNote({ title: "Rotation new", content: "On-call rotation changes every two weeks at willowmere." });
      await supersede(a.id, b.id);

      const res = await callTool("search_notes", { query: "willowmere" });

      expect(res.notes).toHaveLength(1);
      expect(res.notes[0].id).toBe(b.id);
      expect(res.notes[0].matched_via).toEqual([a.id]);
      expect(res.total_count).toBe(2); // candidates before redirection
      expect(res.redirected).toBe(1);

      // With redirection off both appear as themselves.
      const raw = await callTool("search_notes", { query: "willowmere", include_superseded: true });
      expect(raw.notes.map((n: any) => n.id).sort()).toEqual([a.id, b.id].sort());
      expect(raw.redirected).toBe(0);
    });

    it("drops a candidate whose chain ends in an expired head, and says why", async () => {
      const a = await mkNote({ title: "Trial terms old", content: "Trial terms for tarnwick customers are thirty days." });
      const b = await mkNote({ title: "Trial terms new", content: "Trial terms are fourteen days." });
      await supersede(a.id, b.id);
      const upd = await callTool("update_note", { id: b.id, valid_until: "2020-06-30T00:00:00Z" });
      expect(upd.error).toBeUndefined();

      const res = await callTool("search_notes", { query: "tarnwick" });
      expect(res.notes).toEqual([]);
      expect(res.redirected).toBe(0);
      expect(res.lifecycle_notices).toHaveLength(1);
      expect(res.lifecycle_notices[0]).toContain("expired on 2020-06-30");
      expect(res.next_step).toContain("none is current");
      expect(res.next_step).not.toContain("cite the successor");

      const withExpired = await callTool("search_notes", { query: "tarnwick", include_expired: true });
      expect(withExpired.notes).toHaveLength(1);
      expect(withExpired.notes[0]).toMatchObject({ id: b.id, status: "expired", matched_via: [a.id] });
      expect(withExpired.lifecycle_notices).toHaveLength(2);
    });

    it("scope and domain filters still apply with the lifecycle predicate", async () => {
      const n = await mkNote({ title: "Personal reading list", content: "Books about the yarrowdale coast.", scope: "personal", domain: "reading" });

      expect((await callTool("search_notes", { query: "yarrowdale", scope: "work" })).notes).toEqual([]);
      expect((await callTool("search_notes", { query: "yarrowdale", scope: "personal", domain: "other" })).notes).toEqual([]);
      const hit = await callTool("search_notes", { query: "yarrowdale", scope: "personal", domain: "reading" });
      expect(hit.notes.map((x: any) => x.id)).toEqual([n.id]);
    });

    // B1: supersession wins over expiry - a superseded note whose OWN
    // valid_until has passed must still be redirected.
    describe("a superseded note whose own valid_until has passed (B1)", () => {
      it("is still a candidate and is redirected to its active successor", async () => {
        const a = await mkNote({ title: "Vendor terms old", content: "Vendor terms were net thirty, per the brackenwold schedule.", valid_until: "2020-03-01T00:00:00Z" });
        const b = await mkNote({ title: "Vendor terms new", content: "Vendor terms are net fifteen." });
        await supersede(a.id, b.id);

        const res = await callTool("search_notes", { query: "brackenwold" });

        expect(res.notes).toHaveLength(1);
        expect(res.notes[0]).toMatchObject({ id: b.id, status: "active", matched_via: [a.id] });
        expect(res.total_count).toBe(1);
        expect(res.redirected).toBe(1);
        expect(res.lifecycle_notices).toHaveLength(1);
        expect(res.lifecycle_notices[0]).toContain("showing the successor");

        // include_superseded shows it as itself - superseded, not expired: supersession wins.
        const raw = await callTool("search_notes", { query: "brackenwold", include_superseded: true });
        expect(raw.notes).toHaveLength(1);
        expect(raw.notes[0]).toMatchObject({ id: a.id, status: "superseded", valid_until: "2020-03-01T00:00:00.000Z" });
      });

      it("yields the expired-head notice when the successor is itself expired", async () => {
        const a = await mkNote({ title: "Region plan old", content: "Region plan covers the ashgrove datacentre.", valid_until: "2020-03-01T00:00:00Z" });
        const b = await mkNote({ title: "Region plan new", content: "Region plan covers two datacentres." });
        await supersede(a.id, b.id);
        expect((await callTool("update_note", { id: b.id, valid_until: "2020-09-30T00:00:00Z" })).error).toBeUndefined();

        const res = await callTool("search_notes", { query: "ashgrove" });

        expect(res.notes).toEqual([]);
        expect(res.lifecycle_notices).toHaveLength(1);
        expect(res.lifecycle_notices[0]).toContain("expired on 2020-09-30");
        expect(res.lifecycle_notices[0]).toContain("there is no current version to show");
        expect(res.redirected).toBe(0);
      });
    });

    // M2: scope / domain filters constrain what a redirect may show.
    describe("scope and domain filters apply to redirect heads (M2)", () => {
      it("keeps the superseded note as itself when its successor lies outside the scope filter", async () => {
        const a = await mkNote({ title: "Travel policy old", content: "Travel policy requires approval, see the dunmere appendix.", scope: "work" });
        const b = await mkNote({ title: "Travel policy new", content: "Travel policy no longer needs approval.", scope: "personal" });
        await supersede(a.id, b.id);

        const scoped = await callTool("search_notes", { query: "dunmere", scope: "work" });
        expect(scoped.notes.map((n: any) => n.id)).toEqual([a.id]);
        expect(scoped.notes[0]).toMatchObject({ status: "superseded", matched_via: [], scope: "work" });
        expect(scoped.redirected).toBe(0);
        expect(scoped.lifecycle_notices).toHaveLength(1);
        expect(scoped.lifecycle_notices[0]).toContain("outside the filters applied");
        expect(scoped.next_step).toContain("cite the successor of each");

        // Unfiltered, the redirect is free to cross scopes.
        const open = await callTool("search_notes", { query: "dunmere" });
        expect(open.notes.map((n: any) => n.id)).toEqual([b.id]);
        expect(open.notes[0].scope).toBe("personal");
      });

      it("keeps the superseded note as itself when its successor lies outside the domain filter", async () => {
        const a = await mkNote({ title: "Alert routing old", content: "Alert routing sends pages to the corvane rota.", domain: "ops" });
        const b = await mkNote({ title: "Alert routing new", content: "Alert routing is handled by the vendor.", domain: "vendor" });
        await supersede(a.id, b.id);

        const scoped = await callTool("search_notes", { query: "corvane", domain: "ops" });
        expect(scoped.notes.map((n: any) => n.id)).toEqual([a.id]);
        expect(scoped.notes[0].status).toBe("superseded");

        const inDomain = await callTool("search_notes", { query: "corvane", domain: "vendor" });
        expect(inDomain.notes).toEqual([]);
      });

      it("follows the redirect when the successor satisfies the same filters", async () => {
        const a = await mkNote({ title: "Intake form old", content: "Intake form lives in the thistlewick folder.", scope: "work", domain: "ops" });
        const b = await mkNote({ title: "Intake form new", content: "Intake form moved to the portal.", scope: "work", domain: "ops" });
        await supersede(a.id, b.id);

        const res = await callTool("search_notes", { query: "thistlewick", scope: "work", domain: "ops" });
        expect(res.notes.map((n: any) => n.id)).toEqual([b.id]);
        expect(res.redirected).toBe(1);
      });
    });

    describe("paging and notices describe the page actually returned", () => {
      it("over-fetches so merged redirects do not leave the page short", async () => {
        // The two best-ranked candidates (heavy on the token) are both superseded
        // by one head; two lighter direct matches follow. With limit=2 a naive
        // LIMIT 2 would redirect two rows into one and return a single note.
        const head = await mkNote({ title: "Escalation current", content: "Escalation now goes to the duty manager." });
        const old1 = await mkNote({ title: "Escalation v1", content: "marrowdene marrowdene marrowdene marrowdene marrowdene marrowdene" });
        const old2 = await mkNote({ title: "Escalation v2", content: "marrowdene marrowdene marrowdene marrowdene marrowdene" });
        const direct1 = await mkNote({ title: "Direct one", content: "A single mention of marrowdene inside a rather long sentence about unrelated operational matters and procedures." });
        const direct2 = await mkNote({ title: "Direct two", content: "Another lone mention of marrowdene tucked into a long sentence about unrelated scheduling matters and routines." });
        await supersede(old1.id, head.id);
        await supersede(old2.id, head.id);

        const res = await callTool("search_notes", { query: "marrowdene", limit: 2 });

        expect(res.notes).toHaveLength(2);
        expect(res.notes[0].id).toBe(head.id);
        expect([...res.notes[0].matched_via].sort()).toEqual([old1.id, old2.id].sort());
        expect([direct1.id, direct2.id]).toContain(res.notes[1].id);
        expect(res.total_count).toBe(4);
        expect(res.redirected).toBe(2);
      });

      it("drops redirect notices for successors that did not make the page", async () => {
        const h1 = await mkNote({ title: "Rollback current one", content: "Rollback is automatic." });
        const h2 = await mkNote({ title: "Rollback current two", content: "Rollback needs approval." });
        const o1 = await mkNote({ title: "Rollback old one", content: "gladehollow gladehollow gladehollow gladehollow gladehollow" });
        const o2 = await mkNote({ title: "Rollback old two", content: "gladehollow in a rather long sentence about unrelated operational procedures and routines." });
        await supersede(o1.id, h1.id);
        await supersede(o2.id, h2.id);

        const res = await callTool("search_notes", { query: "gladehollow", limit: 1 });

        expect(res.notes.map((n: any) => n.id)).toEqual([h1.id]);
        expect(res.redirected).toBe(1);
        expect(res.lifecycle_notices).toHaveLength(1);
        expect(res.lifecycle_notices[0]).toContain(h1.id.slice(0, 8));
        expect(res.lifecycle_notices.join(" ")).not.toContain(h2.id.slice(0, 8));
      });
    });
  });

  // ── search_context SQL against real Postgres, fixed vectors ─────

  describe("search_context candidate SQL and redirect (direct embeddings rows)", () => {
    const text = (title: string) => `${title}\nsearch lifecycle shared token quillmoor`;
    const QUERY_FTS = "quillmoor";

    // Notes shared by the tests in this block.
    let active: { id: string; title: string };
    let stale: { id: string; title: string };
    let successor: { id: string; title: string };
    let expired: { id: string; title: string };
    let staleExpired: { id: string; title: string };
    let successor2: { id: string; title: string };
    const orphanId = "99999999-9999-4999-8999-999999999999";
    const handoffId = "2026-03-01T00-00-00-000Z-aaaa1111.json#chunk_0";

    beforeAll(async () => {
      active = await mkNote({ title: "Acme Corp backup policy", content: "Nightly backups." });
      stale = await mkNote({ title: "Acme Corp release cadence (old)", content: "Weekly releases." });
      successor = await mkNote({ title: "Acme Corp release cadence", content: "Biweekly releases." });
      expired = await mkNote({ title: "Acme Corp holiday freeze", content: "Freeze until January.", valid_until: "2020-01-01T00:00:00Z" });
      // Superseded AND past its own valid_until: supersession wins, so it must stay a candidate.
      staleExpired = await mkNote({ title: "Acme Corp support hours (old)", content: "Support is nine to five.", valid_until: "2020-02-01T00:00:00Z" });
      successor2 = await mkNote({ title: "Acme Corp support hours", content: "Support is around the clock." });
      await supersede(stale.id, successor.id);
      await supersede(staleExpired.id, successor2.id);
    });

    /** Fresh embeddings table for the standard fixture, all at the same constant vector. */
    async function seedStandardEmbeddings() {
      await client.query("DELETE FROM embeddings");
      const v = constVec();
      const noteMeta = (id: string) => ({ note_id: id, scope: "work", created_at: "2026-03-01T00:00:00.000Z" });
      for (const n of [active, stale, successor, expired, staleExpired, successor2]) {
        await insertEmbedding(client, "note", n.id, text(n.title), v, noteMeta(n.id));
      }
      await insertEmbedding(client, "note", orphanId, text("Orphaned embedding"), v, noteMeta(orphanId));
      await insertEmbedding(client, "handoff", handoffId, text("Handoff chunk"), v, {
        stored_at: "2026-03-01T00:00:00.000Z",
        source_file: handoffId.split("#")[0],
        chunk_index: 0,
      });
    }

    async function run(over: Partial<SearchContextSqlInput> = {}) {
      const { sql, params } = buildSearchContextSql({
        pgVector: constVec(),
        threshold: 0.15,
        ftsQuery: QUERY_FTS,
        hybrid: true,
        overFetchLimit: 50,
        ...over,
      });
      const res = await client.query(sql, params);
      return { sql, rows: res.rows as SearchResultRow[], ids: new Set(res.rows.map((r: any) => r.content_id as string)) };
    }

    it("selects superseded notes as candidates but drops computed-expired notes and orphaned embeddings (hybrid and pure vector)", async () => {
      await seedStandardEmbeddings();
      for (const hybrid of [true, false]) {
        const { ids } = await run({ hybrid });
        expect(ids.has(active.id), `hybrid=${hybrid}`).toBe(true);
        expect(ids.has(stale.id), `hybrid=${hybrid}`).toBe(true); // redirected later, not hidden here
        expect(ids.has(successor.id), `hybrid=${hybrid}`).toBe(true);
        expect(ids.has(handoffId), `hybrid=${hybrid}`).toBe(true);
        expect(ids.has(expired.id), `hybrid=${hybrid}`).toBe(false);
        expect(ids.has(orphanId), `hybrid=${hybrid}`).toBe(false);
      }
    });

    it("B1: a superseded note whose own valid_until has passed is still a candidate (hybrid and pure vector)", async () => {
      await seedStandardEmbeddings();
      for (const hybrid of [true, false]) {
        const { ids } = await run({ hybrid });
        expect(ids.has(staleExpired.id), `hybrid=${hybrid}`).toBe(true);
        expect(ids.has(expired.id), `hybrid=${hybrid}`).toBe(false);
      }
      const graph = await client.query(buildGraphOnlyFetchSql(["note", "note"]), [["note", "note"], [staleExpired.id, expired.id]]);
      expect(graph.rows.map((r: any) => r.content_id)).toEqual([staleExpired.id]);
    });

    it("include_expired brings the expired note back; the orphan still drops", async () => {
      await seedStandardEmbeddings();
      for (const hybrid of [true, false]) {
        const { ids } = await run({ hybrid, includeExpired: true });
        expect(ids.has(expired.id), `hybrid=${hybrid}`).toBe(true);
        expect(ids.has(orphanId), `hybrid=${hybrid}`).toBe(false);
      }
    });

    it("a handoff-only search runs without touching notes", async () => {
      await seedStandardEmbeddings();
      for (const hybrid of [true, false]) {
        const { sql, ids } = await run({ hybrid, contentTypes: ["handoff"] });
        expect(sql).not.toMatch(/notes/);
        expect([...ids]).toEqual([handoffId]);
      }
    });

    it("a note-only search excludes the handoff row", async () => {
      await seedStandardEmbeddings();
      const { ids } = await run({ contentTypes: ["note"] });
      expect(ids.has(handoffId)).toBe(false);
      expect(ids.has(active.id)).toBe(true);
    });

    it("date filters and the lifecycle filter compose (placeholders line up against a live server)", async () => {
      await seedStandardEmbeddings();
      const all = await run({ after: "2000-01-01T00:00:00Z", before: "2100-01-01T00:00:00Z", contentTypes: ["note", "handoff"] });
      expect(all.ids.has(active.id)).toBe(true);
      expect(all.ids.has(expired.id)).toBe(false);
      const none = await run({ after: "2100-01-01T00:00:00Z" });
      expect(none.rows).toHaveLength(0);
    });

    it("graph-only fetch honours the lifecycle filter for note keys", async () => {
      await seedStandardEmbeddings();
      const types = ["note", "note", "note", "handoff"];
      const ids = [active.id, expired.id, orphanId, handoffId];
      const res = await client.query(buildGraphOnlyFetchSql(types), [types, ids]);
      expect(new Set(res.rows.map((r: any) => r.content_id))).toEqual(new Set([active.id, handoffId]));

      const withExpired = await client.query(buildGraphOnlyFetchSql(types, { includeExpired: true }), [types, ids]);
      expect(new Set(withExpired.rows.map((r: any) => r.content_id))).toEqual(new Set([active.id, expired.id, handoffId]));
    });

    /** Run candidate SQL, then the same RRF fusion + redirect the handler performs. */
    async function endToEnd(over: Partial<SearchContextSqlInput> = {}, flags: Partial<RedirectOptions> = {}) {
      const { rows } = await run(over);
      fuseRrf(rows, new Map(), { vector: 1, fulltext: 1, graph: 1 });
      return redirectNoteRows(client, rows, { includeSuperseded: false, includeExpired: false, ...flags });
    }

    it("end to end: superseded notes are replaced by their successors, each appearing once with matched_via (including a superseded-and-expired one)", async () => {
      await seedStandardEmbeddings();

      const out = await endToEnd();

      const noteRows = out.rows.filter((r) => r.content_type === "note");
      expect(noteRows.map((r) => r.content_id).sort()).toEqual([active.id, successor.id, successor2.id].sort());
      const head = noteRows.find((r) => r.content_id === successor.id)!;
      expect(head.matched_via).toEqual([stale.id]);
      expect(head.note_status).toBe("active");
      expect(head.content_text).toContain("Acme Corp release cadence");
      const head2 = noteRows.find((r) => r.content_id === successor2.id)!;
      expect(head2.matched_via).toEqual([staleExpired.id]);
      expect(noteRows.find((r) => r.content_id === active.id)!.matched_via).toEqual([]);
      expect(out.rows.some((r) => r.content_id === handoffId)).toBe(true);
      expect(out.rows.some((r) => r.content_id === stale.id)).toBe(false);
      expect(out.rows.some((r) => r.content_id === staleExpired.id)).toBe(false);
      expect(out.rows.some((r) => r.content_id === expired.id)).toBe(false);
      expect(out.redirected).toBe(2);
      expect(out.notices.map((n) => n.kind)).toEqual(expect.arrayContaining(["redirect", "redirect"]));
      expect(out.notices).toHaveLength(2);
      const redirectTexts = texts(out).join("\n");
      expect(redirectTexts).toContain(`Note ${stale.id.slice(0, 8)}…`);
      expect(redirectTexts).toContain(`${successor.id.slice(0, 8)}… ('Acme Corp release cadence')`);
      expect(redirectTexts).toContain(`Note ${staleExpired.id.slice(0, 8)}…`);
      for (const nt of out.notices) expect([successor.id, successor2.id]).toContain(nt.subject);
    });

    it("end to end with include_superseded: both notes come back as themselves, flagged", async () => {
      await seedStandardEmbeddings();

      const out = await endToEnd({}, { includeSuperseded: true });

      const staleRow = out.rows.find((r) => r.content_id === stale.id)!;
      expect(staleRow.note_status).toBe("superseded");
      expect(staleRow.successor_title).toBe("Acme Corp release cadence");
      expect(staleRow.superseded_by).toBe(successor.id);
      const staleExpiredRow = out.rows.find((r) => r.content_id === staleExpired.id)!;
      expect(staleExpiredRow.note_status).toBe("superseded"); // supersession wins over expiry
      expect(out.rows.some((r) => r.content_id === successor.id)).toBe(true);
      expect(out.redirected).toBe(0);
      expect(out.notices.every((n) => n.kind === "superseded_returned")).toBe(true);
      expect(out.notices).toHaveLength(2);
      expect(texts(out)[0]).toContain("is superseded by");
    });

    it("end to end with include_expired: the expired note is returned flagged and noticed", async () => {
      await seedStandardEmbeddings();

      const out = await endToEnd({ includeExpired: true }, { includeExpired: true });

      const row = out.rows.find((r) => r.content_id === expired.id)!;
      expect(row.note_status).toBe("expired");
      expect(texts(out).some((n) => n.includes("expired on 2020-01-01"))).toBe(true);
    });

    it("materialises a head that has no embeddings row from notes.title/content", async () => {
      // Only the OLD note is embedded (its successor was inserted by sync and not yet embedded).
      const oldN = await mkNote({ title: "Vendor contact old", content: "Contact the vendor via the old channel quillmoor." });
      const newN = await mkNote({ title: "Vendor contact new", content: "Contact the vendor via the new channel." });
      await supersede(oldN.id, newN.id);
      await client.query("DELETE FROM embeddings");
      await insertEmbedding(client, "note", oldN.id, text(oldN.title), constVec(), { note_id: oldN.id, scope: "work", created_at: "2026-03-01T00:00:00.000Z" });

      const out = await endToEnd();

      expect(out.rows).toHaveLength(1);
      const row = out.rows[0];
      expect(row.content_id).toBe(newN.id);
      expect(row.matched_via).toEqual([oldN.id]);
      expect(row.content_text.startsWith("Vendor contact new\nContact the vendor via the new channel.")).toBe(true);
      expect(row.metadata).toMatchObject({ note_id: newN.id, scope: "work" });
      expect(typeof (row.metadata as any).created_at).toBe("string");
      expect(row.rrf_score).toBeGreaterThan(0); // carries the candidate's score
      expect(row.rerank_text).toBe(text(oldN.title)); // reranked on the wording that matched
    });

    it("prefers the head's own embeddings row when it exists but was not a candidate", async () => {
      const oldN = await mkNote({ title: "Ticket triage old", content: "Triage tickets daily." });
      const newN = await mkNote({ title: "Ticket triage new", content: "Triage tickets twice daily." });
      await supersede(oldN.id, newN.id);
      await client.query("DELETE FROM embeddings");
      // Orthogonal vectors: a query along axis 0 retrieves only the old note.
      await insertEmbedding(client, "note", oldN.id, "old embedded text", basisVec(0), { note_id: oldN.id, scope: "work", created_at: "2026-03-01T00:00:00.000Z" });
      await insertEmbedding(client, "note", newN.id, "new embedded text from the embeddings row", basisVec(1), { note_id: newN.id, scope: "work", created_at: "2026-03-02T00:00:00.000Z", domain: "ops" });

      const { rows: candidates } = await run({ pgVector: basisVec(0), hybrid: false, threshold: 0.9 });
      expect(candidates.map((r) => r.content_id)).toEqual([oldN.id]);

      const out = await redirectNoteRows(client, candidates, { includeSuperseded: false, includeExpired: false });
      expect(out.rows).toHaveLength(1);
      expect(out.rows[0].content_id).toBe(newN.id);
      expect(out.rows[0].content_text).toBe("new embedded text from the embeddings row");
      expect(out.rows[0].metadata).toMatchObject({ domain: "ops" });
      expect(out.rows[0].matched_via).toEqual([oldN.id]);
      expect(out.rows[0].rerank_text).toBe("old embedded text");
      expect(Number(out.rows[0].similarity)).toBeGreaterThan(0.99); // the candidate's score, not the head's 0
    });

    it("leaves non-note rows alone and does no database work when there are no note rows", async () => {
      const rows = [{ content_type: "handoff", content_id: "x.json#chunk_0", content_text: "t", metadata: {}, similarity: 0.4 }];
      const throwing = { query: () => { throw new Error("should not query"); } } as any;
      const out = await redirectNoteRows(throwing, rows, { includeSuperseded: false, includeExpired: false });
      expect(out.rows).toBe(rows);
      expect(out.notices).toEqual([]);
    });
  });

  // ── search_context THROUGH THE TOOL (embedding + reranker stubs) ─

  describe("search_context through the tool handler", () => {
    beforeEach(async () => {
      stub.rerankMode = "identity";
      stub.lastRerank = null;
      await client.query("DELETE FROM embeddings");
    });

    const searchContext = (args: Record<string, unknown>) =>
      callTool("search_context", { content_types: ["note"], similarity_threshold: 0.05, ...args });

    it("redirects a superseded hit to its successor: matched_via, a kept notice, redirected, and a cite-the-successor next_step", async () => {
      const a = await mkNote({ title: "Release train old", content: "Releases ship on the kestrelfrost train every Friday." });
      const b = await mkNote({ title: "Release train current", content: "Releases ship continuously from the main branch." });
      await supersede(a.id, b.id);

      const res = await searchContext({ query: "kestrelfrost" });

      expect(res.error).toBeUndefined();
      const ids = res.results.map((r: any) => r.content_id);
      expect(ids).toContain(b.id);
      expect(ids).not.toContain(a.id);
      const head = res.results.find((r: any) => r.content_id === b.id);
      expect(head).toMatchObject({ note_status: "active", matched_via: [a.id], successor_title: null, superseded_by: null });
      expect(head).not.toHaveProperty("rerank_text");
      expect(res.redirected).toBe(1);
      expect(res.lifecycle_notices).toHaveLength(1);
      expect(res.lifecycle_notices[0]).toContain(`Note ${a.id.slice(0, 8)}… ('Release train old') matched but was superseded by ${b.id.slice(0, 8)}… ('Release train current')`);
      expect(res.next_step).toContain("cite the successor notes shown");
      expect(res.next_step).toContain(`Notes found (`);
    });

    it("H1: when truncation to `limit` removes the redirected head, no stale notice or redirect count remains", async () => {
      // X outranks everything on the token; A (superseded) ranks below it, and
      // its successor B inherits A's rank - so with limit=1 B is truncated.
      const x = await mkNote({ title: "Harborlight primary runbook", content: "harborlight harborlight harborlight harborlight harborlight" });
      const a = await mkNote({ title: "Escalation policy old", content: "Escalate harborlight incidents through the pager rota." });
      const b = await mkNote({ title: "Escalation policy", content: "Escalate incidents to the duty manager first." });
      await supersede(a.id, b.id);

      const wide = await searchContext({ query: "harborlight", limit: 5 });
      expect(wide.results.map((r: any) => r.content_id)).toEqual(expect.arrayContaining([x.id, b.id]));
      expect(wide.redirected).toBe(1);
      expect(wide.lifecycle_notices).toHaveLength(1);

      const narrow = await searchContext({ query: "harborlight", limit: 1 });
      expect(narrow.results.map((r: any) => r.content_id)).toEqual([x.id]);
      expect(narrow.lifecycle_notices).toEqual([]);
      expect(narrow.redirected).toBe(0);
      expect(narrow.next_step).not.toContain("successor");
      // pre_dedup_count is the candidate count before redirection/dedup/truncation
      expect(narrow.pre_dedup_count).toBeGreaterThanOrEqual(2);
    });

    it("M1: with a reranker, a redirected head is scored on the wording that matched, and stays in the results", async () => {
      stub.rerankMode = "overlap";
      const a = await mkNote({ title: "Kestrelfrost deploy runbook old", content: "Run the kestrelfrost deploy using the legacy release train." });
      const b = await mkNote({ title: "Release runbook", content: "Ship releases on Tuesdays through the glimmerwick pipeline." });
      const d = await mkNote({ title: "Deploy checklist", content: "General deploy checklist for every service, review before you deploy." });
      await supersede(a.id, b.id);

      const res = await searchContext({ query: "kestrelfrost deploy", limit: 5 });

      expect(res.reranked).toBe(true);
      const ids = res.results.map((r: any) => r.content_id);
      expect(ids.slice(0, 2)).toEqual([b.id, d.id]); // B (scored on A's wording, 1.0) ahead of D (0.5)
      expect(res.results[0].rerank_score).toBe(1);
      expect(res.results[0].matched_via).toEqual([a.id]);
      // the cross-encoder was handed the matched (old) wording, not the head's own text
      const sent = (stub.lastRerank?.texts ?? []).join("\n");
      expect(sent).toContain("legacy release train");
      expect(sent).not.toContain("glimmerwick");
      // internal field never leaks into the response
      for (const r of res.results) expect(r).not.toHaveProperty("rerank_text");
    });

    it("include_superseded returns the superseded note as itself, flagged and noticed; 'Notes found' does not list it", async () => {
      const a = await mkNote({ title: "Paging rota old", content: "Paging follows the sundial rota." });
      const b = await mkNote({ title: "Paging rota new", content: "Paging follows the duty calendar." });
      await supersede(a.id, b.id);

      const res = await searchContext({ query: "sundial", include_superseded: true });

      const row = res.results.find((r: any) => r.content_id === a.id);
      expect(row).toMatchObject({ note_status: "superseded", superseded_by: b.id, successor_title: "Paging rota new", matched_via: [] });
      expect(res.redirected).toBe(0);
      expect(res.lifecycle_notices).toHaveLength(1);
      expect(res.lifecycle_notices[0]).toContain("is superseded by");
      expect(res.next_step).not.toContain(a.id);
      expect(res.next_step).toContain("cite the successor of each");
    });

    it("include_expired returns an expired note flagged; by default it is omitted", async () => {
      const c = await mkNote({ title: "Offsite plan", content: "Offsite plan for the fennimore venue.", valid_until: "2020-01-01T00:00:00Z" });

      const hidden = await searchContext({ query: "fennimore" });
      expect(hidden.results.map((r: any) => r.content_id)).not.toContain(c.id);

      const shown = await searchContext({ query: "fennimore", include_expired: true });
      const row = shown.results.find((r: any) => r.content_id === c.id);
      expect(row).toMatchObject({ note_status: "expired", matched_via: [], valid_until: "2020-01-01T00:00:00.000Z" });
      expect(shown.lifecycle_notices).toEqual([`Note ${c.id.slice(0, 8)}… ('Offsite plan') expired on 2020-01-01.`]);
      expect(shown.next_step).toContain("do not treat them as current");
      expect(shown.next_step).not.toContain("cite the successor notes shown");
      expect(shown.next_step).not.toContain(c.id); // not offered as a prior decision
    });

    it("B1: a superseded note whose own valid_until has passed is redirected to its active successor", async () => {
      const a = await mkNote({ title: "Retention old", content: "Retention is ninety days, per the pennywhistle policy.", valid_until: "2020-03-01T00:00:00Z" });
      const b = await mkNote({ title: "Retention new", content: "Retention is thirty days." });
      await supersede(a.id, b.id);

      const res = await searchContext({ query: "pennywhistle" });

      const row = res.results.find((r: any) => r.content_id === b.id);
      expect(row).toMatchObject({ note_status: "active", matched_via: [a.id] });
      expect(res.results.map((r: any) => r.content_id)).not.toContain(a.id);
      expect(res.redirected).toBe(1);
      expect(res.lifecycle_notices[0]).toContain("showing the successor");
    });

    it("B1: with an expired successor the result is empty and the notice says there is no current version", async () => {
      const a = await mkNote({ title: "Pager old", content: "The pager is handled by the lowmoor team.", valid_until: "2020-03-01T00:00:00Z" });
      const b = await mkNote({ title: "Pager new", content: "The pager is handled by the platform team." });
      await supersede(a.id, b.id);
      expect((await callTool("update_note", { id: b.id, valid_until: "2020-09-30T00:00:00Z" })).error).toBeUndefined();

      const res = await searchContext({ query: "lowmoor" });

      expect(res.results).toEqual([]);
      expect(res.total).toBe(0);
      expect(res.redirected).toBe(0);
      expect(res.pre_dedup_count).toBe(1); // the superseded candidate existed before redirection
      expect(res.lifecycle_notices).toHaveLength(1);
      expect(res.lifecycle_notices[0]).toContain("there is no current version to show");
      expect(res.next_step).toContain("none is current");
      expect(res.next_step).toContain("do not treat them as current");
      expect(res.next_step).not.toContain("cite the successor notes shown");
    });

    it("an empty result carries redirected: 0 and total: 0 alongside lifecycle_notices", async () => {
      const res = await searchContext({ query: "zzqxv", similarity_threshold: 0.9 });
      expect(res.results).toEqual([]);
      expect(res).toMatchObject({ total: 0, redirected: 0, lifecycle_notices: [], pre_dedup_count: 0 });
      expect(res.message).toContain("No results found");
    });

    it("M4: after/before filter the matched notes; a successor outside the window is still shown by the redirect", async () => {
      const a = await mkNote({ title: "Launch date old", content: "Launch is planned for the ravenscar window." });
      await new Promise((r) => setTimeout(r, 120));
      // Take the cut-off from the database clock: created_at is stamped by Postgres,
      // which may not agree with this process's clock.
      const mid = ((await client.query("SELECT clock_timestamp() AS t")).rows[0].t as Date).toISOString();
      await new Promise((r) => setTimeout(r, 120));
      const b = await mkNote({ title: "Launch date new", content: "Launch moved to the autumn." });
      await supersede(a.id, b.id);

      // The window ends before B existed, yet B is what the redirect shows.
      const res = await searchContext({ query: "ravenscar", before: mid });
      const row = res.results.find((r: any) => r.content_id === b.id);
      expect(row).toBeDefined();
      expect(row.matched_via).toEqual([a.id]);
      expect(row.metadata.created_at > mid).toBe(true);

      // include_superseded gives the historical state inside the window.
      const hist = await searchContext({ query: "ravenscar", before: mid, include_superseded: true });
      expect(hist.results.map((r: any) => r.content_id)).toEqual([a.id]);
    });

    it("M3: degrades to an unfiltered search, with a notice, when the lifecycle columns are missing (migration 013 not applied)", async () => {
      const a = await mkNote({ title: "Mirror policy", content: "Mirror policy for the oakhurst registry." });
      try {
        await client.query("ALTER TABLE notes RENAME COLUMN valid_until TO valid_until_renamed");
        const res = await searchContext({ query: "oakhurst" });

        expect(res.error).toBeUndefined();
        expect(res.results.map((r: any) => r.content_id)).toContain(a.id);
        expect(res.results[0].note_status).toBeNull();
        expect(res.lifecycle_notices).toEqual([
          "Note lifecycle filtering unavailable (migration 013 not applied); superseded/expired notes are not filtered.",
        ]);
        expect(res.redirected).toBe(0);
        // handoff-only searches never named the column, so they were never affected
        const other = await callTool("search_context", { query: "oakhurst", content_types: ["handoff"], similarity_threshold: 0.05 });
        expect(other.error).toBeUndefined();
      } finally {
        await client.query("ALTER TABLE notes RENAME COLUMN valid_until_renamed TO valid_until");
      }
      // restored: the filter is back
      const back = await searchContext({ query: "oakhurst" });
      expect(back.lifecycle_notices).toEqual([]);
      expect(back.results[0].note_status).toBe("active");
    });

    it("LOW(a): when the lifecycle lookup fails after candidates were found, results say annotations are unavailable", async () => {
      const a = await mkNote({ title: "Badge policy", content: "Badge policy for the wrenfield site." });
      try {
        // The candidate SQL never touches this column; the lifecycle lookup does.
        await client.query("ALTER TABLE notes RENAME COLUMN provenance TO provenance_renamed");
        const res = await searchContext({ query: "wrenfield" });

        expect(res.error).toBeUndefined();
        expect(res.results.map((r: any) => r.content_id)).toContain(a.id);
        expect(res.results[0].note_status).toBeNull();
        expect(res.lifecycle_notices).toHaveLength(1);
        expect(res.lifecycle_notices[0]).toContain("lifecycle annotations unavailable");
      } finally {
        await client.query("ALTER TABLE notes RENAME COLUMN provenance_renamed TO provenance");
      }
    });
  });

  // ── SQL shape guard ─────────────────────────────────────────────

  describe("SQL shape guard: the lifecycle filter is a hashed subquery on the embeddings scan (design 6.3)", () => {
    // This pins the SHAPE of the SQL we emit - `IN (subquery)` planned as a
    // hashed SubPlan filter on the embeddings scan, with `notes` read only
    // inside that SubPlan and never joined into the vector scan. It does not
    // claim a planner guarantee: whether alternative formulations (e.g. a LEFT
    // JOIN) keep the HNSW index-ordered scan depends on query shape, table
    // size and statistics, and seqscan is disabled here so the test answers a
    // structural question independent of how many rows the test table holds.
    // If this fails after a change to search.ts, the filter has been rewritten
    // away from that shape and the design 6.3 rationale needs revisiting.

    function collectNodes(plan: any, out: any[] = []): any[] {
      out.push(plan);
      for (const child of plan.Plans ?? []) collectNodes(child, out);
      return out;
    }

    async function explain(over: Partial<SearchContextSqlInput>) {
      const { sql, params } = buildSearchContextSql({
        pgVector: constVec(),
        threshold: 0.15,
        ftsQuery: "quillmoor",
        hybrid: true,
        overFetchLimit: 50,
        ...over,
      });
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL enable_seqscan = OFF");
        const res = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
        return collectNodes(res.rows[0]["QUERY PLAN"][0].Plan);
      } finally {
        await client.query("ROLLBACK");
      }
    }

    beforeAll(async () => {
      // A few rows so the planner has statistics to chew on; content is irrelevant.
      await client.query("DELETE FROM embeddings");
      for (let i = 0; i < 5; i++) {
        await insertEmbedding(client, "handoff", `explain-${i}.json#chunk_0`, `explain row ${i}`, constVec(0.01 + i * 0.001));
      }
      await client.query("ANALYZE embeddings");
    });

    it("the semantic side is an Index Scan on idx_embeddings_vector with the lifecycle subquery as a hashed SubPlan filter", async () => {
      const nodes = await explain({});

      const hnsw = nodes.filter((n) => n["Node Type"] === "Index Scan" && n["Index Name"] === "idx_embeddings_vector");
      expect(hnsw.length, "HNSW index scan present").toBeGreaterThanOrEqual(1);

      const filtered = hnsw.find((n) => typeof n["Filter"] === "string" && n["Filter"].includes("SubPlan"));
      expect(filtered, "HNSW scan carries the lifecycle subquery as a filter").toBeDefined();
      expect(filtered!["Filter"]).toMatch(/hashed SubPlan/);
      expect(filtered!["Filter"]).toContain("'note'");

      // The subquery reads `notes`, and that read is a SubPlan - not a join node feeding the vector scan.
      const subPlans = nodes.filter((n) => n["Parent Relationship"] === "SubPlan" && n["Relation Name"] === "notes");
      expect(subPlans.length).toBeGreaterThanOrEqual(1);
      const joins = nodes.filter((n) => /Join|Nested Loop/.test(n["Node Type"]));
      // the only join in the whole statement is the CTE-level LEFT JOIN semantic/fulltext
      for (const j of joins) {
        const inputs = collectNodes(j).filter((n) => n["Relation Name"] === "notes" && n["Parent Relationship"] !== "SubPlan");
        expect(inputs, "notes must not be joined into the vector scan").toHaveLength(0);
      }
    });

    it("the same shape holds with include_expired (predicate TRUE)", async () => {
      const nodes = await explain({ includeExpired: true });
      const filtered = nodes.find(
        (n) => n["Node Type"] === "Index Scan" && n["Index Name"] === "idx_embeddings_vector" && String(n["Filter"] ?? "").includes("hashed SubPlan")
      );
      expect(filtered).toBeDefined();
    });

    it("with a content_types filter the lifecycle subquery is still a hashed SubPlan filter on the embeddings scan", async () => {
      // A content_type filter gives the planner a second valid access path
      // (idx_embeddings_content_type + sort), and on a handful of rows it may
      // price that below the HNSW scan. That choice is independent of the
      // lifecycle filter, so here we only assert the filter is applied as a
      // hashed subquery on whichever embeddings scan the planner picked.
      const nodes = await explain({ contentTypes: ["note", "handoff"] });
      const scans = nodes.filter((n) => n["Relation Name"] === "embeddings" && /Scan/.test(n["Node Type"]) && n["Parent Relationship"] !== "SubPlan");
      expect(scans.length).toBeGreaterThanOrEqual(1);
      expect(scans.some((n) => String(n["Filter"] ?? "").includes("hashed SubPlan"))).toBe(true);
    });

    it("a handoff-only search plans without any SubPlan on notes", async () => {
      const nodes = await explain({ contentTypes: ["handoff"] });
      expect(nodes.some((n) => n["Relation Name"] === "notes")).toBe(false);
    });
  });
});
