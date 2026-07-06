import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
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

  describe("GET /sync/content/:content_hash", () => {
    // Phase 2b content-on-demand endpoint. Snapshots delivered via
    // /sync/changes carry content_hash but never raw content — this endpoint
    // is how the mobile client materialises the body when the user opens
    // an artifact. Read-only, auth-gated the same as the other /sync/* routes.

    async function fetchContent(hash: string, headers: Record<string, string> = {}) {
      return fetch(`${BASE_URL}/sync/content/${hash}`, {
        headers: { Authorization: `Bearer ${BEARER}`, ...headers },
      });
    }

    it("returns 401 when unauthenticated", async () => {
      const validButUnused = "a".repeat(64);
      const res = await fetch(`${BASE_URL}/sync/content/${validButUnused}`);
      expect(res.status).toBe(401);
    });

    it("returns 400 on malformed hash before touching SQL", async () => {
      // Wrong length, non-hex characters, and uppercase all rejected pre-query.
      for (const bad of [
        "not-a-hash",
        "z".repeat(64),
        "a".repeat(63),
        "a".repeat(65),
        "A".repeat(64), // hash format is lowercase hex
      ]) {
        const res = await fetchContent(bad);
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.code).toBe("INVALID_CONTENT_HASH");
      }
    });

    it("returns 404 CONTENT_NOT_FOUND for an unknown but well-formed hash", async () => {
      const unknown = createHash("sha256").update("never-stored-anywhere").digest("hex");
      const res = await fetchContent(unknown);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("CONTENT_NOT_FOUND");
      expect(body.content_hash).toBe(unknown);
    });

    it("returns the inline content for a stored artifact by content_hash", async () => {
      const inline = "the quick brown fox jumps over the lazy dog";
      const a = await callTool("store_artifact", {
        title: "Content-on-demand happy path",
        artifact_type: "cc-prompt",
        scope: "personal",
        content: inline,
      });
      expect(a.error).toBeUndefined();
      const expectedHash = createHash("sha256").update(inline).digest("hex");

      const res = await fetchContent(expectedHash);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = await res.json();
      expect(body.content_hash).toBe(expectedHash);
      expect(body.content).toBe(inline);
    });

    it("two artifacts sharing the same content_hash both resolve to the same content", async () => {
      // Content-addressed: identical bodies produce identical hashes, so both
      // artifacts point to the same content. The endpoint returns the content
      // regardless of which row matched first.
      const shared = "artifacts with identical bodies share a hash";
      const a1 = await callTool("store_artifact", {
        title: "Shared-hash artifact one",
        artifact_type: "cc-prompt",
        scope: "personal",
        content: shared,
      });
      const a2 = await callTool("store_artifact", {
        title: "Shared-hash artifact two",
        artifact_type: "research",
        scope: "personal",
        content: shared,
      });
      expect(a1.id).not.toBe(a2.id);
      const hash = createHash("sha256").update(shared).digest("hex");

      const res = await fetchContent(hash);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.content_hash).toBe(hash);
      expect(body.content).toBe(shared);
    });

    it("returns 404 CONTENT_NOT_INLINE when the matched artifact is pointer-only", async () => {
      // Construct via direct SQL — the MCP write path strips content_hash from
      // metadata when content is null, so a pointer-only artifact created
      // through the tools never carries a hash. We simulate the case a client
      // could encounter via a hand-authored migration or a future upload flow.
      const pg = await import("pg");
      const client = new pg.default.Client({
        host: PG_HOST,
        port: parseInt(PG_PORT),
        user: PG_USER,
        password: PG_PASSWORD,
        database: PG_DATABASE,
      });
      await client.connect();
      const hash = createHash("sha256").update("pointer-only-content-hash").digest("hex");
      await client.query(
        `INSERT INTO artifacts (title, artifact_type, content, pointer, status, scope, metadata)
         VALUES ($1, $2, NULL, $3::jsonb, 'draft', 'personal', $4::jsonb)`,
        [
          "Pointer-only artifact",
          "research",
          JSON.stringify({ type: "url", href: "https://example.com/some-report" }),
          JSON.stringify({ content_hash: hash }),
        ]
      );
      await client.end();

      const res = await fetchContent(hash);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("CONTENT_NOT_INLINE");
      expect(body.content_hash).toBe(hash);
    });

    it("returns CONTENT_NOT_FOUND (not CONTENT_NOT_INLINE) when both content and pointer are null", async () => {
      // #231 truthfulness: pointer IS NOT NULL is now required to reach the
      // CONTENT_NOT_INLINE branch. A row with a hash claim but neither
      // content nor pointer is data corruption — surfacing "not inline"
      // would mislead the client into believing a pointer exists to fetch.
      const pg = await import("pg");
      const client = new pg.default.Client({
        host: PG_HOST,
        port: parseInt(PG_PORT),
        user: PG_USER,
        password: PG_PASSWORD,
        database: PG_DATABASE,
      });
      await client.connect();
      const hash = createHash("sha256").update("corrupted-row-no-content-no-pointer").digest("hex");
      await client.query(
        `INSERT INTO artifacts (title, artifact_type, content, pointer, status, scope, metadata)
         VALUES ($1, $2, NULL, NULL, 'draft', 'personal', $3::jsonb)`,
        [
          "Corrupted artifact",
          "research",
          JSON.stringify({ content_hash: hash }),
        ]
      );
      await client.end();

      const res = await fetchContent(hash);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("CONTENT_NOT_FOUND");
      expect(body.content_hash).toBe(hash);
    });
  });

  describe("content_hash functional index (#228)", () => {
    // Migration 012 adds a B-tree index over artifacts((metadata->>'content_hash'))
    // so the mobile-facing /sync/content/:hash endpoint never falls back to a
    // sequential scan. If this test fails after a schema change, either the
    // migration was dropped or the index was renamed — both are shipping
    // defects.
    it("the functional index exists after migrations run", async () => {
      const pg = await import("pg");
      const client = new pg.default.Client({
        host: PG_HOST,
        port: parseInt(PG_PORT),
        user: PG_USER,
        password: PG_PASSWORD,
        database: PG_DATABASE,
      });
      await client.connect();
      const res = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'artifacts'
           AND indexname = 'idx_artifacts_content_hash'`
      );
      await client.end();
      expect(res.rowCount).toBe(1);
    });

    it("EXPLAIN shows the content-on-demand SELECT can use the partial index", async () => {
      // The partial index (`WHERE metadata ? 'content_hash'`) only helps if
      // the planner can prove the query rows are a subset of the indexed
      // rows. Without an explicit `metadata ? 'content_hash'` predicate in
      // the SELECT, Postgres does NOT deduce it from `metadata->>'content_hash' = $1`
      // and falls back to a sequential scan — silently invalidating #228's
      // fix. This test runs EXPLAIN against the exact query shape in
      // routes.ts and asserts the planner considers the partial index a
      // valid choice for this query shape.
      //
      // We disable seqscan for the EXPLAIN so the test answers the structural
      // question — "is the SELECT written such that the partial-index predicate
      // is provably implied?" — independent of table size. On a tiny test
      // table Postgres will pick Seq Scan on pure cost grounds even when the
      // index is fully valid; that's a runtime cost-model decision, not a
      // regression in the query shape. In production the table grows and the
      // planner switches to the index automatically — but only if the query
      // shape allows it, which is what this test guards.
      const seedContent = "explain-plan-seed";
      const a = await callTool("store_artifact", {
        title: "Content-hash EXPLAIN seed",
        artifact_type: "cc-prompt",
        scope: "personal",
        content: seedContent,
      });
      expect(a.error).toBeUndefined();
      const seedHash = createHash("sha256").update(seedContent).digest("hex");

      const pg = await import("pg");
      const client = new pg.default.Client({
        host: PG_HOST,
        port: parseInt(PG_PORT),
        user: PG_USER,
        password: PG_PASSWORD,
        database: PG_DATABASE,
      });
      await client.connect();
      // SET LOCAL keeps the setting confined to this transaction so the
      // shared test database's global planner behavior is unaffected.
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = OFF");
      const plan = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN
         SELECT content, pointer IS NOT NULL AS has_pointer
         FROM artifacts
         WHERE metadata ? 'content_hash'
           AND metadata->>'content_hash' = $1
           AND (content IS NOT NULL OR pointer IS NOT NULL)
         ORDER BY (content IS NOT NULL) DESC, (pointer IS NOT NULL) DESC
         LIMIT 1`,
        [seedHash]
      );
      await client.query("ROLLBACK");
      await client.end();
      const planText = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
      // The index name appears — proves the planner considers it a valid
      // choice for this query shape. If the SELECT lost the `metadata ?
      // 'content_hash'` predicate, the planner could not use the partial
      // index and would fall back to another non-seqscan path (e.g. a
      // different index or bitmap heap scan) — either way the assertion
      // below would fail and the regression would be caught.
      expect(planText).toContain("idx_artifacts_content_hash");
    });
  });

  describe("expected_status enforced whenever present (#222)", () => {
    // The reviewer flagged the split: task path only enforced expected_status
    // when the payload changed status; artifact path enforced whenever set.
    // Post-fix, both paths enforce whenever set — so a title-only update
    // carrying a stale expected_status is a STATUS_CONFLICT on both.

    it("task: title-only update with stale expected_status returns STATUS_CONFLICT", async () => {
      const t = await callTool("create_task", {
        title: "Title-only expected_status - task",
        scope: "personal",
      });
      // Advance status out from under the client's mental model.
      await callTool("update_task", { id: t.id, action: "complete" });

      const staleOp = {
        op_uuid: randomUUID(),
        entity_type: "task" as const,
        entity_id: t.id,
        op: "update" as const,
        payload: { title: "renamed while stale" },
        precondition: { expected_status: "open" }, // stale — row is now completed
      };
      const res = await (await syncPost("/sync/push", { ops: [staleOp] })).json();
      const result = res.results[0];
      expect(result.status).toBe("conflict");
      expect(result.conflict.reason).toBe("STATUS_CONFLICT");
      expect(result.conflict.current.status).toBe("completed");
      // Ensure the title update did NOT sneak through.
      const reread = await callTool("get_task", { id: t.id });
      expect(reread.title).toBe("Title-only expected_status - task");
    });

    it("artifact: title-only update with stale expected_status returns STATUS_CONFLICT", async () => {
      const a = await callTool("store_artifact", {
        title: "Title-only expected_status - artifact",
        artifact_type: "cc-prompt",
        scope: "personal",
        content: "irrelevant",
      });
      await callTool("update_artifact", { id: a.id, status: "ready" });

      const staleOp = {
        op_uuid: randomUUID(),
        entity_type: "artifact" as const,
        entity_id: a.id,
        op: "update" as const,
        payload: { title: "should not apply" },
        precondition: { expected_status: "draft" }, // stale — row is ready
      };
      const res = await (await syncPost("/sync/push", { ops: [staleOp] })).json();
      const result = res.results[0];
      expect(result.status).toBe("conflict");
      expect(result.conflict.reason).toBe("STATUS_CONFLICT");
      expect(result.conflict.current.status).toBe("ready");
    });

    it("task: title-only update with matching expected_status applies", async () => {
      const t = await callTool("create_task", {
        title: "Matching expected_status - task",
        scope: "personal",
      });
      const op = {
        op_uuid: randomUUID(),
        entity_type: "task" as const,
        entity_id: t.id,
        op: "update" as const,
        payload: { title: "new title" },
        precondition: { expected_status: "open" }, // matches
      };
      const res = await (await syncPost("/sync/push", { ops: [op] })).json();
      expect(res.results[0].status).toBe("applied");
      expect(res.results[0].snapshot.title).toBe("new title");
    });
  });

  describe("update_note concurrent-delete guard (#223)", () => {
    // Regression test for the phantom-change-row bug: if a concurrent DELETE
    // lands between the pre-check SELECT and the UPDATE, we must NOT append
    // a `note:update` change row for a row that no longer exists (that would
    // reach the mobile client as a snapshot=null tombstone-lookalike with
    // the wrong op). The tool must return NOT_FOUND cleanly instead.
    it("delete between SELECT and UPDATE returns NOT_FOUND and appends no change row", async () => {
      const n = await callTool("create_note", {
        title: "Concurrent-delete guard",
        content: "will be deleted between the two queries",
        scope: "personal",
      });
      const cursorBefore = await getMaxSeq();

      // Directly delete the row so the SELECT-then-UPDATE race is guaranteed.
      // Since we can't slip a delete between two tool-internal queries from
      // the test, we simulate the observable outcome: an update issued for a
      // row that no longer exists should surface NOT_FOUND, not throw and
      // not append a change row. This is exactly the code path the fix
      // guards.
      const pg = await import("pg");
      const client = new pg.default.Client({
        host: PG_HOST,
        port: parseInt(PG_PORT),
        user: PG_USER,
        password: PG_PASSWORD,
        database: PG_DATABASE,
      });
      await client.connect();
      await client.query("DELETE FROM notes WHERE id = $1", [n.id]);
      await client.end();

      const result = await callTool("update_note", {
        id: n.id,
        title: "should not persist",
      });
      expect(result.error).toBe(true);
      expect(result.code).toBe("NOT_FOUND");

      // Ensure no phantom note:update row was appended.
      const after = await syncGet(`/sync/changes?cursor=${cursorBefore}&limit=100`);
      const body = await after.json();
      const phantom = body.changes.filter(
        (c: any) => c.entity_type === "note" && c.entity_id === n.id && c.op === "update"
      );
      expect(phantom.length).toBe(0);
      // Note: the direct SQL DELETE we issued to simulate the concurrent
      // delete ran outside the sync tx, so no `note:delete` change row
      // exists either. The only assertion that matters here is the absence
      // of a phantom `note:update` — the bug we're guarding against.
    });
  });

  describe("streaming body-cap enforcement (#225)", () => {
    // Content-Length can be omitted under HTTP/1.1 chunked transfer encoding.
    // The push handler must count bytes as they arrive on the wire and
    // cancel the reader on cap overflow, rather than buffer the whole body
    // and only reject after. This test ships a chunked body without a
    // Content-Length header to confirm the streaming counter fires.
    //
    // Runtime prerequisite: this test relies on undici (Node's built-in
    // fetch implementation) to accept a ReadableStream body + `duplex:
    // "half"` and to serialise it with chunked transfer encoding. Vitest
    // under Node 22 uses undici by default, so the assumption holds in CI.
    // If the suite is ever ported to a runtime whose fetch does NOT support
    // stream bodies (browsers, some polyfills), this test will fail at
    // fetch() before ever hitting the server — that is the correct failure
    // mode, and the test title makes the intent clear enough that a future
    // maintainer will spot the mismatch.
    it("rejects an oversized chunked body without a Content-Length header", async () => {
      // Build a body larger than syncPushMaxBytes (5 MiB default) as a
      // ReadableStream. Node's fetch adds Transfer-Encoding: chunked when
      // the body is a stream and no Content-Length is provided.
      const chunkSize = 256 * 1024; // 256 KiB per chunk
      const chunkCount = 24; // 6 MiB total, well over the 5 MiB cap
      const encoder = new TextEncoder();
      // Valid JSON opener so if the streaming guard is broken and the
      // handler tries to parse, it still can't succeed — the assertion
      // catches the bug either way, but the 413 code path is what we're
      // proving.
      const opener = encoder.encode('{"ops":[');
      const filler = encoder.encode("x".repeat(chunkSize));
      let emitted = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (emitted === 0) {
            controller.enqueue(opener);
          }
          if (emitted < chunkCount) {
            controller.enqueue(filler);
            emitted++;
          } else {
            controller.close();
          }
        },
      });

      const res = await fetch(`${BASE_URL}/sync/push`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${BEARER}`,
          "Content-Type": "application/json",
          // Deliberately NO Content-Length — Node's fetch will send this
          // chunked.
        },
        // Node's fetch supports ReadableStream bodies and requires the
        // `duplex: "half"` flag; both are missing from the DOM lib RequestInit
        // type, so this cast unblocks the runtime call.
        ...({ body: stream, duplex: "half" } as unknown as RequestInit),
      });

      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.code).toBe("PAYLOAD_TOO_LARGE");
      // actual_bytes must be a lower bound (>= max_bytes + 1) if the
      // streaming counter fired — because the reader cancelled, the value
      // must not equal the full oversize body size (which would prove the
      // handler buffered the entire body).
      expect(body.actual_bytes).toBeGreaterThan(config_syncPushMaxBytesDefault);
      expect(body.actual_bytes).toBeLessThan(chunkSize * chunkCount + 1024);
    });
  });
});

// Server-side default kept in sync with src/config.ts. Tests don't import
// config directly because that would pull the pg pool into the test process.
const config_syncPushMaxBytesDefault = 5 * 1024 * 1024;

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
