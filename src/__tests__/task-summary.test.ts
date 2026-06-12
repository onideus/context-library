import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * task_summary integration tests (src/tools/task-summary.ts).
 *
 * computeDynamicTaskSummary builds the enriched task_summary that
 * get_latest_handoff / get_handoff attach to their responses when Postgres
 * is available. When it returns null (Postgres down / query failure), the
 * handoff tools fall back to counts derived from the handoff's own tasks
 * arrays — so the three numeric count fields are always present.
 *
 * Requires a running PostgreSQL instance. See tasks.test.ts for setup.
 * If Postgres is not available, the gated suite is skipped gracefully
 * via describe.skipIf at module load (top-level await). Do NOT use
 * it.skipIf with a flag assigned in beforeAll — Vitest resolves skipIf
 * predicates during test collection, which runs before beforeAll.
 *
 * Uses a dedicated database (cl_test_task_summary) so count assertions
 * can be exact without interference from the other Postgres-gated suites
 * that run in parallel.
 */

const TEST_PORT = 3191;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_DATA_DIR = join(process.cwd(), "data", "test-task-summary");

const PG_DATABASE = "cl_test_task_summary";
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

// Module-level probe — runs once during test collection, BEFORE describe/it
// predicates are evaluated. Top-level await is required so the probe
// completes before Vitest resolves skipIf.
const pgAvailable = await checkPostgres();

