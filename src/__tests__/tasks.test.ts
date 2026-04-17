import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Task tool integration tests.
 *
 * These tests require a running PostgreSQL instance. Set PG* env vars
 * or run: docker run --rm -p 5432:5432 -e POSTGRES_DB=cl_test -e POSTGRES_USER=cl -e POSTGRES_PASSWORD=test pgvector/pgvector:pg16
 *
 * If Postgres is not available, the entire suite is skipped gracefully
 * via describe.skipIf at module load (top-level await). Do NOT use
 * it.skipIf with a flag assigned in beforeAll — Vitest resolves skipIf
 * predicates during test collection, which runs before beforeAll, so
 * the flag's initial value is captured and every test gets marked as
 * skipped unconditionally.
 */

const TEST_PORT = 3197;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_DATA_DIR = join(process.cwd(), "data", "test-tasks");

// Use test-specific Postgres database to avoid conflicts
const PG_DATABASE = "cl_test";
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
    // Try to connect using pg to check if Postgres is available
    const pg = await import("pg");
    const client = new pg.default.Client({
      host: PG_HOST,
      port: parseInt(PG_PORT),
      user: PG_USER,
      password: PG_PASSWORD,
      database: PG_DATABASE,
    });
    await client.connect();

    // Clean tasks table for test isolation
    await client.query("DROP TABLE IF EXISTS tasks CASCADE");
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

// Module-level probe — runs once during test collection, BEFORE describe/it
// predicates are evaluated. Top-level await is required so the probe
// completes before Vitest resolves skipIf.
const pgAvailable = await checkPostgres();

