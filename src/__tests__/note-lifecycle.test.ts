import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Note lifecycle tool integration tests: provenance, valid_until, version
 * history, expected_version preconditions, supersede_note, delete-time chain
 * splice, get_note_history, prune_note_history.
 *
 * Design: docs/design/note-lifecycle.md. Requires a running PostgreSQL
 * instance (see notes.test.ts / tasks.test.ts); the suite skips gracefully
 * when Postgres is not available. All content is fictional.
 */

const TEST_PORT = 3192;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_DATA_DIR = join(process.cwd(), "data", "test-note-lifecycle");

const PG_DATABASE = "cl_test_note_lifecycle";
const PG_USER = process.env.PGUSER ?? "cl";
const PG_PASSWORD = process.env.PGPASSWORD ?? "test";
const PG_HOST = process.env.PGHOST ?? "localhost";
const PG_PORT = process.env.PGPORT ?? "5432";

const MISSING_ID = "00000000-0000-0000-0000-000000000000";

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

    // Ensure the test database exists — connect to default 'postgres' first.
    const admin = new pg.default.Client({
      host: PG_HOST,
      port: parseInt(PG_PORT),
      user: PG_USER,
      password: PG_PASSWORD,
      database: "postgres",
    });
    await admin.connect();
    const exists = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [PG_DATABASE]
    );
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
  console.log("  Note Lifecycle suite will be SKIPPED");
  console.log("=".repeat(60) + "\n");
}

