import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";

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

    // Clean slate for test isolation
    await client.query("DROP TABLE IF EXISTS notes CASCADE");
    await client.query("DROP TABLE IF EXISTS tasks CASCADE");
    await client.query("DROP TABLE IF EXISTS embeddings CASCADE");
    await client.query("DROP TABLE IF EXISTS _migrations CASCADE");
    await client.query("DROP TYPE IF EXISTS task_status CASCADE");
    await client.query("DROP TYPE IF EXISTS task_scope CASCADE");
    await client.query("DROP TYPE IF EXISTS task_priority CASCADE");

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
