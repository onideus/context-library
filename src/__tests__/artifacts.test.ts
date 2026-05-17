import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Artifact tool integration tests.
 *
 * Requires a running PostgreSQL instance. See tasks.test.ts for setup.
 * If Postgres is not available, the entire suite is skipped gracefully
 * via describe.skipIf at module load (top-level await).
 */

const TEST_PORT = 3195;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_DATA_DIR = join(process.cwd(), "data", "test-artifacts");

// 64-char hex string shaped like a real SHA-256 but is never the real hash of
// any test content. Used to exercise the server's strip/override of caller-
// supplied content_hash values.
const FAKE_HASH = "deadbeef".repeat(8);

const PG_DATABASE = "cl_test_artifacts";
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
    await client.query("DROP TABLE IF EXISTS artifacts CASCADE");
    await client.query("DROP TABLE IF EXISTS notes CASCADE");
    await client.query("DROP TABLE IF EXISTS tasks CASCADE");
    await client.query("DROP TABLE IF EXISTS embeddings CASCADE");
    await client.query("DROP TABLE IF EXISTS pending_embeddings CASCADE");
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
  console.log("  Artifact Tools suite will be SKIPPED");
  console.log("=".repeat(60) + "\n");
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe.skipIf(!pgAvailable)("Artifact Tools", () => {
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

  it("artifact tools appear in tools/list", async () => {
    const res = await mcpPost(jsonrpc("tools/list"));
    const data = (await parseSseResponse(res)) as any;
    const toolNames: string[] = data.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain("store_artifact");
    expect(toolNames).toContain("get_artifact");
    expect(toolNames).toContain("list_artifacts");
    expect(toolNames).toContain("search_artifacts");
    expect(toolNames).toContain("update_artifact");
  });

  describe("store_artifact", () => {
    it("creates an inline-content artifact with all fields", async () => {
      const result = await callTool("store_artifact", {
        title: "CC prompt: migrate auth",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "Plan and execute the auth migration in 3 phases...",
        status: "ready",
        tags: ["auth", "migration"],
        execution_order: 1,
        metadata: { branch_target: "feature/auth", model: "opus-4" },
      });

      expect(result.error).toBeUndefined();
      expect(result.id).toBeDefined();
      expect(result.title).toBe("CC prompt: migrate auth");
      expect(result.artifact_type).toBe("cc-prompt");
      expect(result.status).toBe("ready");
      expect(result.created_at).toBeDefined();
    });

    it("creates a pointer-only artifact", async () => {
      const result = await callTool("store_artifact", {
        title: "Research report PDF",
        artifact_type: "research",
        scope: "work",
        pointer: { type: "git", repo: "acme/research", branch: "main", path: "reports/q1.pdf" },
      });

      expect(result.error).toBeUndefined();
      expect(result.id).toBeDefined();
      expect(result.artifact_type).toBe("research");
    });

    it("defaults status to 'draft' when not provided", async () => {
      const created = await callTool("store_artifact", {
        title: "Draft artifact",
        artifact_type: "blog-post",
        scope: "personal",
        content: "draft body",
      });
      expect(created.status).toBe("draft");
    });

    it("rejects artifacts with neither content nor pointer", async () => {
      const result = await callTool("store_artifact", {
        title: "Missing body",
        artifact_type: "cc-prompt",
        scope: "work",
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("VALIDATION_ERROR");
    });

    it("returns validation error for empty title", async () => {
      const result = await callTool("store_artifact", {
        title: "",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "x",
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("VALIDATION_ERROR");
    });

    it("accepts a dependencies UUID array", async () => {
      const a = await callTool("store_artifact", {
        title: "A",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "first",
      });
      const b = await callTool("store_artifact", {
        title: "B",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "second",
        dependencies: [a.id],
      });

      const fetched = await callTool("get_artifact", { id: b.id });
      expect(fetched.dependencies).toEqual([a.id]);
    });
  });

  describe("get_artifact", () => {
    it("retrieves full artifact by UUID", async () => {
      const created = await callTool("store_artifact", {
        title: "To retrieve",
        artifact_type: "template",
        scope: "shared",
        content: "template body",
        metadata: { key: "value" },
      });

      const result = await callTool("get_artifact", { id: created.id });
      expect(result.id).toBe(created.id);
      expect(result.content).toBe("template body");
      expect(result.metadata.key).toBe("value");
      expect(result.metadata.content_hash).toBeDefined();
    });

    it("returns NOT_FOUND for non-existent ID", async () => {
      const result = await callTool("get_artifact", {
        id: "00000000-0000-0000-0000-000000000000",
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("NOT_FOUND");
    });
  });

  describe("list_artifacts", () => {
    it("returns metadata only — not full content", async () => {
      await callTool("store_artifact", {
        title: "List-test artifact",
        artifact_type: "cc-prompt",
        scope: "personal",
        content: "BODY SHOULD NOT APPEAR IN LIST",
      });

      const result = await callTool("list_artifacts", {});
      expect(result.artifacts).toBeDefined();
      expect(result.total_count).toBeGreaterThan(0);
      for (const a of result.artifacts) {
        expect(a.content).toBeUndefined();
        expect(a.id).toBeDefined();
        expect(a.title).toBeDefined();
        expect(a.artifact_type).toBeDefined();
      }
    });

    it("filters by artifact_type", async () => {
      await callTool("store_artifact", {
        title: "type-filter cc",
        artifact_type: "cc-prompt",
        scope: "personal",
        content: "x",
      });
      await callTool("store_artifact", {
        title: "type-filter blog",
        artifact_type: "blog-post",
        scope: "personal",
        content: "y",
      });

      const result = await callTool("list_artifacts", { artifact_type: "blog-post" });
      for (const a of result.artifacts) {
        expect(a.artifact_type).toBe("blog-post");
      }
    });

    it("filters by status", async () => {
      await callTool("store_artifact", {
        title: "ready-status-filter",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "x",
        status: "ready",
      });

      const result = await callTool("list_artifacts", { status: "ready" });
      for (const a of result.artifacts) {
        expect(a.status).toBe("ready");
      }
    });

    it("filters by scope", async () => {
      await callTool("store_artifact", {
        title: "scope-filter",
        artifact_type: "cc-prompt",
        scope: "shared",
        content: "x",
      });
      const result = await callTool("list_artifacts", { scope: "shared" });
      for (const a of result.artifacts) {
        expect(a.scope).toBe("shared");
      }
    });

    it("filters by tags with ANY-match", async () => {
      await callTool("store_artifact", {
        title: "tagged-artifact",
        artifact_type: "cc-prompt",
        scope: "personal",
        content: "body",
        tags: ["unique-artifact-tag-xyz"],
      });

      const result = await callTool("list_artifacts", {
        tags: ["unique-artifact-tag-xyz", "nonexistent"],
      });
      expect(result.total_count).toBeGreaterThanOrEqual(1);
    });

    it("orders by execution_order ASC when artifact_type filter is set", async () => {
      const typeName = "order-batch-" + Date.now();
      await callTool("store_artifact", {
        title: "third",
        artifact_type: typeName,
        scope: "work",
        content: "c",
        execution_order: 3,
      });
      await callTool("store_artifact", {
        title: "first",
        artifact_type: typeName,
        scope: "work",
        content: "a",
        execution_order: 1,
      });
      await callTool("store_artifact", {
        title: "second",
        artifact_type: typeName,
        scope: "work",
        content: "b",
        execution_order: 2,
      });

      const result = await callTool("list_artifacts", { artifact_type: typeName });
      expect(result.artifacts.length).toBe(3);
      expect(result.artifacts[0].execution_order).toBe(1);
      expect(result.artifacts[1].execution_order).toBe(2);
      expect(result.artifacts[2].execution_order).toBe(3);
    });

    it("respects limit and offset", async () => {
      const page1 = await callTool("list_artifacts", { limit: 2, offset: 0 });
      const page2 = await callTool("list_artifacts", { limit: 2, offset: 2 });
      expect(page1.artifacts.length).toBeLessThanOrEqual(2);
      expect(page2.artifacts.length).toBeLessThanOrEqual(2);
    });
  });

  describe("search_artifacts", () => {
    it("finds artifacts by keyword in title or content", async () => {
      await callTool("store_artifact", {
        title: "Unique search token qqrstt",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "body content",
      });

      const result = await callTool("search_artifacts", { query: "qqrstt" });
      expect(result.artifacts.length).toBeGreaterThanOrEqual(1);
    });

    it("includes full content in search results (unlike list)", async () => {
      await callTool("store_artifact", {
        title: "Search-full-content-marker-uniqueabc",
        artifact_type: "cc-prompt",
        scope: "personal",
        content: "This content SHOULD appear.",
      });

      const result = await callTool("search_artifacts", {
        query: "uniqueabc",
      });
      expect(result.artifacts.length).toBeGreaterThanOrEqual(1);
      expect(result.artifacts[0].content).toBeDefined();
    });

    it("filters by artifact_type", async () => {
      await callTool("store_artifact", {
        title: "Filter-type-marker-defghi",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "content",
      });

      const other = await callTool("search_artifacts", {
        query: "defghi",
        artifact_type: "blog-post",
      });
      expect(other.artifacts.length).toBe(0);

      const match = await callTool("search_artifacts", {
        query: "defghi",
        artifact_type: "cc-prompt",
      });
      expect(match.artifacts.length).toBeGreaterThanOrEqual(1);
    });

    it("returns validation error for empty query", async () => {
      const result = await callTool("search_artifacts", { query: "" });
      expect(result.error).toBe(true);
      expect(result.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("update_artifact", () => {
    it("updates basic fields", async () => {
      const created = await callTool("store_artifact", {
        title: "Original title",
        artifact_type: "cc-prompt",
        scope: "personal",
        content: "Original content",
      });

      const result = await callTool("update_artifact", {
        id: created.id,
        title: "Updated title",
        content: "Updated content",
        tags: ["updated"],
      });
      expect(result.title).toBe("Updated title");
      expect(result.content).toBe("Updated content");
      expect(result.tags).toEqual(["updated"]);
    });

    it("enforces valid status transitions: draft → ready → executing → completed", async () => {
      const created = await callTool("store_artifact", {
        title: "Lifecycle",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "x",
      });
      expect(created.status).toBe("draft");

      const ready = await callTool("update_artifact", { id: created.id, status: "ready" });
      expect(ready.status).toBe("ready");

      const executing = await callTool("update_artifact", { id: created.id, status: "executing" });
      expect(executing.status).toBe("executing");

      const completed = await callTool("update_artifact", { id: created.id, status: "completed" });
      expect(completed.status).toBe("completed");
    });

    it("rejects invalid status transitions", async () => {
      const created = await callTool("store_artifact", {
        title: "Bad-transition",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "x",
      });
      // draft → completed is not allowed
      const result = await callTool("update_artifact", { id: created.id, status: "completed" });
      expect(result.error).toBe(true);
      expect(result.code).toBe("INVALID_STATUS_TRANSITION");
    });

    it("allows transition to 'superseded' from any state", async () => {
      const created = await callTool("store_artifact", {
        title: "Supersede-me",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "x",
      });
      const r1 = await callTool("update_artifact", { id: created.id, status: "superseded" });
      expect(r1.status).toBe("superseded");

      const c2 = await callTool("store_artifact", {
        title: "Supersede-from-completed",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "x",
        status: "ready",
      });
      await callTool("update_artifact", { id: c2.id, status: "executing" });
      await callTool("update_artifact", { id: c2.id, status: "completed" });
      const r2 = await callTool("update_artifact", { id: c2.id, status: "superseded" });
      expect(r2.status).toBe("superseded");
    });

    it("merges metadata at the top level", async () => {
      const created = await callTool("store_artifact", {
        title: "Metadata-merge",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "x",
        metadata: { a: 1, b: 2 },
      });

      const result = await callTool("update_artifact", {
        id: created.id,
        metadata: { b: 20, c: 3 },
      });
      expect(result.metadata.a).toBe(1);
      expect(result.metadata.b).toBe(20);
      expect(result.metadata.c).toBe(3);
      expect(result.metadata.content_hash).toBeDefined();
    });

    it("returns NOT_FOUND for non-existent artifact", async () => {
      const result = await callTool("update_artifact", {
        id: "00000000-0000-0000-0000-000000000000",
        title: "anything",
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("NOT_FOUND");
    });

    it("returns VALIDATION_ERROR when no updates provided", async () => {
      const created = await callTool("store_artifact", {
        title: "Empty-update",
        artifact_type: "cc-prompt",
        scope: "personal",
        content: "x",
      });
      const result = await callTool("update_artifact", { id: created.id });
      expect(result.error).toBe(true);
      expect(result.code).toBe("VALIDATION_ERROR");
    });

    it("rejects clearing both content and pointer", async () => {
      const created = await callTool("store_artifact", {
        title: "Clear-body",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "x",
      });
      const result = await callTool("update_artifact", {
        id: created.id,
        content: null,
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("content_hash locking", () => {
    it("store_artifact with status 'ready' sets content_hash in metadata", async () => {
      const result = await callTool("store_artifact", {
        title: "Hash-on-ready",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "some deterministic content",
        status: "ready",
      });
      expect(result.error).toBeUndefined();

      const fetched = await callTool("get_artifact", { id: result.id });
      expect(fetched.metadata.content_hash).toBeDefined();
      expect(typeof fetched.metadata.content_hash).toBe("string");
      expect(fetched.metadata.content_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("store_artifact sets content_hash for any status when content is provided", async () => {
      const result = await callTool("store_artifact", {
        title: "Hash-on-draft",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "draft content",
      });
      expect(result.error).toBeUndefined();

      const fetched = await callTool("get_artifact", { id: result.id });
      expect(fetched.metadata.content_hash).toBeDefined();
      expect(fetched.metadata.content_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("update_artifact transitioning to 'ready' computes content_hash", async () => {
      const created = await callTool("store_artifact", {
        title: "Hash-on-transition",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "content to hash",
      });
      expect(created.status).toBe("draft");

      const updated = await callTool("update_artifact", {
        id: created.id,
        status: "ready",
      });
      expect(updated.status).toBe("ready");
      expect(updated.metadata.content_hash).toBeDefined();
      expect(updated.metadata.content_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("content_hash is deterministic for the same content", async () => {
      const content = "deterministic-content-xyz";
      const a = await callTool("store_artifact", {
        title: "Hash-det-a",
        artifact_type: "cc-prompt",
        scope: "work",
        content,
        status: "ready",
      });
      const b = await callTool("store_artifact", {
        title: "Hash-det-b",
        artifact_type: "cc-prompt",
        scope: "work",
        content,
        status: "ready",
      });
      const fetchedA = await callTool("get_artifact", { id: a.id });
      const fetchedB = await callTool("get_artifact", { id: b.id });
      expect(fetchedA.metadata.content_hash).toBe(fetchedB.metadata.content_hash);
    });

    it("update_artifact recomputes content_hash when content is updated", async () => {
      const created = await callTool("store_artifact", {
        title: "Hash-recompute",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "original content",
      });
      const original = await callTool("get_artifact", { id: created.id });
      const originalHash = original.metadata.content_hash;
      expect(originalHash).toBeDefined();

      const updated = await callTool("update_artifact", {
        id: created.id,
        content: "updated content",
      });
      expect(updated.metadata.content_hash).toBeDefined();
      expect(updated.metadata.content_hash).not.toBe(originalHash);
    });

    it("server-computed hash overrides caller-supplied content_hash when content is provided", async () => {
      const created = await callTool("store_artifact", {
        title: "Hash-override",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "some content",
      });
      const original = await callTool("get_artifact", { id: created.id });
      const correctHash = original.metadata.content_hash;

      const updated = await callTool("update_artifact", {
        id: created.id,
        content: "some content",
        metadata: { content_hash: FAKE_HASH },
      });
      expect(updated.metadata.content_hash).toBe(correctHash);
    });

    it("update_artifact rejects content modification when status is 'ready'", async () => {
      const created = await callTool("store_artifact", {
        title: "Locked-ready",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "locked content",
        status: "ready",
      });

      const result = await callTool("update_artifact", {
        id: created.id,
        content: "attempted mutation",
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("cannot_modify_locked_artifact");
    });

    it("update_artifact rejects content modification when status is 'executing'", async () => {
      const created = await callTool("store_artifact", {
        title: "Locked-executing",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "executing content",
        status: "ready",
      });
      await callTool("update_artifact", { id: created.id, status: "executing" });

      const result = await callTool("update_artifact", {
        id: created.id,
        content: "attempted mutation",
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("cannot_modify_locked_artifact");
    });

    it("update_artifact rejects content modification when status is 'completed'", async () => {
      const created = await callTool("store_artifact", {
        title: "Locked-completed",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "completed content",
        status: "ready",
      });
      await callTool("update_artifact", { id: created.id, status: "executing" });
      await callTool("update_artifact", { id: created.id, status: "completed" });

      const result = await callTool("update_artifact", {
        id: created.id,
        content: "attempted mutation",
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("cannot_modify_locked_artifact");
    });

    it("update_artifact clears content_hash when reverting 'ready' → 'draft'", async () => {
      const created = await callTool("store_artifact", {
        title: "Revert-to-draft",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "content before lock",
        status: "ready",
      });
      const locked = await callTool("get_artifact", { id: created.id });
      expect(locked.metadata.content_hash).toBeDefined();

      const reverted = await callTool("update_artifact", {
        id: created.id,
        status: "draft",
      });
      expect(reverted.status).toBe("draft");
      expect(reverted.metadata.content_hash).toBeUndefined();
    });

    it("update_artifact preserves existing metadata keys when setting content_hash", async () => {
      const created = await callTool("store_artifact", {
        title: "Hash-preserves-meta",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "body",
        metadata: { existing_key: "keep-me" },
      });

      const updated = await callTool("update_artifact", {
        id: created.id,
        status: "ready",
      });
      expect(updated.metadata.content_hash).toBeDefined();
      expect(updated.metadata.existing_key).toBe("keep-me");
    });

    it("content_hash survives metadata-only update on a draft artifact", async () => {
      const created = await callTool("store_artifact", {
        title: "Hash-survives-meta-update",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "content with hash",
      });
      const original = await callTool("get_artifact", { id: created.id });
      const originalHash = original.metadata.content_hash;
      expect(originalHash).toBeDefined();

      const updated = await callTool("update_artifact", {
        id: created.id,
        metadata: { target_repo: "some-repo" },
      });
      expect(updated.metadata.content_hash).toBe(originalHash);
      expect(updated.metadata.target_repo).toBe("some-repo");
      expect(updated.status).toBe("draft");
    });

    it("content_hash is recomputed when promoting after revert-to-draft cleared it", async () => {
      const created = await callTool("store_artifact", {
        title: "Hash-recompute-on-repromote",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "stable content",
        status: "ready",
      });
      const locked = await callTool("get_artifact", { id: created.id });
      const originalHash = locked.metadata.content_hash;
      expect(originalHash).toBeDefined();

      const reverted = await callTool("update_artifact", {
        id: created.id,
        status: "draft",
      });
      expect(reverted.metadata.content_hash).toBeUndefined();

      const repromoted = await callTool("update_artifact", {
        id: created.id,
        status: "ready",
      });
      expect(repromoted.metadata.content_hash).toBe(originalHash);
    });

    it("strips caller-supplied content_hash from metadata update on draft artifact", async () => {
      const created = await callTool("store_artifact", {
        title: "Hash-strip-on-draft",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "draft content",
      });
      const original = await callTool("get_artifact", { id: created.id });
      const correctHash = original.metadata.content_hash;

      const updated = await callTool("update_artifact", {
        id: created.id,
        metadata: { content_hash: FAKE_HASH, extra: "ok" },
      });
      expect(updated.metadata.content_hash).toBe(correctHash);
      expect(updated.metadata.extra).toBe("ok");
    });

    it("content_hash survives a full store -> metadata update -> promote -> metadata fix sequence", async () => {
      const created = await callTool("store_artifact", {
        title: "Full-lifecycle-hash",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "pipeline-ready content",
      });
      const original = await callTool("get_artifact", { id: created.id });
      const expectedHash = original.metadata.content_hash;
      expect(expectedHash).toBeDefined();

      await callTool("update_artifact", {
        id: created.id,
        metadata: { target_repo: "some-repo" },
      });

      const promoted = await callTool("update_artifact", {
        id: created.id,
        status: "ready",
      });
      expect(promoted.status).toBe("ready");
      expect(promoted.metadata.content_hash).toBe(expectedHash);

      const fixed = await callTool("update_artifact", {
        id: created.id,
        metadata: { target_repo: "correct-repo", model: "opus" },
      });
      expect(fixed.metadata.content_hash).toBe(expectedHash);
      expect(fixed.metadata.target_repo).toBe("correct-repo");

      const executing = await callTool("update_artifact", {
        id: created.id,
        status: "executing",
      });
      expect(executing.metadata.content_hash).toBe(expectedHash);
    });

    it("pointer-only artifact does not set content_hash", async () => {
      const result = await callTool("store_artifact", {
        title: "Pointer-no-hash",
        artifact_type: "research",
        scope: "work",
        pointer: { type: "git", repo: "acme/docs", branch: "main", path: "out/report.pdf" },
        status: "ready",
      });
      expect(result.error).toBeUndefined();

      const fetched = await callTool("get_artifact", { id: result.id });
      expect(fetched.metadata.content_hash).toBeUndefined();
    });

    it("store_artifact strips caller-supplied content_hash on pointer-only artifact", async () => {
      const result = await callTool("store_artifact", {
        title: "Pointer-strip-fake-hash",
        artifact_type: "research",
        scope: "work",
        pointer: { type: "git", repo: "acme/docs", branch: "main", path: "out/report.pdf" },
        metadata: { content_hash: FAKE_HASH, label: "keep-me" },
      });
      expect(result.error).toBeUndefined();

      const fetched = await callTool("get_artifact", { id: result.id });
      expect(fetched.metadata.content_hash).toBeUndefined();
      expect(fetched.metadata.label).toBe("keep-me");
    });

    it("store_artifact overrides caller-supplied content_hash when content is provided", async () => {
      const result = await callTool("store_artifact", {
        title: "Content-override-fake-hash",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "real content",
        metadata: { content_hash: FAKE_HASH, label: "keep-me" },
      });
      expect(result.error).toBeUndefined();

      const fetched = await callTool("get_artifact", { id: result.id });
      expect(fetched.metadata.content_hash).not.toBe(FAKE_HASH);
      expect(fetched.metadata.content_hash).toBeDefined();
      expect(fetched.metadata.label).toBe("keep-me");
    });

    it("update_artifact silently ignores content_hash supplied in metadata on a locked artifact", async () => {
      const created = await callTool("store_artifact", {
        title: "Tamper-guard",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "immutable content",
        status: "ready",
      });
      const fetched = await callTool("get_artifact", { id: created.id });
      const legitimateHash = fetched.metadata.content_hash;
      expect(legitimateHash).toBeDefined();

      // Attempt to overwrite the hash via a metadata update
      const updated = await callTool("update_artifact", {
        id: created.id,
        metadata: { content_hash: FAKE_HASH, extra: "ok" },
      });
      expect(updated.error).toBeUndefined();
      // Legitimate hash is preserved; caller-supplied value was stripped
      expect(updated.metadata.content_hash).toBe(legitimateHash);
      // Other metadata keys are still merged
      expect(updated.metadata.extra).toBe("ok");
    });

    it("ready -> draft -> ready via status-only updates recomputes content_hash", async () => {
      // Regression: the exact path called out in the sweep spec. Reverting to
      // draft clears content_hash; a subsequent status-only promotion back to
      // a locked status must recompute it from the row's current content,
      // because the caller did not provide content or metadata on either call.
      const created = await callTool("store_artifact", {
        title: "Hash-status-only-roundtrip",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "round-trip content",
        status: "ready",
      });
      const locked = await callTool("get_artifact", { id: created.id });
      const originalHash = locked.metadata.content_hash;
      expect(originalHash).toBeDefined();

      // Step 1: revert to draft via status-only update — hash should be cleared.
      const reverted = await callTool("update_artifact", {
        id: created.id,
        status: "draft",
      });
      expect(reverted.status).toBe("draft");
      expect(reverted.metadata.content_hash).toBeUndefined();

      // Re-fetch to prove the persisted row (not just the update response)
      // has content_hash cleared. Guards against a future refactor that
      // returns the right shape from update_artifact but fails to actually
      // strip the hash from the database row.
      const refetched = await callTool("get_artifact", { id: created.id });
      expect(refetched.status).toBe("draft");
      expect(refetched.metadata.content_hash).toBeUndefined();

      // Step 2: re-promote to ready via status-only update (no content, no
      // metadata) — the server must recompute content_hash from the row's
      // existing content. The artifact must not end up in ready with no hash.
      const repromoted = await callTool("update_artifact", {
        id: created.id,
        status: "ready",
      });
      expect(repromoted.status).toBe("ready");
      expect(repromoted.metadata.content_hash).toBe(originalHash);
    });
  });

  describe("cross-tool isolation", () => {
    it("artifacts do NOT appear in list_notes", async () => {
      const a = await callTool("store_artifact", {
        title: "Isolation-marker-artifact",
        artifact_type: "cc-prompt",
        scope: "personal",
        content: "should not show up in notes",
      });

      const list = await callTool("list_notes", {});
      const found = list.notes?.some((n: any) => n.id === a.id);
      expect(found).toBeFalsy();
    });

    it("artifacts do NOT appear in list_tasks", async () => {
      const a = await callTool("store_artifact", {
        title: "Isolation-marker-artifact-2",
        artifact_type: "cc-prompt",
        scope: "personal",
        content: "should not show up in tasks",
      });

      const list = await callTool("list_tasks", { status: null });
      const found = list.tasks?.some((t: any) => t.id === a.id);
      expect(found).toBeFalsy();
    });
  });

  describe("execution_order uniqueness", () => {
    it("rejects duplicate execution_order within the same artifact_type", async () => {
      const typeName = "dup-order-" + Date.now();
      await callTool("store_artifact", {
        title: "first",
        artifact_type: typeName,
        scope: "work",
        content: "a",
        execution_order: 1,
      });
      const dup = await callTool("store_artifact", {
        title: "second",
        artifact_type: typeName,
        scope: "work",
        content: "b",
        execution_order: 1,
      });
      expect(dup.error).toBe(true);
      expect(dup.code).toBe("EXECUTION_ORDER_CONFLICT");
      expect(dup.message).toContain(typeName);
    });

    it("allows the same execution_order across different artifact_types", async () => {
      const stamp = Date.now();
      const typeA = "type-a-" + stamp;
      const typeB = "type-b-" + stamp;
      const a = await callTool("store_artifact", {
        title: "a1",
        artifact_type: typeA,
        scope: "work",
        content: "a",
        execution_order: 1,
      });
      const b = await callTool("store_artifact", {
        title: "b1",
        artifact_type: typeB,
        scope: "work",
        content: "b",
        execution_order: 1,
      });
      expect(a.error).toBeUndefined();
      expect(b.error).toBeUndefined();
    });

    it("allows multiple artifacts with null execution_order in the same type", async () => {
      const typeName = "null-order-" + Date.now();
      const a = await callTool("store_artifact", {
        title: "a",
        artifact_type: typeName,
        scope: "work",
        content: "a",
      });
      const b = await callTool("store_artifact", {
        title: "b",
        artifact_type: typeName,
        scope: "work",
        content: "b",
      });
      expect(a.error).toBeUndefined();
      expect(b.error).toBeUndefined();
    });

    it("update_artifact rejects moving to a duplicate execution_order", async () => {
      const typeName = "update-dup-" + Date.now();
      await callTool("store_artifact", {
        title: "a",
        artifact_type: typeName,
        scope: "work",
        content: "a",
        execution_order: 1,
      });
      const b = await callTool("store_artifact", {
        title: "b",
        artifact_type: typeName,
        scope: "work",
        content: "b",
        execution_order: 2,
      });
      const result = await callTool("update_artifact", { id: b.id, execution_order: 1 });
      expect(result.error).toBe(true);
      expect(result.code).toBe("EXECUTION_ORDER_CONFLICT");
      expect(result.message).toContain(typeName);
    });
  });

  describe("dependencies validation", () => {
    it("rejects store_artifact with non-existent dependency UUID", async () => {
      const result = await callTool("store_artifact", {
        title: "bad-dep",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "x",
        dependencies: ["00000000-0000-0000-0000-000000000000"],
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("VALIDATION_ERROR");
      expect(result.message).toContain("00000000-0000-0000-0000-000000000000");
    });

    it("rejects update_artifact adding a non-existent dependency UUID", async () => {
      const a = await callTool("store_artifact", {
        title: "a",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "x",
      });
      const result = await callTool("update_artifact", {
        id: a.id,
        dependencies: ["00000000-0000-0000-0000-000000000000"],
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("VALIDATION_ERROR");
    });

    it("accepts uppercase/mixed-case UUID in dependencies", async () => {
      // Postgres uuid type is case-insensitive and returns canonical lowercase.
      // Regression: validateDependenciesExist must compare case-insensitively
      // so an uppercase input (still a valid UUID) is not falsely reported
      // as missing.
      const a = await callTool("store_artifact", {
        title: "dep-target",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "target",
      });
      const upper = (a.id as string).toUpperCase();
      const b = await callTool("store_artifact", {
        title: "dep-consumer",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "consumer",
        dependencies: [upper],
      });
      expect(b.error).toBeUndefined();
      expect(b.id).toBeDefined();

      // Same check on update_artifact.
      const c = await callTool("store_artifact", {
        title: "dep-updater",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "updater",
      });
      const updated = await callTool("update_artifact", {
        id: c.id,
        dependencies: [upper],
      });
      expect(updated.error).toBeUndefined();
    });

    it("accepts update_artifact clearing dependencies with an empty array", async () => {
      const a = await callTool("store_artifact", {
        title: "a",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "x",
      });
      const b = await callTool("store_artifact", {
        title: "b",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "y",
        dependencies: [a.id],
      });
      const cleared = await callTool("update_artifact", { id: b.id, dependencies: [] });
      expect(cleared.error).toBeUndefined();
      expect(cleared.dependencies).toEqual([]);
    });

    it("rejects malformed UUID in dependencies", async () => {
      const result = await callTool("store_artifact", {
        title: "bad-uuid",
        artifact_type: "cc-prompt",
        scope: "work",
        content: "x",
        dependencies: ["not-a-uuid"],
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("VALIDATION_ERROR");
    });
  });
});