/** Create a note and return the full created-note response. */
async function mkNote(overrides: Record<string, unknown> = {}) {
  const created = await callTool("create_note", {
    title: "Acme Corp deploy schedule",
    content: "Acme Corp deploys on Fridays.",
    scope: "work",
    provenance: "stated",
    ...overrides,
  });
  expect(created.error).toBeUndefined();
  return created as { id: string; title: string; version: number; [key: string]: any };
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe.skipIf(!pgAvailable)("Note Lifecycle", () => {
  beforeAll(async () => {
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
    await mkdir(TEST_DATA_DIR, { recursive: true });

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
        // Fire-and-forget indexing runs after every note write. Point it at a
        // closed loopback port so it fails fast (ECONNREFUSED -> pending
        // queue) instead of resolving the default "embeddings" hostname, whose
        // DNS lookup can stall the libuv threadpool for seconds on some hosts
        // and starve the server's Postgres connection attempts.
        EMBEDDING_URL: "http://127.0.0.1:1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });

    // Uncomment for debugging:
    // serverProcess.stderr?.on("data", (d) => process.stderr.write(d));
    // serverProcess.stdout?.on("data", (d) => process.stdout.write(d));

    await waitForServer(BASE_URL);
  }, 30_000);

  afterAll(async () => {
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
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it("lifecycle tools appear in tools/list", async () => {
    const res = await mcpPost(jsonrpc("tools/list"));
    const data = (await parseSseResponse(res)) as any;
    const toolNames: string[] = data.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain("supersede_note");
    expect(toolNames).toContain("get_note_history");
    expect(toolNames).toContain("prune_note_history");

    const history = data.result.tools.find((t: any) => t.name === "get_note_history");
    expect(history.description).toContain("CALL THIS WHEN");
    expect(history.description).toContain("DO NOT CALL WHEN");
    expect(history.description).toContain("CONSEQUENCE OF SKIPPING");
  });

  // ── create_note: provenance + valid_until ─────────────────────

  describe("create_note provenance and valid_until", () => {
    it("echoes provenance and valid_until and starts at version 1", async () => {
      const result = await callTool("create_note", {
        title: "Acme Corp freeze window",
        content: "Deploys are frozen until the audit completes.",
        scope: "work",
        provenance: "decided",
        valid_until: "2099-12-31T00:00:00Z",
      });

      expect(result.error).toBeUndefined();
      expect(result.version).toBe(1);
      expect(result.status).toBe("active");
      expect(result.provenance).toBe("decided");
      expect(Date.parse(result.valid_until)).toBe(Date.parse("2099-12-31T00:00:00Z"));

      const fetched = await callTool("get_note", { id: result.id });
      expect(fetched.provenance).toBe("decided");
      expect(Date.parse(fetched.valid_until)).toBe(Date.parse("2099-12-31T00:00:00Z"));
      expect(fetched.version).toBe(1);
    });

    it("normalises a non-UTC offset to the same instant", async () => {
      const result = await mkNote({ valid_until: "2099-06-01T12:00:00+02:00" });
      expect(Date.parse(result.valid_until)).toBe(Date.parse("2099-06-01T10:00:00Z"));
    });

    it("rejects valid_until without an explicit offset", async () => {
      for (const bad of ["2099-12-31T00:00:00", "2099-12-31", "next friday", ""]) {
        const result = await callTool("create_note", {
          title: "Bad expiry",
          content: "content",
          scope: "work",
          valid_until: bad,
        });
        expect(result.error).toBe(true);
        expect(result.code).toBe("VALIDATION_ERROR");
        expect(result.message).toContain("valid_until");
      }
    });

    it("accepts a past valid_until and reports the note as expired", async () => {
      const result = await mkNote({ valid_until: "2020-01-01T00:00:00Z" });
      expect(result.status).toBe("expired");
    });

    it("includes a provenance hint only when provenance was omitted", async () => {
      const without = await callTool("create_note", {
        title: "No provenance",
        content: "Unattributed knowledge.",
        scope: "work",
      });
      expect(without.error).toBeUndefined();
      expect(typeof without.hint).toBe("string");
      expect(without.provenance).toBeNull();

      const withProv = await callTool("create_note", {
        title: "With provenance",
        content: "Attributed knowledge.",
        scope: "work",
        provenance: "inferred",
      });
      expect(withProv.error).toBeUndefined();
      expect(withProv.hint).toBeUndefined();
      expect(withProv.provenance).toBe("inferred");
    });

    it("rejects an unknown provenance value", async () => {
      const res = await mcpPost(
        jsonrpc("tools/call", {
          name: "create_note",
          arguments: { title: "t", content: "c", scope: "work", provenance: "guessed" },
        })
      );
      const data = (await parseSseResponse(res)) as any;
      // Schema validation failure surfaces as an MCP error result, never a created note.
      const text: string = data.result?.content?.[0]?.text ?? JSON.stringify(data.error ?? {});
      expect(data.result?.isError === true || data.error !== undefined).toBe(true);
      expect(text).not.toContain('"version"');
    });
  });

  // ── get_note: lifecycle fields ─────────────────────────────────

  describe("get_note lifecycle fields", () => {
    it("returns status, version, provenance, successor and supersedes on a fresh note", async () => {
      const created = await mkNote({ provenance: "fetched", source_url: "https://example.com/post" });
      const note = await callTool("get_note", { id: created.id });
      expect(note.status).toBe("active");
      expect(note.version).toBe(1);
      expect(note.provenance).toBe("fetched");
      expect(note.superseded_by).toBeNull();
      expect(note.superseded_at).toBeNull();
      expect(note.valid_until).toBeNull();
      expect(note.successor).toBeNull();
      expect(note.supersedes).toEqual([]);
    });

    it("reports an expired note as expired and revives it when valid_until is cleared", async () => {
      const created = await mkNote({ valid_until: "2020-01-01T00:00:00Z" });
      const expired = await callTool("get_note", { id: created.id });
      expect(expired.status).toBe("expired");

      const revived = await callTool("update_note", { id: created.id, valid_until: null });
      expect(revived.error).toBeUndefined();
      expect(revived.status).toBe("active");
      expect(revived.valid_until).toBeNull();
      expect(revived.version).toBe(2);
    });
  });

  // ── update_note: versions, history, preconditions ──────────────

  describe("update_note versioning", () => {
    it("bumps version and records the prior content in history", async () => {
      const created = await mkNote({ content: "Original wording." });

      const updated = await callTool("update_note", {
        id: created.id,
        content: "Revised wording.",
      });
      expect(updated.error).toBeUndefined();
      expect(updated.changed).toBe(true);
      expect(updated.version).toBe(2);
      expect(updated.content).toBe("Revised wording.");

      const history = await callTool("get_note_history", { id: created.id });
      expect(history.error).toBeUndefined();
      expect(history.current_version).toBe(2);
      expect(history.total_entries).toBe(2);
      expect(history.entries).toHaveLength(2);

      const [current, prior] = history.entries;
      expect(current.is_current).toBe(true);
      expect(current.version).toBe(2);
      expect(current.content).toBe("Revised wording.");
      expect(current.changed_fields).toEqual([]);
      expect(current.changed_via).toBeNull();

      expect(prior.is_current).toBe(false);
      expect(prior.version).toBe(1);
      expect(prior.content).toBe("Original wording.");
      expect(prior.title).toBe(created.title);
      expect(prior.changed_fields).toEqual(["content"]);
      expect(prior.changed_via).toBe("update_note");
      expect(prior.status).toBe("active");
      expect(prior.provenance).toBe("stated");
      expect(typeof prior.changed_at).toBe("string");
    });

    it("versions a tag-only edit", async () => {
      const created = await mkNote({ tags: ["deploys"] });
      const updated = await callTool("update_note", {
        id: created.id,
        tags: ["deploys", "calendar"],
      });
      expect(updated.changed).toBe(true);
      expect(updated.version).toBe(2);

      const history = await callTool("get_note_history", { id: created.id });
      const prior = history.entries[1];
      expect(prior.version).toBe(1);
      expect(prior.tags).toEqual(["deploys"]);
      expect(prior.changed_fields).toEqual(["tags"]);
    });

    it("records provenance and valid_until edits as versioned changes", async () => {
      const created = await mkNote({ provenance: "inferred" });
      const upgraded = await callTool("update_note", {
        id: created.id,
        provenance: "decided",
        valid_until: "2099-01-01T00:00:00Z",
      });
      expect(upgraded.provenance).toBe("decided");
      expect(Date.parse(upgraded.valid_until)).toBe(Date.parse("2099-01-01T00:00:00Z"));
      expect(upgraded.version).toBe(2);

      const cleared = await callTool("update_note", {
        id: created.id,
        provenance: null,
        valid_until: null,
      });
      expect(cleared.provenance).toBeNull();
      expect(cleared.valid_until).toBeNull();
      expect(cleared.version).toBe(3);

      const history = await callTool("get_note_history", { id: created.id });
      expect(history.entries.map((e: any) => e.version)).toEqual([3, 2, 1]);
      expect(history.entries[1].provenance).toBe("decided");
      expect(Date.parse(history.entries[1].valid_until)).toBe(Date.parse("2099-01-01T00:00:00Z"));
      expect(history.entries[2].provenance).toBe("inferred");
      expect(history.entries[2].valid_until).toBeNull();
      expect(history.entries[1].changed_fields).toEqual(["provenance", "valid_until"]);
    });

    it("treats an edit that changes nothing as a true no-op", async () => {
      const created = await mkNote({ title: "Stable title" });
      const before = await callTool("get_note", { id: created.id });

      const noop = await callTool("update_note", { id: created.id, title: "Stable title" });
      expect(noop.error).toBeUndefined();
      expect(noop.changed).toBe(false);
      expect(noop.version).toBe(1);
      expect(noop.updated_at).toBe(before.updated_at);

      const history = await callTool("get_note_history", { id: created.id });
      expect(history.total_entries).toBe(1);
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0].is_current).toBe(true);
    });

    it("returns VALIDATION_ERROR when only expected_version is supplied", async () => {
      const created = await mkNote();
      const result = await callTool("update_note", { id: created.id, expected_version: 1 });
      expect(result.error).toBe(true);
      expect(result.code).toBe("VALIDATION_ERROR");
      expect(result.message).toBe("No updates provided");
    });

    it("rejects a valid_until without an offset", async () => {
      const created = await mkNote();
      const result = await callTool("update_note", {
        id: created.id,
        valid_until: "2099-12-31T00:00:00",
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("VALIDATION_ERROR");
      const fetched = await callTool("get_note", { id: created.id });
      expect(fetched.version).toBe(1);
    });

    it("does not accept lifecycle fields: status is ignored and nothing is written", async () => {
      const created = await mkNote();
      const other = await mkNote({ title: "Would-be successor" });
      const result = await callTool("update_note", {
        id: created.id,
        status: "superseded",
        superseded_by: other.id,
      });
      // Unknown keys are stripped by schema validation, leaving no updates.
      expect(result.error).toBe(true);
      expect(result.code).toBe("VALIDATION_ERROR");
      const fetched = await callTool("get_note", { id: created.id });
      expect(fetched.status).toBe("active");
      expect(fetched.superseded_by).toBeNull();
      expect(fetched.version).toBe(1);
    });

    it("returns NOT_FOUND for a non-existent note", async () => {
      const result = await callTool("update_note", { id: MISSING_ID, title: "anything" });
      expect(result.error).toBe(true);
      expect(result.code).toBe("NOT_FOUND");
    });

    it("returns NOT_FOUND (not a conflict) when expected_version is set on a missing note", async () => {
      const result = await callTool("update_note", {
        id: MISSING_ID,
        title: "anything",
        expected_version: 1,
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("NOT_FOUND");
    });
  });

  describe("update_note expected_version", () => {
    it("returns VERSION_CONFLICT with the current note when the version is stale", async () => {
      const created = await mkNote({ content: "First draft." });
      await callTool("update_note", { id: created.id, content: "Second draft." });

      const stale = await callTool("update_note", {
        id: created.id,
        content: "Overwrite attempt.",
        expected_version: 1,
      });
      expect(stale.error).toBe(true);
      expect(stale.code).toBe("VERSION_CONFLICT");
      expect(typeof stale.message).toBe("string");
      expect(stale.current.id).toBe(created.id);
      expect(stale.current.version).toBe(2);
      expect(stale.current.content).toBe("Second draft.");

      // Nothing was written.
      const fetched = await callTool("get_note", { id: created.id });
      expect(fetched.content).toBe("Second draft.");
      expect(fetched.version).toBe(2);
    });

    it("applies the edit when expected_version matches", async () => {
      const created = await mkNote({ content: "Draft one." });
      const result = await callTool("update_note", {
        id: created.id,
        content: "Draft two.",
        expected_version: 1,
      });
      expect(result.error).toBeUndefined();
      expect(result.version).toBe(2);
      expect(result.content).toBe("Draft two.");

      const again = await callTool("update_note", {
        id: created.id,
        content: "Draft three.",
        expected_version: 2,
      });
      expect(again.error).toBeUndefined();
      expect(again.version).toBe(3);
    });

    it("enforces expected_version even when the edit would be a no-op", async () => {
      const created = await mkNote({ title: "Same title" });
      await callTool("update_note", { id: created.id, content: "Moved on." });
      const result = await callTool("update_note", {
        id: created.id,
        title: "Same title",
        expected_version: 1,
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("VERSION_CONFLICT");
    });

    it("lets exactly one of two concurrent edits with the same expected_version win", async () => {
      const created = await mkNote({ content: "Baseline." });

      const results = await Promise.all([
        callTool("update_note", { id: created.id, content: "Writer A.", expected_version: 1 }),
        callTool("update_note", { id: created.id, content: "Writer B.", expected_version: 1 }),
      ]);

      const conflicts = results.filter((r) => r.error === true && r.code === "VERSION_CONFLICT");
      const winners = results.filter((r) => r.error === undefined);
      expect(conflicts, JSON.stringify(results)).toHaveLength(1);
      expect(winners, JSON.stringify(results)).toHaveLength(1);
      expect(winners[0].version).toBe(2);
      expect(conflicts[0].current.version).toBe(2);

      const final = await callTool("get_note", { id: created.id });
      expect(final.version).toBe(2);
      expect(final.content).toBe(winners[0].content);

      // Exactly one history row: the baseline.
      const history = await callTool("get_note_history", { id: created.id });
      expect(history.total_entries).toBe(2);
      expect(history.entries[1].content).toBe("Baseline.");
    });
  });

  // ── supersede_note ─────────────────────────────────────────────

  describe("supersede_note", () => {
    it("marks the old note superseded and links the chain", async () => {
      const old = await mkNote({
        title: "Acme Corp Friday deploys",
        content: "Acme Corp deploys on Fridays.",
      });
      const successor = await mkNote({
        title: "Acme Corp deploy freeze",
        content: "Acme Corp froze Friday deploys.",
      });

      const result = await callTool("supersede_note", {
        id: old.id,
        superseded_by: successor.id,
      });
      expect(result.error).toBeUndefined();
      expect(result.superseded.id).toBe(old.id);
      expect(result.superseded.title).toBe("Acme Corp Friday deploys");
      expect(result.superseded.version).toBe(2);
      expect(result.superseded.superseded_by).toBe(successor.id);
      expect(typeof result.superseded.superseded_at).toBe("string");
      expect(result.successor).toEqual({ id: successor.id, title: "Acme Corp deploy freeze" });

      const oldNote = await callTool("get_note", { id: old.id });
      expect(oldNote.status).toBe("superseded");
      expect(oldNote.superseded_by).toBe(successor.id);
      expect(oldNote.superseded_at).toBe(result.superseded.superseded_at);
      expect(oldNote.successor).toEqual({ id: successor.id, title: "Acme Corp deploy freeze" });
      // The superseded note keeps its content.
      expect(oldNote.content).toBe("Acme Corp deploys on Fridays.");
      expect(oldNote.id).toBe(old.id);

      const successorNote = await callTool("get_note", { id: successor.id });
      expect(successorNote.status).toBe("active");
      expect(successorNote.supersedes).toEqual([old.id]);
      expect(successorNote.version).toBe(1);

      const history = await callTool("get_note_history", { id: old.id });
      const prior = history.entries[1];
      expect(prior.status).toBe("active");
      expect(prior.changed_via).toBe("supersede_note");
      expect(prior.changed_fields).toEqual(["status", "superseded_at", "superseded_by"]);
    });

    it("rejects a note superseding itself with INVALID_SUCCESSOR", async () => {
      const note = await mkNote();
      const result = await callTool("supersede_note", { id: note.id, superseded_by: note.id });
      expect(result.error).toBe(true);
      expect(result.code).toBe("INVALID_SUCCESSOR");
      expect(result.current.id).toBe(note.id);
      const fetched = await callTool("get_note", { id: note.id });
      expect(fetched.status).toBe("active");
    });

    it("returns STATUS_CONFLICT when the note is already superseded", async () => {
      const old = await mkNote({ title: "Old fact" });
      const first = await mkNote({ title: "First replacement" });
      const second = await mkNote({ title: "Second replacement" });
      await callTool("supersede_note", { id: old.id, superseded_by: first.id });

      const result = await callTool("supersede_note", { id: old.id, superseded_by: second.id });
      expect(result.error).toBe(true);
      expect(result.code).toBe("STATUS_CONFLICT");
      expect(result.current.status).toBe("superseded");
      expect(result.current.superseded_by).toBe(first.id);
    });

    it("rejects an expired successor with INVALID_SUCCESSOR", async () => {
      const old = await mkNote({ title: "Live fact" });
      const expired = await mkNote({
        title: "Lapsed fact",
        valid_until: "2020-01-01T00:00:00Z",
      });

      const result = await callTool("supersede_note", { id: old.id, superseded_by: expired.id });
      expect(result.error).toBe(true);
      expect(result.code).toBe("INVALID_SUCCESSOR");
      expect(result.message).toContain("expired");
      expect(result.successor.id).toBe(expired.id);
      expect(result.current.id).toBe(old.id);

      const fetched = await callTool("get_note", { id: old.id });
      expect(fetched.status).toBe("active");
    });

    it("rejects an already-superseded successor with INVALID_SUCCESSOR", async () => {
      const old = await mkNote({ title: "Oldest fact" });
      const middle = await mkNote({ title: "Middle fact" });
      const newest = await mkNote({ title: "Newest fact" });
      await callTool("supersede_note", { id: middle.id, superseded_by: newest.id });

      const result = await callTool("supersede_note", { id: old.id, superseded_by: middle.id });
      expect(result.error).toBe(true);
      expect(result.code).toBe("INVALID_SUCCESSOR");
      expect(result.message).toContain("superseded");
    });

    it("returns NOT_FOUND naming the missing successor", async () => {
      const old = await mkNote();
      const result = await callTool("supersede_note", { id: old.id, superseded_by: MISSING_ID });
      expect(result.error).toBe(true);
      expect(result.code).toBe("NOT_FOUND");
      expect(result.message).toContain(MISSING_ID);
      expect(result.message.toLowerCase()).toContain("successor");

      const fetched = await callTool("get_note", { id: old.id });
      expect(fetched.status).toBe("active");
    });

    it("returns NOT_FOUND naming the missing old note", async () => {
      const successor = await mkNote();
      const result = await callTool("supersede_note", { id: MISSING_ID, superseded_by: successor.id });
      expect(result.error).toBe(true);
      expect(result.code).toBe("NOT_FOUND");
      expect(result.message).toContain(MISSING_ID);
      expect(result.message.toLowerCase()).not.toContain("successor");
    });

    it("honours expected_version on the old note", async () => {
      const old = await mkNote({ content: "Before." });
      const successor = await mkNote({ title: "Replacement" });
      await callTool("update_note", { id: old.id, content: "After." });

      const stale = await callTool("supersede_note", {
        id: old.id,
        superseded_by: successor.id,
        expected_version: 1,
      });
      expect(stale.error).toBe(true);
      expect(stale.code).toBe("VERSION_CONFLICT");
      expect(stale.current.version).toBe(2);

      const ok = await callTool("supersede_note", {
        id: old.id,
        superseded_by: successor.id,
        expected_version: 2,
      });
      expect(ok.error).toBeUndefined();
      expect(ok.superseded.version).toBe(3);
    });

    it("still allows editing a superseded note without changing its status", async () => {
      const old = await mkNote({ title: "Retired note" });
      const successor = await mkNote({ title: "Current note" });
      await callTool("supersede_note", { id: old.id, superseded_by: successor.id });

      const edited = await callTool("update_note", { id: old.id, tags: ["archived"] });
      expect(edited.error).toBeUndefined();
      expect(edited.status).toBe("superseded");
      expect(edited.superseded_by).toBe(successor.id);
      expect(edited.version).toBe(3);
    });
  });

  // ── get_note_history ───────────────────────────────────────────

  describe("get_note_history", () => {
    async function noteAtVersion4() {
      const created = await mkNote({ content: "rev 1" });
      await callTool("update_note", { id: created.id, content: "rev 2" });
      await callTool("update_note", { id: created.id, content: "rev 3" });
      await callTool("update_note", { id: created.id, content: "rev 4" });
      return created;
    }

    it("returns entries newest-first with the current version as entry 0", async () => {
      const created = await noteAtVersion4();
      const history = await callTool("get_note_history", { id: created.id });

      expect(history.id).toBe(created.id);
      expect(history.current_version).toBe(4);
      expect(history.total_entries).toBe(4);
      expect(history.limit).toBe(10);
      expect(history.offset).toBe(0);
      expect(history.entries.map((e: any) => e.version)).toEqual([4, 3, 2, 1]);
      expect(history.entries.map((e: any) => e.content)).toEqual(["rev 4", "rev 3", "rev 2", "rev 1"]);
      expect(history.entries.map((e: any) => e.is_current)).toEqual([true, false, false, false]);
      for (const e of history.entries.slice(1)) {
        expect(e.changed_fields).toEqual(["content"]);
        expect(e.changed_via).toBe("update_note");
      }
    });

    it("pages with limit and offset counted from entry 0", async () => {
      const created = await noteAtVersion4();
      const versions = async (args: Record<string, unknown>) => {
        const h = await callTool("get_note_history", { id: created.id, ...args });
        expect(h.error).toBeUndefined();
        expect(h.total_entries).toBe(4);
        return h.entries.map((e: any) => e.version);
      };

      expect(await versions({ limit: 2 })).toEqual([4, 3]);
      expect(await versions({ limit: 2, offset: 1 })).toEqual([3, 2]);
      expect(await versions({ limit: 2, offset: 2 })).toEqual([2, 1]);
      expect(await versions({ limit: 2, offset: 3 })).toEqual([1]);
      expect(await versions({ limit: 1 })).toEqual([4]);
      expect(await versions({ limit: 1, offset: 1 })).toEqual([3]);
      expect(await versions({ offset: 4 })).toEqual([]);
    });

    it("returns only the current entry for a never-edited note", async () => {
      const created = await mkNote();
      const history = await callTool("get_note_history", { id: created.id });
      expect(history.total_entries).toBe(1);
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0].is_current).toBe(true);
      expect(history.entries[0].version).toBe(1);
    });

    it("returns NOT_FOUND for a non-existent note", async () => {
      const result = await callTool("get_note_history", { id: MISSING_ID });
      expect(result.error).toBe(true);
      expect(result.code).toBe("NOT_FOUND");
    });
  });

  // ── list_notes: status filter ──────────────────────────────────

  describe("list_notes status", () => {
    it("filters by computed status and returns every status by default", async () => {
      const domain = `lifecycle-list-${Date.now()}`;
      const active = await mkNote({ title: "Listed active", domain });
      const retired = await mkNote({ title: "Listed superseded", domain });
      const lapsed = await mkNote({
        title: "Listed expired",
        domain,
        valid_until: "2020-01-01T00:00:00Z",
      });
      await callTool("supersede_note", { id: retired.id, superseded_by: active.id });

      const idsFor = async (args: Record<string, unknown>) => {
        const res = await callTool("list_notes", { domain, ...args });
        expect(res.error).toBeUndefined();
        return {
          ids: new Set<string>(res.notes.map((n: any) => n.id)),
          notes: res.notes as any[],
          total: res.total_count as number,
        };
      };

      const onlyActive = await idsFor({ status: "active" });
      expect(onlyActive.ids).toEqual(new Set([active.id]));
      expect(onlyActive.total).toBe(1);

      const onlySuperseded = await idsFor({ status: "superseded" });
      expect(onlySuperseded.ids).toEqual(new Set([retired.id]));
      expect(onlySuperseded.notes[0].superseded_by).toBe(active.id);

      const onlyExpired = await idsFor({ status: "expired" });
      expect(onlyExpired.ids).toEqual(new Set([lapsed.id]));
      expect(onlyExpired.notes[0].valid_until).toBeTruthy();

      const all = await idsFor({});
      expect(all.ids).toEqual(new Set([active.id, retired.id, lapsed.id]));
      expect(all.total).toBe(3);
      const byId = new Map(all.notes.map((n: any) => [n.id, n]));
      expect(byId.get(active.id).status).toBe("active");
      expect(byId.get(retired.id).status).toBe("superseded");
      expect(byId.get(lapsed.id).status).toBe("expired");
      for (const n of all.notes) {
        expect(n.content).toBeUndefined();
        expect(n.version).toBeGreaterThanOrEqual(1);
        expect("provenance" in n).toBe(true);
        expect("superseded_by" in n).toBe(true);
        expect("valid_until" in n).toBe(true);
      }
    });
  });

  // ── delete_note: chain splice ──────────────────────────────────

  describe("delete_note chain splice", () => {
    it("reports an empty relinked list for a note outside any chain", async () => {
      const note = await mkNote();
      const result = await callTool("delete_note", { id: note.id });
      expect(result.deleted).toBe(true);
      expect(result.id).toBe(note.id);
      expect(result.relinked).toEqual([]);
    });

    it("reactivates the predecessor when the deleted successor ends the chain", async () => {
      const a = await mkNote({ title: "Chain A" });
      const b = await mkNote({ title: "Chain B" });
      await callTool("supersede_note", { id: a.id, superseded_by: b.id });
      expect((await callTool("get_note", { id: a.id })).status).toBe("superseded");

      const result = await callTool("delete_note", { id: b.id });
      expect(result.deleted).toBe(true);
      expect(result.relinked).toEqual([{ id: a.id, status: "active", superseded_by: null }]);

      const revived = await callTool("get_note", { id: a.id });
      expect(revived.status).toBe("active");
      expect(revived.superseded_by).toBeNull();
      expect(revived.superseded_at).toBeNull();
      expect(revived.successor).toBeNull();
      // supersede (v2) then reactivate (v3), both versioned.
      expect(revived.version).toBe(3);

      const history = await callTool("get_note_history", { id: a.id });
      expect(history.entries[1].status).toBe("superseded");
      expect(history.entries[1].changed_via).toBe("delete_note");

      expect((await callTool("get_note", { id: b.id })).code).toBe("NOT_FOUND");
    });

    it("re-points the predecessor to the next note when a middle note is deleted", async () => {
      const a = await mkNote({ title: "Splice A" });
      const b = await mkNote({ title: "Splice B" });
      const c = await mkNote({ title: "Splice C" });
      await callTool("supersede_note", { id: a.id, superseded_by: b.id });
      const supersededA = await callTool("get_note", { id: a.id });
      await callTool("supersede_note", { id: b.id, superseded_by: c.id });

      const result = await callTool("delete_note", { id: b.id });
      expect(result.deleted).toBe(true);
      expect(result.relinked).toEqual([{ id: a.id, status: "superseded", superseded_by: c.id }]);

      const afterA = await callTool("get_note", { id: a.id });
      expect(afterA.status).toBe("superseded");
      expect(afterA.superseded_by).toBe(c.id);
      expect(afterA.successor.id).toBe(c.id);
      // superseded_at records when the knowledge stopped being current; the
      // re-point is bookkeeping and must not move it.
      expect(afterA.superseded_at).toBe(supersededA.superseded_at);

      const afterC = await callTool("get_note", { id: c.id });
      expect(afterC.supersedes).toEqual([a.id]);
      expect(afterC.status).toBe("active");
    });

    it("lists every predecessor when a note that superseded several is deleted", async () => {
      const first = await mkNote({ title: "Fan-in first" });
      const second = await mkNote({ title: "Fan-in second" });
      const head = await mkNote({ title: "Fan-in head" });
      await callTool("supersede_note", { id: first.id, superseded_by: head.id });
      await callTool("supersede_note", { id: second.id, superseded_by: head.id });

      const successor = await callTool("get_note", { id: head.id });
      expect(new Set(successor.supersedes)).toEqual(new Set([first.id, second.id]));

      const result = await callTool("delete_note", { id: head.id });
      expect(result.relinked).toHaveLength(2);
      expect(new Set(result.relinked.map((r: any) => r.id))).toEqual(new Set([first.id, second.id]));
      for (const r of result.relinked) {
        expect(r.status).toBe("active");
        expect(r.superseded_by).toBeNull();
      }
    });

    it("deleting a predecessor leaves the successor active and shrinks supersedes", async () => {
      const old = await mkNote({ title: "Deleted predecessor" });
      const successor = await mkNote({ title: "Surviving successor" });
      await callTool("supersede_note", { id: old.id, superseded_by: successor.id });

      const result = await callTool("delete_note", { id: old.id });
      expect(result.deleted).toBe(true);
      expect(result.relinked).toEqual([]);

      const fetched = await callTool("get_note", { id: successor.id });
      expect(fetched.status).toBe("active");
      expect(fetched.supersedes).toEqual([]);
    });

    it("removes the version history together with the note", async () => {
      const note = await mkNote({ content: "v1" });
      await callTool("update_note", { id: note.id, content: "v2" });
      await callTool("delete_note", { id: note.id });
      const history = await callTool("get_note_history", { id: note.id });
      expect(history.error).toBe(true);
      expect(history.code).toBe("NOT_FOUND");
    });
  });

  // ── prune_note_history ─────────────────────────────────────────

  describe("prune_note_history", () => {
    async function noteWithFourPriorVersions() {
      const created = await mkNote({ content: "p1" });
      for (const rev of ["p2", "p3", "p4", "p5"]) {
        await callTool("update_note", { id: created.id, content: rev });
      }
      return created; // current version 5, history v1..v4
    }

    it("purges all history with keep_last 0 and leaves the note intact", async () => {
      const created = await noteWithFourPriorVersions();

      const result = await callTool("prune_note_history", { id: created.id, keep_last: 0 });
      expect(result.error).toBeUndefined();
      expect(result.id).toBe(created.id);
      expect(result.current_version).toBe(5);
      expect(result.deleted).toBe(4);
      expect(result.remaining).toBe(0);

      const history = await callTool("get_note_history", { id: created.id });
      expect(history.total_entries).toBe(1);
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0].is_current).toBe(true);
      expect(history.entries[0].content).toBe("p5");

      const note = await callTool("get_note", { id: created.id });
      expect(note.version).toBe(5);
      expect(note.content).toBe("p5");
    });

    it("keeps the newest keep_last prior versions", async () => {
      const created = await noteWithFourPriorVersions();

      const result = await callTool("prune_note_history", { id: created.id, keep_last: 2 });
      expect(result.deleted).toBe(2);
      expect(result.remaining).toBe(2);

      const history = await callTool("get_note_history", { id: created.id });
      expect(history.total_entries).toBe(3);
      expect(history.entries.map((e: any) => e.version)).toEqual([5, 4, 3]);
      expect(history.entries.map((e: any) => e.content)).toEqual(["p5", "p4", "p3"]);

      // A later edit keeps versioning from the unchanged counter.
      const next = await callTool("update_note", { id: created.id, content: "p6" });
      expect(next.version).toBe(6);
    });

    it("is a no-op when keep_last exceeds the history length", async () => {
      const created = await noteWithFourPriorVersions();
      const result = await callTool("prune_note_history", { id: created.id, keep_last: 50 });
      expect(result.deleted).toBe(0);
      expect(result.remaining).toBe(4);
    });

    it("returns NOT_FOUND for a non-existent note", async () => {
      const result = await callTool("prune_note_history", { id: MISSING_ID, keep_last: 0 });
      expect(result.error).toBe(true);
      expect(result.code).toBe("NOT_FOUND");
    });
  });
});