if (!pgAvailable) {
  console.log("\n" + "=".repeat(60));
  console.log("  NOTICE: PostgreSQL not available");
  console.log("  Task Tools suite will be SKIPPED");
  console.log("  See CONTRIBUTING.md for setup instructions");
  console.log("=".repeat(60) + "\n");
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe.skipIf(!pgAvailable)("Task Tools", () => {
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

  it("task tools appear in tools/list", async () => {
    const res = await mcpPost(jsonrpc("tools/list"));
    const data = (await parseSseResponse(res)) as any;
    const toolNames: string[] = data.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain("create_task");
    expect(toolNames).toContain("get_task");
    expect(toolNames).toContain("list_tasks");
    expect(toolNames).toContain("update_task");
    expect(toolNames).toContain("search_tasks");
  });

  describe("create_task", () => {
    it("creates a task with all fields and returns it with UUID", async () => {
      const result = await callTool("create_task", {
        title: "Test task creation",
        context: "Integration test",
        scope: "personal",
        priority: "high",
        tags: ["test", "integration"],
        blocked_reason: "Waiting for CI",
        scheduled_date: "2026-04-01",
        due_date: "2026-04-15",
      });

      expect(result.error).toBeUndefined();
      expect(result.id).toBeDefined();
      expect(result.title).toBe("Test task creation");
      expect(result.context).toBe("Integration test");
      expect(result.status).toBe("open");
      expect(result.scope).toBe("personal");
      expect(result.priority).toBe("high");
      expect(result.tags).toEqual(["test", "integration"]);
      expect(result.blocked_reason).toBe("Waiting for CI");
      expect(result.scheduled_date).toContain("2026-04-01");
      expect(result.due_date).toContain("2026-04-15");
      expect(result.created_at).toBeDefined();
      expect(result.updated_at).toBeDefined();
    });

    it("creates a minimal task with just title and scope", async () => {
      const result = await callTool("create_task", {
        title: "Minimal task",
        scope: "work",
      });

      expect(result.error).toBeUndefined();
      expect(result.id).toBeDefined();
      expect(result.title).toBe("Minimal task");
      expect(result.status).toBe("open");
      expect(result.scope).toBe("work");
      expect(result.priority).toBeNull();
      expect(result.tags).toEqual([]);
      expect(result.blocked_reason).toBeNull();
    });

    it("returns validation error for empty title", async () => {
      const result = await callTool("create_task", {
        title: "",
        scope: "personal",
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("get_task", () => {
    it("retrieves a task by ID", async () => {
      const created = await callTool("create_task", {
        title: "Task to retrieve",
        scope: "personal",
        priority: "normal",
      });

      const result = await callTool("get_task", { id: created.id });
      expect(result.id).toBe(created.id);
      expect(result.title).toBe("Task to retrieve");
    });

    it("returns NOT_FOUND for non-existent ID", async () => {
      const result = await callTool("get_task", {
        id: "00000000-0000-0000-0000-000000000000",
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("NOT_FOUND");
    });
  });

  describe("list_tasks", () => {
    it("defaults to open tasks", async () => {
      const result = await callTool("list_tasks", {});
      expect(result.tasks).toBeDefined();
      expect(result.total_count).toBeGreaterThan(0);
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(0);
      // All returned tasks should be open
      for (const task of result.tasks) {
        expect(task.status).toBe("open");
      }
    });

    it("returns all statuses when status=null", async () => {
      // First create a completed task
      const created = await callTool("create_task", {
        title: "Will complete for list test",
        scope: "personal",
      });
      await callTool("update_task", { id: created.id, action: "complete" });

      const result = await callTool("list_tasks", { status: null });
      const statuses = new Set(result.tasks.map((t: any) => t.status));
      // Should have at least open tasks from earlier tests
      expect(statuses.has("open")).toBe(true);
      expect(statuses.has("completed")).toBe(true);
    });

    it("filters by scope", async () => {
      const result = await callTool("list_tasks", { scope: "work" });
      for (const task of result.tasks) {
        expect(task.scope).toBe("work");
      }
    });

    it("filters blocked tasks", async () => {
      const result = await callTool("list_tasks", { blocked: true });
      for (const task of result.tasks) {
        expect(task.blocked_reason).not.toBeNull();
      }
    });

    it("filters unblocked tasks", async () => {
      const result = await callTool("list_tasks", { blocked: false });
      for (const task of result.tasks) {
        expect(task.blocked_reason).toBeNull();
      }
    });

    it("filters by tags with ANY-match", async () => {
      await callTool("create_task", {
        title: "Tagged task for filter",
        scope: "personal",
        tags: ["unique-tag-xyz"],
      });

      const result = await callTool("list_tasks", {
        tags: ["unique-tag-xyz", "nonexistent"],
      });
      expect(result.total_count).toBeGreaterThanOrEqual(1);
      for (const task of result.tasks) {
        expect(task.tags.some((t: string) => ["unique-tag-xyz", "nonexistent"].includes(t))).toBe(true);
      }
    });

    it("respects limit and offset", async () => {
      const page1 = await callTool("list_tasks", { limit: 2, offset: 0 });
      const page2 = await callTool("list_tasks", { limit: 2, offset: 2 });
      expect(page1.tasks.length).toBeLessThanOrEqual(2);
      expect(page2.tasks.length).toBeLessThanOrEqual(2);
      // Pages should have different tasks (if enough exist)
      if (page1.tasks.length > 0 && page2.tasks.length > 0) {
        expect(page1.tasks[0].id).not.toBe(page2.tasks[0].id);
      }
    });

    it("filters by due_before and due_after", async () => {
      await callTool("create_task", {
        title: "Due date filter test",
        scope: "personal",
        due_date: "2026-04-10",
      });

      const before = await callTool("list_tasks", { due_before: "2026-04-15" });
      const foundBefore = before.tasks.some((t: any) => t.title === "Due date filter test");
      expect(foundBefore).toBe(true);

      const after = await callTool("list_tasks", { due_after: "2026-04-15" });
      const foundAfter = after.tasks.some((t: any) => t.title === "Due date filter test");
      expect(foundAfter).toBe(false);
    });

    it("filters by scheduled_before and scheduled_after", async () => {
      await callTool("create_task", {
        title: "Scheduled date filter test",
        scope: "personal",
        scheduled_date: "2026-05-01",
      });

      const before = await callTool("list_tasks", { scheduled_before: "2026-05-15" });
      const found = before.tasks.some((t: any) => t.title === "Scheduled date filter test");
      expect(found).toBe(true);
    });
  });

  describe("update_task", () => {
    it("action=complete sets status, completed_at, clears blocked_reason", async () => {
      const created = await callTool("create_task", {
        title: "Task to complete",
        scope: "personal",
        blocked_reason: "Was blocked",
      });

      const result = await callTool("update_task", {
        id: created.id,
        action: "complete",
      });
      expect(result.status).toBe("completed");
      expect(result.completed_at).toBeDefined();
      expect(result.blocked_reason).toBeNull();
    });

    it("action=cancel sets status, clears blocked_reason", async () => {
      const created = await callTool("create_task", {
        title: "Task to cancel",
        scope: "work",
        blocked_reason: "Something",
      });

      const result = await callTool("update_task", {
        id: created.id,
        action: "cancel",
      });
      expect(result.status).toBe("cancelled");
      expect(result.blocked_reason).toBeNull();
    });

    it("action=defer sets status to deferred", async () => {
      const created = await callTool("create_task", {
        title: "Task to defer",
        scope: "personal",
      });

      const result = await callTool("update_task", {
        id: created.id,
        action: "defer",
      });
      expect(result.status).toBe("deferred");
    });

    it("action=reopen sets status to open, clears completed_at", async () => {
      const created = await callTool("create_task", {
        title: "Task to reopen",
        scope: "personal",
      });
      await callTool("update_task", { id: created.id, action: "complete" });

      const result = await callTool("update_task", {
        id: created.id,
        action: "reopen",
      });
      expect(result.status).toBe("open");
      expect(result.completed_at).toBeNull();
    });

    it("updates field-level properties", async () => {
      const created = await callTool("create_task", {
        title: "Original title",
        scope: "personal",
        priority: "low",
      });

      const result = await callTool("update_task", {
        id: created.id,
        title: "Updated title",
        context: "New context",
        priority: "high",
        tags: ["updated"],
        due_date: "2026-05-01",
      });
      expect(result.title).toBe("Updated title");
      expect(result.context).toBe("New context");
      expect(result.priority).toBe("high");
      expect(result.tags).toEqual(["updated"]);
      expect(result.due_date).toContain("2026-05-01");
    });

    it("combines action with field updates", async () => {
      const created = await callTool("create_task", {
        title: "Complete with context",
        scope: "personal",
      });

      const result = await callTool("update_task", {
        id: created.id,
        action: "complete",
        context: "Completed with notes",
      });
      expect(result.status).toBe("completed");
      expect(result.context).toBe("Completed with notes");
    });

    it("unblocks by setting blocked_reason to null", async () => {
      const created = await callTool("create_task", {
        title: "Blocked task",
        scope: "personal",
        blocked_reason: "Waiting on dependency",
      });

      const result = await callTool("update_task", {
        id: created.id,
        blocked_reason: null,
      });
      expect(result.blocked_reason).toBeNull();
    });

    it("returns NOT_FOUND for non-existent task", async () => {
      const result = await callTool("update_task", {
        id: "00000000-0000-0000-0000-000000000000",
        action: "complete",
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("NOT_FOUND");
    });
  });

  describe("search_tasks", () => {
    it("finds tasks by keyword in title", async () => {
      await callTool("create_task", {
        title: "Federal tax filing deadline",
        context: "Must complete before April",
        scope: "personal",
      });

      const result = await callTool("search_tasks", { query: "federal taxes" });
      expect(result.tasks.length).toBeGreaterThanOrEqual(1);
      const found = result.tasks.some((t: any) =>
        t.title.toLowerCase().includes("federal") || t.title.toLowerCase().includes("tax")
      );
      expect(found).toBe(true);
    });

    it("finds tasks by keyword in context", async () => {
      await callTool("create_task", {
        title: "Generic task name",
        context: "This involves xylophone maintenance procedures",
        scope: "personal",
      });

      const result = await callTool("search_tasks", { query: "xylophone" });
      expect(result.tasks.length).toBeGreaterThanOrEqual(1);
    });

    it("supports stemming (e.g., 'filing' matches 'file')", async () => {
      await callTool("create_task", {
        title: "File the quarterly report",
        scope: "work",
      });

      const result = await callTool("search_tasks", { query: "filing" });
      const found = result.tasks.some((t: any) => t.title.includes("File the quarterly"));
      expect(found).toBe(true);
    });

    it("filters by status", async () => {
      const created = await callTool("create_task", {
        title: "Searchable completed task zqwxyz",
        scope: "personal",
      });
      await callTool("update_task", { id: created.id, action: "complete" });

      const openResults = await callTool("search_tasks", {
        query: "zqwxyz",
        status: "open",
      });
      expect(openResults.tasks.length).toBe(0);

      const completedResults = await callTool("search_tasks", {
        query: "zqwxyz",
        status: "completed",
      });
      expect(completedResults.tasks.length).toBe(1);
    });

    it("filters by scope", async () => {
      await callTool("create_task", {
        title: "Work-scoped search target abcdef123",
        scope: "work",
      });

      const result = await callTool("search_tasks", {
        query: "abcdef123",
        scope: "personal",
      });
      expect(result.tasks.length).toBe(0);

      const workResult = await callTool("search_tasks", {
        query: "abcdef123",
        scope: "work",
      });
      expect(workResult.tasks.length).toBe(1);
    });

    it("returns validation error for empty query", async () => {
      const result = await callTool("search_tasks", { query: "" });
      expect(result.error).toBe(true);
      expect(result.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("dynamic task_summary in get_latest_handoff", () => {
    it("returns enriched task_summary from Postgres (counts + item arrays)", async () => {
      // Seed a known mix of tasks
      const critical = await callTool("create_task", {
        title: "Critical task summary test",
        scope: "work",
        priority: "critical",
        due_date: "2099-01-15",
      });
      const blocked = await callTool("create_task", {
        title: "Blocked task summary test",
        scope: "work",
        blocked_reason: "Waiting for upstream",
      });
      const toComplete = await callTool("create_task", {
        title: "Recently completed summary test",
        scope: "work",
      });
      await callTool("update_task", { id: toComplete.id, action: "complete" });

      // Due this week — use a date 3 days out
      const threeDaysOut = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      await callTool("create_task", {
        title: "Due this week summary test",
        scope: "work",
        due_date: threeDaysOut,
      });

      // Store a handoff so get_latest_handoff has something to return
      await callTool("store_handoff", {
        tone_notes: "dynamic summary test",
      });

      const result = await callTool("get_latest_handoff", {});
      const ts = result.task_summary;

      // Enriched shape present
      expect(Array.isArray(ts.critical_items)).toBe(true);
      expect(Array.isArray(ts.due_this_week)).toBe(true);
      expect(Array.isArray(ts.recently_completed)).toBe(true);
      expect(Array.isArray(ts.blocked_items)).toBe(true);
      expect(typeof ts.open_count).toBe("number");
      expect(typeof ts.blocked_count).toBe("number");
      expect(typeof ts.completed_count).toBe("number");

      // Counts reflect Postgres, not handoff arrays (which were empty)
      expect(ts.open_count).toBeGreaterThan(0);
      expect(ts.completed_count).toBeGreaterThan(0);
      expect(ts.blocked_count).toBeGreaterThan(0);

      // Critical item surfaced
      expect(ts.critical_items.some((i: any) => i.id === critical.id)).toBe(true);
      // Blocked item surfaced with reason
      const blockedItem = ts.blocked_items.find((i: any) => i.id === blocked.id);
      expect(blockedItem).toBeDefined();
      expect(blockedItem.blocked_reason).toBe("Waiting for upstream");
      // Recently completed surfaced
      expect(
        ts.recently_completed.some((i: any) => i.id === toComplete.id)
      ).toBe(true);
      // Due this week surfaced
      expect(
        ts.due_this_week.some((i: any) => i.title === "Due this week summary test")
      ).toBe(true);
    });

    it("due_this_week excludes tasks due beyond 7 days", async () => {
      const farOut = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const created = await callTool("create_task", {
        title: "Far future due date test xyz987",
        scope: "work",
        due_date: farOut,
      });

      await callTool("store_handoff", {});
      const result = await callTool("get_latest_handoff", {});
      const ts = result.task_summary;

      expect(ts.due_this_week.every((i: any) => i.id !== created.id)).toBe(true);
    });

    it("recently_completed is ordered newest first", async () => {
      const first = await callTool("create_task", {
        title: "Complete-order-first",
        scope: "work",
      });
      await callTool("update_task", { id: first.id, action: "complete" });

      await new Promise((r) => setTimeout(r, 20));

      const second = await callTool("create_task", {
        title: "Complete-order-second",
        scope: "work",
      });
      await callTool("update_task", { id: second.id, action: "complete" });

      await callTool("store_handoff", {});
      const result = await callTool("get_latest_handoff", {});
      const rc = result.task_summary.recently_completed;

      const firstIdx = rc.findIndex((i: any) => i.id === first.id);
      const secondIdx = rc.findIndex((i: any) => i.id === second.id);
      expect(secondIdx).toBeGreaterThanOrEqual(0);
      expect(firstIdx).toBeGreaterThanOrEqual(0);
      expect(secondIdx).toBeLessThan(firstIdx);
    });
  });
});
