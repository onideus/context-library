import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { countOccurrences, literalReplace, appendWithNewline } from "../tools/notes.js";

/**
 * Note tool integration tests.
 *
 * Requires a running PostgreSQL instance. See tasks.test.ts for setup.
 * If Postgres is not available, the entire suite is skipped gracefully.
 */

const TEST_PORT = 3196;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_DATA_DIR = join(process.cwd(), "data", "test-notes");

const PG_DATABASE = "cl_test_notes";
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

/** Count `note:update` rows in the sync change log for one note. */
async function noteUpdateChangeCount(id: string): Promise<number> {
  const pg = await import("pg");
  const client = new pg.default.Client({
    host: PG_HOST,
    port: parseInt(PG_PORT),
    user: PG_USER,
    password: PG_PASSWORD,
    database: PG_DATABASE,
  });
  await client.connect();
  try {
    const res = await client.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM changes WHERE entity_type = 'note' AND entity_id = $1 AND op = 'update'",
      [id]
    );
    return res.rows[0].n;
  } finally {
    await client.end();
  }
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
  console.log("  Note Tools suite will be SKIPPED");
  console.log("=".repeat(60) + "\n");
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe.skipIf(!pgAvailable)("Note Tools", () => {
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
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });

    // Uncomment for debugging:
    // serverProcess.stderr?.on("data", (d) => process.stderr.write(d));
    // serverProcess.stdout?.on("data", (d) => process.stdout.write(d));

    await waitForServer(BASE_URL);
  }, 20_000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
      if (!serverProcess.killed) serverProcess.kill("SIGKILL");
    }
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it("note tools appear in tools/list", async () => {
    const res = await mcpPost(jsonrpc("tools/list"));
    const data = (await parseSseResponse(res)) as any;
    const toolNames: string[] = data.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain("create_note");
    expect(toolNames).toContain("get_note");
    expect(toolNames).toContain("list_notes");
    expect(toolNames).toContain("search_notes");
    expect(toolNames).toContain("update_note");
    expect(toolNames).toContain("delete_note");
    expect(toolNames).toContain("str_replace_note");
    expect(toolNames).toContain("append_note");
  });

  describe("create_note", () => {
    it("creates a note with all fields and returns id + title + created_at", async () => {
      const result = await callTool("create_note", {
        title: "Decision: use pgvector over FAISS",
        content: "After evaluating both, chose pgvector because the Postgres integration eliminates a separate service.",
        scope: "work",
        domain: "architecture",
        tags: ["embeddings", "infra"],
        source_url: "https://example.com/pgvector",
      });

      expect(result.error).toBeUndefined();
      expect(result.id).toBeDefined();
      expect(result.title).toBe("Decision: use pgvector over FAISS");
      expect(result.created_at).toBeDefined();
    });

    it("creates a minimal note with just title, content, scope", async () => {
      const result = await callTool("create_note", {
        title: "Minimal knowledge entry",
        content: "The smallest viable note.",
        scope: "personal",
      });

      expect(result.error).toBeUndefined();
      expect(result.id).toBeDefined();
    });

    it("returns validation error for empty title", async () => {
      const result = await callTool("create_note", {
        title: "",
        content: "content",
        scope: "personal",
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("VALIDATION_ERROR");
    });

    it("returns validation error for empty content", async () => {
      const result = await callTool("create_note", {
        title: "title",
        content: "",
        scope: "personal",
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("get_note", () => {
    it("retrieves a note with full content by ID", async () => {
      const created = await callTool("create_note", {
        title: "Note to retrieve",
        content: "The full body of the note.",
        scope: "shared",
        domain: "testing",
      });

      const result = await callTool("get_note", { id: created.id });
      expect(result.id).toBe(created.id);
      expect(result.title).toBe("Note to retrieve");
      expect(result.content).toBe("The full body of the note.");
      expect(result.scope).toBe("shared");
      expect(result.domain).toBe("testing");
    });

    it("returns NOT_FOUND for non-existent ID", async () => {
      const result = await callTool("get_note", {
        id: "00000000-0000-0000-0000-000000000000",
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("NOT_FOUND");
    });
  });

  describe("list_notes", () => {
    it("returns metadata only — not full content", async () => {
      await callTool("create_note", {
        title: "List test note",
        content: "This content should NOT appear in list output.",
        scope: "personal",
      });

      const result = await callTool("list_notes", {});
      expect(result.notes).toBeDefined();
      expect(result.total_count).toBeGreaterThan(0);
      expect(result.limit).toBe(20);
      expect(result.offset).toBe(0);
      for (const note of result.notes) {
        expect(note.content).toBeUndefined();
        expect(note.id).toBeDefined();
        expect(note.title).toBeDefined();
      }
    });

    it("filters by scope", async () => {
      await callTool("create_note", {
        title: "Work-scoped list note",
        content: "work content",
        scope: "work",
      });
      await callTool("create_note", {
        title: "Personal-scoped list note",
        content: "personal content",
        scope: "personal",
      });

      const result = await callTool("list_notes", { scope: "work" });
      for (const note of result.notes) {
        expect(note.scope).toBe("work");
      }
    });

    it("filters by domain", async () => {
      await callTool("create_note", {
        title: "Architecture note",
        content: "arch content",
        scope: "work",
        domain: "architecture-unique-xyz",
      });

      const result = await callTool("list_notes", {
        domain: "architecture-unique-xyz",
      });
      expect(result.total_count).toBeGreaterThanOrEqual(1);
      for (const note of result.notes) {
        expect(note.domain).toBe("architecture-unique-xyz");
      }
    });

    it("filters by tags with ANY-match", async () => {
      await callTool("create_note", {
        title: "Tagged note",
        content: "body",
        scope: "personal",
        tags: ["unique-note-tag-abc"],
      });

      const result = await callTool("list_notes", {
        tags: ["unique-note-tag-abc", "nonexistent"],
      });
      expect(result.total_count).toBeGreaterThanOrEqual(1);
    });

    it("respects limit and offset", async () => {
      const page1 = await callTool("list_notes", { limit: 2, offset: 0 });
      const page2 = await callTool("list_notes", { limit: 2, offset: 2 });
      expect(page1.notes.length).toBeLessThanOrEqual(2);
      expect(page2.notes.length).toBeLessThanOrEqual(2);
      if (page1.notes.length > 0 && page2.notes.length > 0) {
        expect(page1.notes[0].id).not.toBe(page2.notes[0].id);
      }
    });
  });

  describe("search_notes", () => {
    it("finds notes by keyword in title or content", async () => {
      await callTool("create_note", {
        title: "Observability patterns",
        content: "Structured logging with correlation IDs.",
        scope: "work",
      });

      const result = await callTool("search_notes", {
        query: "structured logging",
      });
      expect(result.notes.length).toBeGreaterThanOrEqual(1);
      const found = result.notes.some((n: any) =>
        n.title.includes("Observability") || n.content.includes("logging")
      );
      expect(found).toBe(true);
    });

    it("includes full content in search results (unlike list)", async () => {
      await callTool("create_note", {
        title: "Search content marker xyzqrs",
        content: "Body content for search test.",
        scope: "personal",
      });

      const result = await callTool("search_notes", { query: "xyzqrs" });
      expect(result.notes.length).toBeGreaterThanOrEqual(1);
      expect(result.notes[0].content).toBeDefined();
    });

    it("filters by scope", async () => {
      await callTool("create_note", {
        title: "Scope search marker aabbcc",
        content: "content",
        scope: "work",
      });

      const personal = await callTool("search_notes", {
        query: "aabbcc",
        scope: "personal",
      });
      expect(personal.notes.length).toBe(0);

      const work = await callTool("search_notes", {
        query: "aabbcc",
        scope: "work",
      });
      expect(work.notes.length).toBe(1);
    });

    it("returns validation error for empty query", async () => {
      const result = await callTool("search_notes", { query: "" });
      expect(result.error).toBe(true);
      expect(result.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("update_note", () => {
    it("updates field-level properties", async () => {
      const created = await callTool("create_note", {
        title: "Original title",
        content: "Original content",
        scope: "personal",
      });

      const result = await callTool("update_note", {
        id: created.id,
        title: "Updated title",
        content: "Updated content",
        domain: "new-domain",
        tags: ["updated"],
      });
      expect(result.title).toBe("Updated title");
      expect(result.content).toBe("Updated content");
      expect(result.domain).toBe("new-domain");
      expect(result.tags).toEqual(["updated"]);
    });

    it("returns NOT_FOUND for non-existent note", async () => {
      const result = await callTool("update_note", {
        id: "00000000-0000-0000-0000-000000000000",
        title: "anything",
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("NOT_FOUND");
    });

    it("returns VALIDATION_ERROR when no updates provided", async () => {
      const created = await callTool("create_note", {
        title: "Empty-update test",
        content: "content",
        scope: "personal",
      });
      const result = await callTool("update_note", { id: created.id });
      expect(result.error).toBe(true);
      expect(result.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("str_replace_note", () => {
    async function makeNote(content: string) {
      return callTool("create_note", {
        title: "Acme Corp rollout status",
        content,
        scope: "work",
      });
    }

    it("replaces a single occurrence and returns a compact response", async () => {
      const created = await makeNote("Owner: Jane Developer\nStatus: in progress\nNext: review");
      const result = await callTool("str_replace_note", {
        id: created.id,
        old_str: "Status: in progress",
        new_str: "Status: done",
      });
      expect(result.error).toBeUndefined();
      expect(result.id).toBe(created.id);
      expect(result.title).toBe("Acme Corp rollout status");
      expect(result.replacements).toBe(1);
      expect(result.updated_at).toBeDefined();
      expect(result).not.toHaveProperty("content");

      const fetched = await callTool("get_note", { id: created.id });
      expect(fetched.content).toBe("Owner: Jane Developer\nStatus: done\nNext: review");
      expect(result.content_length).toBe(fetched.content.length);
    });

    it("returns NO_MATCH without echoing content", async () => {
      const created = await makeNote("project-alpha notes");
      const result = await callTool("str_replace_note", {
        id: created.id,
        old_str: "project-beta",
        new_str: "x",
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("NO_MATCH");
      expect(result.match_count).toBe(0);
      expect(JSON.stringify(result)).not.toContain("project-alpha notes");
    });

    it("returns AMBIGUOUS_MATCH with match_count when old_str repeats", async () => {
      const created = await makeNote("TODO one\nTODO two\nTODO three");
      const result = await callTool("str_replace_note", {
        id: created.id,
        old_str: "TODO",
        new_str: "DONE",
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("AMBIGUOUS_MATCH");
      expect(result.match_count).toBe(3);

      const fetched = await callTool("get_note", { id: created.id });
      expect(fetched.content).toBe("TODO one\nTODO two\nTODO three");
    });

    it("replace_all replaces every occurrence and reports the count", async () => {
      const created = await makeNote("TODO one\nTODO two\nTODO three");
      const result = await callTool("str_replace_note", {
        id: created.id,
        old_str: "TODO",
        new_str: "DONE",
        replace_all: true,
      });
      expect(result.replacements).toBe(3);
      const fetched = await callTool("get_note", { id: created.id });
      expect(fetched.content).toBe("DONE one\nDONE two\nDONE three");
    });

    it("empty new_str deletes old_str", async () => {
      const created = await makeNote("keep this [remove me] and this");
      const result = await callTool("str_replace_note", {
        id: created.id,
        old_str: " [remove me]",
        new_str: "",
      });
      expect(result.replacements).toBe(1);
      const fetched = await callTool("get_note", { id: created.id });
      expect(fetched.content).toBe("keep this and this");
    });

    it("inserts $&, $1, $$ in new_str literally", async () => {
      const created = await makeNote("price: PLACEHOLDER");
      await callTool("str_replace_note", {
        id: created.id,
        old_str: "PLACEHOLDER",
        new_str: "$& $1 $$ $`",
      });
      const fetched = await callTool("get_note", { id: created.id });
      expect(fetched.content).toBe("price: $& $1 $$ $`");
    });

    it("matches regex metacharacters in old_str literally", async () => {
      const meta = ".*?[](){}+|^$\\";
      const created = await makeNote(`before ${meta} after; also a.b`);
      const result = await callTool("str_replace_note", {
        id: created.id,
        old_str: meta,
        new_str: "META",
      });
      expect(result.replacements).toBe(1);
      const fetched = await callTool("get_note", { id: created.id });
      expect(fetched.content).toBe("before META after; also a.b");

      // "." must not act as a wildcard.
      const noMatch = await callTool("str_replace_note", {
        id: created.id,
        old_str: "a.c",
        new_str: "x",
      });
      expect(noMatch.code).toBe("NO_MATCH");
    });

    it("returns VALIDATION_ERROR for empty old_str", async () => {
      const created = await makeNote("anything");
      const result = await callTool("str_replace_note", {
        id: created.id,
        old_str: "",
        new_str: "x",
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("VALIDATION_ERROR");
    });

    it("returns NOT_FOUND for non-existent note", async () => {
      const result = await callTool("str_replace_note", {
        id: "00000000-0000-0000-0000-000000000000",
        old_str: "a",
        new_str: "b",
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("NOT_FOUND");
    });

    it("writes a change-log row only for successful edits", async () => {
      const created = await makeNote("alpha beta");
      expect(await noteUpdateChangeCount(created.id)).toBe(0);

      await callTool("str_replace_note", { id: created.id, old_str: "gamma", new_str: "x" });
      expect(await noteUpdateChangeCount(created.id)).toBe(0);

      await callTool("str_replace_note", { id: created.id, old_str: "beta", new_str: "gamma" });
      expect(await noteUpdateChangeCount(created.id)).toBe(1);
    });
  });

  describe("append_note", () => {
    it("appends on a new line when content lacks a trailing newline", async () => {
      const created = await callTool("create_note", {
        title: "Acme Corp log",
        content: "2026-01-01: kickoff",
        scope: "work",
      });
      const result = await callTool("append_note", {
        id: created.id,
        content: "2026-01-02: follow-up",
      });
      expect(result.error).toBeUndefined();
      expect(result.id).toBe(created.id);
      expect(result.title).toBe("Acme Corp log");
      expect(result).not.toHaveProperty("content");
      expect(result).not.toHaveProperty("replacements");

      const fetched = await callTool("get_note", { id: created.id });
      expect(fetched.content).toBe("2026-01-01: kickoff\n2026-01-02: follow-up");
      expect(result.content_length).toBe(fetched.content.length);
    });

    it("does not add a second newline when content already ends with one", async () => {
      const created = await callTool("create_note", {
        title: "Acme Corp log",
        content: "2026-01-01: kickoff\n",
        scope: "work",
      });
      await callTool("append_note", { id: created.id, content: "2026-01-02: follow-up" });
      const fetched = await callTool("get_note", { id: created.id });
      expect(fetched.content).toBe("2026-01-01: kickoff\n2026-01-02: follow-up");
    });

    it("on empty content the result is just the appended text", async () => {
      const created = await callTool("create_note", {
        title: "Acme Corp empty log",
        content: "placeholder",
        scope: "work",
      });
      // create_note rejects empty content, so empty it via update_note.
      await callTool("update_note", { id: created.id, content: "" });
      await callTool("append_note", { id: created.id, content: "first entry" });
      const fetched = await callTool("get_note", { id: created.id });
      expect(fetched.content).toBe("first entry");
    });

    it("returns VALIDATION_ERROR for empty content", async () => {
      const created = await callTool("create_note", {
        title: "Acme Corp log",
        content: "x",
        scope: "work",
      });
      const result = await callTool("append_note", { id: created.id, content: "" });
      expect(result.error).toBe(true);
      expect(result.code).toBe("VALIDATION_ERROR");
    });

    it("returns NOT_FOUND for non-existent note", async () => {
      const result = await callTool("append_note", {
        id: "00000000-0000-0000-0000-000000000000",
        content: "orphan",
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("NOT_FOUND");
    });

    it("writes a change-log row for each append", async () => {
      const created = await callTool("create_note", {
        title: "Acme Corp log",
        content: "start",
        scope: "work",
      });
      await callTool("append_note", { id: created.id, content: "one" });
      await callTool("append_note", { id: created.id, content: "two" });
      expect(await noteUpdateChangeCount(created.id)).toBe(2);
    });

    it("concurrent appends are serialized — every line lands exactly once", async () => {
      const created = await callTool("create_note", {
        title: "Acme Corp concurrent log",
        content: "header",
        scope: "work",
      });
      const N = 10;
      const lines = Array.from({ length: N }, (_, i) => `entry-${i}-marker`);
      const results = await Promise.all(
        lines.map((line) => callTool("append_note", { id: created.id, content: line }))
      );
      for (const r of results) expect(r.error).toBeUndefined();

      const fetched = await callTool("get_note", { id: created.id });
      const contentLines: string[] = fetched.content.split("\n");
      expect(contentLines[0]).toBe("header");
      expect(contentLines.length).toBe(N + 1);
      for (const line of lines) {
        expect(contentLines.filter((l) => l === line).length).toBe(1);
      }
      expect(await noteUpdateChangeCount(created.id)).toBe(N);
    });
  });

  describe("delete_note", () => {
    it("deletes an existing note and returns {deleted: true}", async () => {
      const created = await callTool("create_note", {
        title: "To be deleted",
        content: "Goodbye",
        scope: "personal",
      });

      const result = await callTool("delete_note", { id: created.id });
      expect(result.deleted).toBe(true);
      expect(result.id).toBe(created.id);

      const fetched = await callTool("get_note", { id: created.id });
      expect(fetched.error).toBe(true);
      expect(fetched.code).toBe("NOT_FOUND");
    });

    it("returns NOT_FOUND for non-existent note", async () => {
      const result = await callTool("delete_note", {
        id: "00000000-0000-0000-0000-000000000000",
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("NOT_FOUND");
    });
  });

  describe("cross-tool isolation", () => {
    it("notes do NOT appear in list_tasks", async () => {
      const note = await callTool("create_note", {
        title: "Isolation-test note marker fffeee",
        content: "Should not show up in tasks",
        scope: "personal",
      });

      const list = await callTool("list_tasks", { status: null });
      const found = list.tasks?.some((t: any) => t.id === note.id);
      expect(found).toBeFalsy();
    });

    it("notes do NOT appear in search_tasks", async () => {
      await callTool("create_note", {
        title: "SearchIsolationMarkerGgghhh",
        content: "Isolation body",
        scope: "personal",
      });

      const result = await callTool("search_tasks", {
        query: "SearchIsolationMarkerGgghhh",
      });
      expect(result.tasks.length).toBe(0);
    });
  });
});

// Pure helpers behind str_replace_note / append_note — no Postgres needed.
describe("note partial-edit helpers", () => {
  it("countOccurrences counts literal, non-overlapping matches", () => {
    expect(countOccurrences("a.b a.b axb", "a.b")).toBe(2);
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("abc", "z")).toBe(0);
  });

  it("literalReplace inserts $-patterns verbatim and treats old_str literally", () => {
    expect(literalReplace("x PH y PH", "PH", "$& $1 $$ $`", false)).toBe("x $& $1 $$ $` y PH");
    expect(literalReplace("x PH y PH", "PH", "$&", true)).toBe("x $& y $&");
    expect(literalReplace("a .*?[](){}+|^$\\ b", ".*?[](){}+|^$\\", "M", false)).toBe("a M b");
    expect(literalReplace("keep [x] this", " [x]", "", false)).toBe("keep this");
  });

  it("appendWithNewline inserts at most one separator", () => {
    expect(appendWithNewline("a", "b")).toBe("a\nb");
    expect(appendWithNewline("a\n", "b")).toBe("a\nb");
    expect(appendWithNewline("", "b")).toBe("b");
  });
});
