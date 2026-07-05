import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * Sync foundation integration tests.
 *
 * Covers the pieces landed together in the "iOS Phase 1a — sync foundation"
 * PR:
 *   - change-log atomicity with entity writes
 *   - cursor pull idempotency
 *   - push dedupe on op_uuid
 *   - individual stale-op rejection (never batch-fail)
 *   - conditional-UPDATE status transition race
 *   - patch_handoff expected_source precondition (HANDOFF_CONFLICT)
 *
 * Requires a running PostgreSQL instance. Skips gracefully otherwise.
 */

const TEST_PORT = 3190;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_DATA_DIR = join(process.cwd(), "data", "test-sync");
const BEARER = "test-bearer-token-abcdef123456";

const PG_DATABASE = "cl_test_sync";
const PG_USER = process.env.PGUSER ?? "cl";
const PG_PASSWORD = process.env.PGPASSWORD ?? "test";
const PG_HOST = process.env.PGHOST ?? "localhost";
const PG_PORT = process.env.PGPORT ?? "5432";

let serverProcess: ChildProcess;

async function waitForServer(url: string, timeoutMs = 20_000): Promise<void> {
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

async function syncGet(path: string, headers: Record<string, string> = {}) {
  return fetch(`${BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${BEARER}`,
      ...headers,
    },
  });
}

async function syncPost(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BEARER}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
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
  console.log("  Sync suite will be SKIPPED");
  console.log("=".repeat(60) + "\n");
}