if (!pgAvailable) {
  console.log("\n" + "=".repeat(60));
  console.log("  NOTICE: PostgreSQL not available");
  console.log("  Task Summary suite will be SKIPPED");
  console.log("  See CONTRIBUTING.md for setup instructions");
  console.log("=".repeat(60) + "\n");
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe.skipIf(!pgAvailable)("Task Summary", () => {
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

  describe("empty state", () => {
    it("returns the enriched shape with zero counts and empty arrays when no tasks exist", async () => {
      await callTool("store_handoff", { tone_notes: "empty summary test" });

      const result = await callTool("get_latest_handoff", {});
      const ts = result.task_summary;

      expect(ts.open_count).toBe(0);
      expect(ts.blocked_count).toBe(0);
      expect(ts.completed_count).toBe(0);
      expect(ts.critical_items).toEqual([]);
      expect(ts.due_this_week).toEqual([]);
      expect(ts.recently_completed).toEqual([]);
      expect(ts.blocked_items).toEqual([]);
    });
  });

  describe("populated summary", () => {
    // IDs captured by the seeding test and asserted on by later tests.
    let critical: any;
    let dueSoon: any;
    let blocked: any;
    let completed: any;

    it("computes counts and item arrays from the tasks table", async () => {
      // Seed a known mix: 4 open (one critical, one due soon, one blocked,
      // one plain), 1 completed, 1 cancelled, 1 deferred.
      await callTool("create_task", {
        title: "Plain open task",
        scope: "work",
      });
      critical = await callTool("create_task", {
        title: "Critical task with far-future due date",
        scope: "work",
        priority: "critical",
        due_date: "2099-01-15",
      });
      const threeDaysOut = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      dueSoon = await callTool("create_task", {
        title: "Due within the week",
        scope: "work",
        due_date: threeDaysOut,
      });
      blocked = await callTool("create_task", {
        title: "Blocked open task",
        scope: "work",
        blocked_reason: "Waiting on vendor",
      });
      completed = await callTool("create_task", {
        title: "Completed task",
        scope: "work",
      });
      await callTool("update_task", { id: completed.id, action: "complete" });

      const cancelled = await callTool("create_task", {
        title: "Cancelled task",
        scope: "work",
      });
      await callTool("update_task", { id: cancelled.id, action: "cancel" });
      const deferred = await callTool("create_task", {
        title: "Deferred task",
        scope: "work",
      });
      await callTool("update_task", { id: deferred.id, action: "defer" });

      // Store a handoff with NO tasks arrays — proves the summary comes from
      // Postgres, not from the handoff content.
      await callTool("store_handoff", { tone_notes: "populated summary test" });
      const result = await callTool("get_latest_handoff", {});
      const ts = result.task_summary;

      // Exact counts — dedicated database, no other suites write here.
      // Cancelled and deferred tasks count toward neither open nor completed.
      expect(ts.open_count).toBe(4);
      expect(ts.blocked_count).toBe(1);
      expect(ts.completed_count).toBe(1);

      // Critical item surfaced with its due date
      expect(ts.critical_items.length).toBe(1);
      expect(ts.critical_items[0].id).toBe(critical.id);
      expect(ts.critical_items[0].title).toBe(
        "Critical task with far-future due date"
      );

      // Due this week contains only the task due within 7 days
      expect(ts.due_this_week.length).toBe(1);
      expect(ts.due_this_week[0].id).toBe(dueSoon.id);
      expect(ts.due_this_week[0].due_date).toBeDefined();

      // Blocked item surfaced with its reason
      expect(ts.blocked_items.length).toBe(1);
      expect(ts.blocked_items[0].id).toBe(blocked.id);
      expect(ts.blocked_items[0].blocked_reason).toBe("Waiting on vendor");

      // Recently completed surfaced with completed_at
      expect(ts.recently_completed.length).toBe(1);
      expect(ts.recently_completed[0].id).toBe(completed.id);
      expect(ts.recently_completed[0].completed_at).toBeDefined();

      // Cancelled/deferred ids appear in no item array
      const allItemIds = [
        ...ts.critical_items,
        ...ts.due_this_week,
        ...ts.recently_completed,
        ...ts.blocked_items,
      ].map((i: any) => i.id);
      expect(allItemIds).not.toContain(cancelled.id);
      expect(allItemIds).not.toContain(deferred.id);
    });

    it("store_handoff task_summary reflects the tasks table, not deprecated handoff arrays", async () => {
      // Since schema 1.3, legacy task arrays are accepted on input but
      // dropped, and store_handoff's task_summary comes from the Postgres
      // tasks table. The table currently holds 4 open tasks — the deprecated
      // array claiming a single open task must not influence the summary.
      const result = await callTool("store_handoff", {
        tone_notes: "store summary source test",
        tasks: { open: ["only-one"], completed: [], blocked: [] },
      });
      expect(result.success).toBe(true);
      expect(result.task_summary.open_count).toBe(4);
      expect(result.task_summary.blocked_count).toBe(1);
      expect(result.task_summary.completed_count).toBe(1);
    });

    it("get_latest_handoff prefers the dynamic Postgres summary over handoff arrays", async () => {
      // The latest handoff (stored above) was sent with a deprecated array
      // claiming 1 open task; Postgres says 4.
      const result = await callTool("get_latest_handoff", {});
      const ts = result.task_summary;
      expect(ts.open_count).toBe(4);
      expect(ts.blocked_count).toBe(1);
      expect(ts.completed_count).toBe(1);
      expect(Array.isArray(ts.critical_items)).toBe(true);
    });

    it("get_handoff attaches the same dynamic summary to historical handoffs", async () => {
      const list = await callTool("list_handoffs", { limit: 1 });
      expect(list.handoffs.length).toBe(1);

      const result = await callTool("get_handoff", {
        filename: list.handoffs[0].filename,
      });
      expect(result.error).toBeUndefined();
      const ts = result.task_summary;
      expect(ts.open_count).toBe(4);
      expect(Array.isArray(ts.blocked_items)).toBe(true);
      expect(ts.blocked_items[0].blocked_reason).toBe("Waiting on vendor");
    });

    it("due_this_week excludes past-due and far-future tasks", async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const thirtyDaysOut = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const pastDue = await callTool("create_task", {
        title: "Past due task",
        scope: "work",
        due_date: yesterday,
      });
      const farOut = await callTool("create_task", {
        title: "Far future task",
        scope: "work",
        due_date: thirtyDaysOut,
      });

      await callTool("store_handoff", { tone_notes: "due window test" });
      const result = await callTool("get_latest_handoff", {});
      const ts = result.task_summary;

      const dueIds = ts.due_this_week.map((i: any) => i.id);
      expect(dueIds).not.toContain(pastDue.id);
      expect(dueIds).not.toContain(farOut.id);
      expect(dueIds).toContain(dueSoon.id);
    });

    it("caps critical_items at 5, ordered by due_date ascending with NULLS LAST", async () => {
      // Add 6 more critical tasks: 3 dated before the existing 2099 one,
      // 3 with no due date. Total open criticals = 7 → capped to 5.
      const dated: any[] = [];
      for (const date of ["2098-01-01", "2098-01-02", "2098-01-03"]) {
        dated.push(
          await callTool("create_task", {
            title: `Critical dated ${date}`,
            scope: "work",
            priority: "critical",
            due_date: date,
          })
        );
      }
      for (let i = 0; i < 3; i++) {
        await callTool("create_task", {
          title: `Critical undated ${i}`,
          scope: "work",
          priority: "critical",
        });
      }

      await callTool("store_handoff", { tone_notes: "critical cap test" });
      const result = await callTool("get_latest_handoff", {});
      const items = result.task_summary.critical_items;

      expect(items.length).toBe(5);
      // First four are the dated criticals in ascending due_date order
      expect(items.slice(0, 4).map((i: any) => i.id)).toEqual([
        dated[0].id,
        dated[1].id,
        dated[2].id,
        critical.id,
      ]);
      // Fifth slot is one of the undated criticals (NULLS LAST)
      expect(items[4].due_date).toBeNull();
    });
  });

  describe("graceful degradation contract", () => {
    it("task_summary always exposes the three numeric counts", async () => {
      // computeDynamicTaskSummary returns null when its Postgres queries
      // fail; get_latest_handoff then falls back to computeTaskSummary over
      // the handoff's own tasks arrays. Both shapes share {open_count,
      // blocked_count, completed_count}, so consumers can rely on those
      // fields regardless of source. The enriched item arrays are optional.
      // (Killing Postgres mid-test is not feasible here — the null path
      // itself is exercised by the unit-level test below.)
      await callTool("store_handoff", {
        tone_notes: "degradation contract test",
        tasks: { open: ["a"], completed: [], blocked: [] },
      });
      const result = await callTool("get_latest_handoff", {});
      const ts = result.task_summary;
      expect(ts).toBeDefined();
      expect(ts).not.toBeNull();
      expect(typeof ts.open_count).toBe("number");
      expect(typeof ts.blocked_count).toBe("number");
      expect(typeof ts.completed_count).toBe("number");
    });
  });
});

