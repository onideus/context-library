import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Integration tests for the server-computed artifact_summary field returned
 * by get_latest_handoff and get_handoff. Requires PostgreSQL — the suite is
 * skipped gracefully when Postgres is not reachable.
 */

const TEST_PORT = 3194;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_DATA_DIR = join(process.cwd(), "data", "test-artifact-summary");

const PG_DATABASE = "cl_test_artifact_summary";
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
  console.log("  artifact_summary suite will be SKIPPED");
  console.log("=".repeat(60) + "\n");
}

describe.skipIf(!pgAvailable)("artifact_summary on handoff retrieval", () => {
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

    serverProcess.stderr?.on("data", () => {});
    serverProcess.stdout?.on("data", () => {});

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

  it("get_latest_handoff includes artifact_summary with the expected shape", async () => {
    // Seed a variety of artifacts in distinct lifecycle states.
    await callTool("store_artifact", {
      title: "draft-A",
      artifact_type: "cc-prompt",
      scope: "work",
      content: "draft body",
    });
    await callTool("store_artifact", {
      title: "ready-A",
      artifact_type: "cc-prompt",
      scope: "work",
      content: "ready body",
      status: "ready",
      execution_order: 1,
    });
    const exec = await callTool("store_artifact", {
      title: "exec-A",
      artifact_type: "cc-prompt",
      scope: "work",
      content: "exec body",
      status: "ready",
      execution_order: 2,
    });
    await callTool("update_artifact", { id: exec.id, status: "executing" });

    await callTool("store_handoff", { tone_notes: "artifact_summary shape" });

    const retrieved = await callTool("get_latest_handoff", {});
    expect(retrieved.artifact_summary).toBeDefined();
    expect(retrieved.artifact_summary).not.toBeNull();
    const s = retrieved.artifact_summary;
    expect(typeof s.ready_count).toBe("number");
    expect(typeof s.executing_count).toBe("number");
    expect(typeof s.draft_count).toBe("number");
    expect(typeof s.completed_count).toBe("number");
    expect(Array.isArray(s.recently_completed)).toBe(true);
    expect(Array.isArray(s.currently_executing)).toBe(true);
    expect(Array.isArray(s.ready_queue)).toBe(true);

    // The executing artifact we just created should be in currently_executing.
    expect(s.currently_executing.some((a: any) => a.id === exec.id)).toBe(true);
    // ready_queue includes at least the ready artifact (not the one we promoted).
    expect(s.ready_queue.some((a: any) => a.title === "ready-A")).toBe(true);
    // counts reflect at least the seeded items.
    expect(s.ready_count).toBeGreaterThanOrEqual(1);
    expect(s.executing_count).toBeGreaterThanOrEqual(1);
    expect(s.draft_count).toBeGreaterThanOrEqual(1);
  });

  it("recently_completed only includes artifacts completed after the handoff's stored_at", async () => {
    // Complete an artifact BEFORE storing the handoff.
    const beforeArtifact = await callTool("store_artifact", {
      title: "completed-before-handoff",
      artifact_type: "cc-prompt",
      scope: "work",
      content: "x",
      status: "ready",
    });
    await callTool("update_artifact", { id: beforeArtifact.id, status: "executing" });
    await callTool("update_artifact", { id: beforeArtifact.id, status: "completed" });

    // Spacer so the handoff stored_at is strictly later than the prior completion.
    await new Promise((r) => setTimeout(r, 50));

    const storeResult = await callTool("store_handoff", {
      tone_notes: "recently_completed cutoff",
    });
    expect(storeResult.success).toBe(true);

    // Now complete a different artifact AFTER the handoff.
    await new Promise((r) => setTimeout(r, 50));
    const afterArtifact = await callTool("store_artifact", {
      title: "completed-after-handoff",
      artifact_type: "cc-prompt",
      scope: "work",
      content: "y",
      status: "ready",
    });
    await callTool("update_artifact", { id: afterArtifact.id, status: "executing" });
    await callTool("update_artifact", { id: afterArtifact.id, status: "completed" });

    const retrieved = await callTool("get_latest_handoff", {});
    const recent = retrieved.artifact_summary.recently_completed;
    const recentIds = recent.map((r: any) => r.id);
    expect(recentIds).toContain(afterArtifact.id);
    expect(recentIds).not.toContain(beforeArtifact.id);
  });

  it("get_handoff returns the same artifact_summary shape", async () => {
    const stored = await callTool("store_handoff", {
      tone_notes: "get_handoff artifact_summary",
      active_context: { session_meta: { label: "artifact-summary-historical" } },
    });

    const retrieved = await callTool("get_handoff", { filename: stored.filename });
    expect(retrieved.error).toBeUndefined();
    expect(retrieved.artifact_summary).toBeDefined();
    expect(retrieved.artifact_summary).not.toBeNull();
    expect(typeof retrieved.artifact_summary.ready_count).toBe("number");
    expect(Array.isArray(retrieved.artifact_summary.ready_queue)).toBe(true);
  });
});