describe.skipIf(!pgAvailable)("Sync foundation", () => {
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
        SYNC_BEARER_TOKEN: BEARER,
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
      serverProcess.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
      if (!serverProcess.killed) serverProcess.kill("SIGKILL");
    }
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
  });

  describe("auth boundary", () => {
    it("rejects requests missing Authorization header", async () => {
      const res = await fetch(`${BASE_URL}/sync/changes`);
      expect(res.status).toBe(401);
    });

    it("rejects wrong bearer tokens", async () => {
      const res = await fetch(`${BASE_URL}/sync/changes`, {
        headers: { Authorization: `Bearer not-the-right-token` },
      });
      expect(res.status).toBe(401);
    });

    it("accepts the configured static bearer", async () => {
      const res = await syncGet("/sync/changes?cursor=0&limit=1");
      expect(res.status).toBe(200);
    });

    it("rejects /sync/push without Authorization header", async () => {
      // Regression: sync auth was only tested on the GET path. Both /sync/*
      // endpoints must sit behind the same auth boundary; a push endpoint that
      // silently accepted unauthenticated batches would let anyone with
      // network reach mutate the store.
      const res = await fetch(`${BASE_URL}/sync/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ops: [] }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects /sync/push with wrong bearer token", async () => {
      const res = await fetch(`${BASE_URL}/sync/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer not-the-right-token`,
        },
        body: JSON.stringify({ ops: [] }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("change log atomicity", () => {
    it("records exactly one change row per mutation", async () => {
      const cursorBefore = await getMaxSeq();

      const t = await callTool("create_task", {
        title: "Sync atomicity - task",
        scope: "personal",
      });
      expect(t.error).toBeUndefined();

      const res = await syncGet(`/sync/changes?cursor=${cursorBefore}&limit=100`);
      const body = await res.json();
      const rowsForTask = body.changes.filter(
        (c: any) => c.entity_type === "task" && c.entity_id === t.id
      );
      expect(rowsForTask.length).toBe(1);
      expect(rowsForTask[0].op).toBe("insert");
    });

    it("records notes and artifacts inserts too", async () => {
      const cursorBefore = await getMaxSeq();

      const n = await callTool("create_note", {
        title: "Sync atomicity - note",
        content: "checking change log",
        scope: "personal",
      });
      const a = await callTool("store_artifact", {
        title: "Sync atomicity - artifact",
        artifact_type: "cc-prompt",
        scope: "personal",
        content: "checking change log",
      });

      const res = await syncGet(`/sync/changes?cursor=${cursorBefore}&limit=100`);
      const body = await res.json();
      const noteRows = body.changes.filter(
        (c: any) => c.entity_type === "note" && c.entity_id === n.id
      );
      const artifactRows = body.changes.filter(
        (c: any) => c.entity_type === "artifact" && c.entity_id === a.id
      );
      expect(noteRows.length).toBe(1);
      expect(artifactRows.length).toBe(1);
    });
  });

  describe("cursor pull idempotency", () => {
    it("applying the same batch twice reaches the same end state", async () => {
      const cursorBefore = await getMaxSeq();

      const t = await callTool("create_task", {
        title: "Idempotent pull test",
        scope: "personal",
      });

      const first = await (await syncGet(`/sync/changes?cursor=${cursorBefore}&limit=50`)).json();
      const second = await (await syncGet(`/sync/changes?cursor=${cursorBefore}&limit=50`)).json();

      expect(first.next_cursor).toBe(second.next_cursor);
      expect(first.changes.length).toBe(second.changes.length);
      const firstKey = `task:${t.id}`;
      const snap1 = first.snapshots[firstKey];
      const snap2 = second.snapshots[firstKey];
      expect(snap1.id).toBe(snap2.id);
      expect(snap1.title).toBe(snap2.title);
    });
  });

  describe("push dedupe on op_uuid", () => {
    it("second push with same op_uuid returns dedup, not double-applied", async () => {
      const entityId = randomUUID();
      const opUuid = randomUUID();
      const op = {
        op_uuid: opUuid,
        entity_type: "task" as const,
        entity_id: entityId,
        op: "insert" as const,
        payload: { title: "Dedupe test", scope: "personal" },
      };

      const first = await (await syncPost("/sync/push", { ops: [op] })).json();
      expect(first.results[0].status).toBe("applied");

      const second = await (await syncPost("/sync/push", { ops: [op] })).json();
      expect(second.results[0].status).toBe("dedup");

      // Only one task should exist with that id.
      const gotten = await callTool("get_task", { id: entityId });
      expect(gotten.id).toBe(entityId);
    });
  });

  describe("individual stale-op rejection", () => {
    it("rejects one stale op while applying the neighbouring good op", async () => {
      // Set up: create an artifact, promote to ready. Then a client push
      // includes (a) a stale update on the artifact with expected_status=draft
      // — will conflict — and (b) a fresh note insert — must still apply.
      const a = await callTool("store_artifact", {
        title: "Batch reject victim",
        artifact_type: "cc-prompt",
        scope: "personal",
        content: "irrelevant",
      });
      await callTool("update_artifact", { id: a.id, status: "ready" });

      const goodOp = {
        op_uuid: randomUUID(),
        entity_type: "note" as const,
        entity_id: randomUUID(),
        op: "insert" as const,
        payload: { title: "Companion note", content: "still applies", scope: "personal" },
      };
      const staleOp = {
        op_uuid: randomUUID(),
        entity_type: "artifact" as const,
        entity_id: a.id,
        op: "update" as const,
        payload: { status: "executing" as const },
        precondition: { expected_status: "draft" }, // wrong — it's already 'ready'
      };

      const res = await (await syncPost("/sync/push", { ops: [staleOp, goodOp] })).json();
      const byUuid = new Map<string, any>(res.results.map((r: any) => [r.op_uuid, r]));
      expect(byUuid.get(staleOp.op_uuid).status).toBe("conflict");
      expect(byUuid.get(staleOp.op_uuid).conflict.reason).toBe("STATUS_CONFLICT");
      expect(byUuid.get(staleOp.op_uuid).conflict.current.status).toBe("ready");
      expect(byUuid.get(goodOp.op_uuid).status).toBe("applied");
    });
  });

  describe("sync push task expected_status precondition", () => {
    it("rejects a task status transition when the row has already advanced", async () => {
      // Reviewer item 3: MCP update_task got conditional-UPDATE, but the sync
      // task path was only checking base_updated_at. Post-fix, an expected_status
      // that no longer matches must return STATUS_CONFLICT with current state.
      const t = await callTool("create_task", {
        title: "Sync task status race",
        scope: "personal",
      });
      // Someone else already completed the task.
      await callTool("update_task", { id: t.id, action: "complete" });

      // Client push tries to defer, expecting status=open (stale).
      const staleOp = {
        op_uuid: randomUUID(),
        entity_type: "task" as const,
        entity_id: t.id,
        op: "update" as const,
        payload: { status: "deferred" as const },
        precondition: { expected_status: "open" },
      };
      const res = await (await syncPost("/sync/push", { ops: [staleOp] })).json();
      const result = res.results[0];
      expect(result.status).toBe("conflict");
      expect(result.conflict.reason).toBe("STATUS_CONFLICT");
      expect(result.conflict.current.status).toBe("completed");
    });

    it("applies the transition when expected_status matches", async () => {
      const t = await callTool("create_task", {
        title: "Sync task status match",
        scope: "personal",
      });
      const goodOp = {
        op_uuid: randomUUID(),
        entity_type: "task" as const,
        entity_id: t.id,
        op: "update" as const,
        payload: { status: "completed" as const },
        precondition: { expected_status: "open" },
      };
      const res = await (await syncPost("/sync/push", { ops: [goodOp] })).json();
      expect(res.results[0].status).toBe("applied");
      expect(res.results[0].snapshot.status).toBe("completed");
    });
  });

  describe("sync push STALE_BASE and NOT_FOUND paths", () => {
    it("returns STALE_BASE when base_updated_at is stale (task)", async () => {
      const t = await callTool("create_task", {
        title: "Sync stale-base task",
        scope: "personal",
      });
      const staleOp = {
        op_uuid: randomUUID(),
        entity_type: "task" as const,
        entity_id: t.id,
        op: "update" as const,
        payload: { title: "should not apply" },
        precondition: { base_updated_at: "1999-01-01T00:00:00.000Z" },
      };
      const res = await (await syncPost("/sync/push", { ops: [staleOp] })).json();
      expect(res.results[0].status).toBe("conflict");
      expect(res.results[0].conflict.reason).toBe("STALE_BASE");
      expect(res.results[0].conflict.current.id).toBe(t.id);
    });

    it("returns STALE_BASE when base_updated_at is stale (note)", async () => {
      const n = await callTool("create_note", {
        title: "Sync stale-base note",
        content: "before",
        scope: "personal",
      });
      const staleOp = {
        op_uuid: randomUUID(),
        entity_type: "note" as const,
        entity_id: n.id,
        op: "update" as const,
        payload: { content: "should not apply" },
        precondition: { base_updated_at: "1999-01-01T00:00:00.000Z" },
      };
      const res = await (await syncPost("/sync/push", { ops: [staleOp] })).json();
      expect(res.results[0].status).toBe("conflict");
      expect(res.results[0].conflict.reason).toBe("STALE_BASE");
    });

    it("returns NOT_FOUND when updating a nonexistent task via sync", async () => {
      const staleOp = {
        op_uuid: randomUUID(),
        entity_type: "task" as const,
        entity_id: randomUUID(),
        op: "update" as const,
        payload: { title: "orphan update" },
      };
      const res = await (await syncPost("/sync/push", { ops: [staleOp] })).json();
      expect(res.results[0].status).toBe("conflict");
      expect(res.results[0].conflict.reason).toBe("NOT_FOUND");
    });
  });

  describe("sync push body-size limits", () => {
    it("rejects push bodies larger than syncPushMaxBytes with 413", async () => {
      // Pack a single op with a >5MiB blob in payload. The per-request cap is
      // 5MiB by default, so this should be rejected before any op runs.
      const bigBlob = "x".repeat(6 * 1024 * 1024);
      const op = {
        op_uuid: randomUUID(),
        entity_type: "artifact" as const,
        entity_id: randomUUID(),
        op: "insert" as const,
        payload: {
          title: "too big",
          artifact_type: "cc-prompt",
          scope: "personal",
          content: bigBlob,
        },
      };
      const res = await syncPost("/sync/push", { ops: [op] });
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.code).toBe("PAYLOAD_TOO_LARGE");
    });

    it("rejects individual ops larger than syncPushMaxOpBytes with 413", async () => {
      // Single op larger than the per-op cap (128 KiB) but under the whole-
      // body cap (5 MiB). Should be rejected on the per-op check.
      const bigBlob = "y".repeat(200 * 1024);
      const op = {
        op_uuid: randomUUID(),
        entity_type: "note" as const,
        entity_id: randomUUID(),
        op: "insert" as const,
        payload: {
          title: "large note",
          content: bigBlob,
          scope: "personal",
        },
      };
      const res = await syncPost("/sync/push", { ops: [op] });
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.code).toBe("PAYLOAD_TOO_LARGE");
      expect(body.op_uuid).toBe(op.op_uuid);
    });
  });

  describe("conditional-UPDATE status transition race", () => {
    it("two writers with same expected_status: one wins, one loses cleanly", async () => {
      const a = await callTool("store_artifact", {
        title: "Race artifact",
        artifact_type: "cc-prompt",
        scope: "personal",
        content: "irrelevant",
      });
      await callTool("update_artifact", { id: a.id, status: "ready" });

      // Two concurrent transitions, both expecting the row is still 'ready'.
      // Under conditional-UPDATE, exactly one succeeds and the other returns
      // STATUS_CONFLICT with the current server state.
      const [r1, r2] = await Promise.all([
        callTool("update_artifact", {
          id: a.id,
          status: "executing",
          expected_status: "ready",
        }),
        callTool("update_artifact", {
          id: a.id,
          status: "superseded",
          expected_status: "ready",
        }),
      ]);

      const outcomes = [r1, r2];
      const conflicts = outcomes.filter((r) => r.code === "STATUS_CONFLICT");
      const applied = outcomes.filter((r) => !r.error);
      expect(applied.length).toBe(1);
      expect(conflicts.length).toBe(1);
      expect(conflicts[0].current.id).toBe(a.id);
    });
  });

  describe("patch_handoff expected_source precondition", () => {
    it("returns HANDOFF_CONFLICT when latest has moved", async () => {
      // Store a first handoff, then store another one to advance the pointer.
      const first = await callTool("store_handoff", {
        active_context: { arc: "first" },
      });
      expect(first.success).toBe(true);
      const staleFilename = first.filename;

      const second = await callTool("store_handoff", {
        active_context: { arc: "second" },
      });
      expect(second.success).toBe(true);
      expect(second.filename).not.toBe(staleFilename);

      // Now try to patch as if we still thought `first` was latest.
      const patchResult = await callTool("patch_handoff", {
        tone_notes: "should fail",
        expected_source: staleFilename,
      });
      expect(patchResult.error).toBe(true);
      expect(patchResult.code).toBe("HANDOFF_CONFLICT");
      expect(patchResult.current_source).toBe(second.filename);
    });

    it("still applies the patch when expected_source matches", async () => {
      const stored = await callTool("store_handoff", {
        active_context: { arc: "matching-source" },
      });
      expect(stored.success).toBe(true);

      const patchResult = await callTool("patch_handoff", {
        tone_notes: "applied cleanly",
        expected_source: stored.filename,
      });
      expect(patchResult.error).toBeUndefined();
      expect(patchResult.success).toBe(true);
    });
  });
});

// Helper: pull the current max seq from the changes table via /sync/changes.
// The suite uses this to know "everything before now" so that per-test
// assertions only look at freshly-written rows.
async function getMaxSeq(): Promise<string> {
  const res = await syncGet(`/sync/changes?cursor=0&limit=500`);
  const body = await res.json();
  // has_more must be false for the whole log to be visible; if a very large
  // test log accumulates, bump limit or paginate. For unit-scale tests, 500
  // is enough.
  return body.next_cursor;
}