// ─────────────────────────────────────────────────────────────────
// Unit-level degradation test — no running Postgres required.
//
// Declared last so its env mutation cannot leak into the spawned server
// (the gated suite's beforeAll runs before this describe executes; tests
// within a file run sequentially).
// ─────────────────────────────────────────────────────────────────

describe("computeDynamicTaskSummary — graceful degradation", () => {
  it("returns null when Postgres is unreachable", async () => {
    const saved = {
      PGHOST: process.env.PGHOST,
      PGPORT: process.env.PGPORT,
      PGUSER: process.env.PGUSER,
      PGPASSWORD: process.env.PGPASSWORD,
      PGDATABASE: process.env.PGDATABASE,
    };
    // Point the in-process pg.Pool at a port nothing listens on. The pool
    // singleton in src/db/client.ts resolves connection params from env at
    // connect time, so this must be set before the first query.
    process.env.PGHOST = "127.0.0.1";
    process.env.PGPORT = "1";
    process.env.PGUSER = "nobody";
    process.env.PGPASSWORD = "wrong";
    process.env.PGDATABASE = "does_not_exist";
    try {
      const { computeDynamicTaskSummary } = await import(
        "../tools/task-summary.js"
      );
      const result = await computeDynamicTaskSummary();
      expect(result).toBeNull();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 15_000);
});
