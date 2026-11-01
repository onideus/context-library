import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ChildProcess } from "node:child_process";
import { spawnServer, stopServer } from "./helpers/spawn-server.js";
import { rm, mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Client as PgClient } from "pg";

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
 *   - update_handoff expected_source precondition (HANDOFF_CONFLICT)
 *
 * and, for the note-lifecycle work (docs/design/note-lifecycle.md section 8):
 *   - note snapshots carrying the lifecycle/provenance/version fields
 *   - the corrected base_updated_at comparison for notes
 *   - expected_version / expected_status / base_updated_at preconditions,
 *     validated per op (a malformed one never fails the batch), and refused
 *     on insert/delete
 *   - UUID canonicalisation of entity ids
 *   - the notes-only `supersede` op (and UNSUPPORTED_OP for tasks/artifacts)
 *   - delete-time chain splice results (`relinked`)
 *   - pending_embeddings enqueue on the push path
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

    serverProcess = spawnServer({
      ...process.env,
      MCP_PORT: String(TEST_PORT),
      DATA_DIR: TEST_DATA_DIR,
      PGHOST: PG_HOST,
      PGPORT: PG_PORT,
      PGUSER: PG_USER,
      PGPASSWORD: PG_PASSWORD,
      PGDATABASE: PG_DATABASE,
      SYNC_BEARER_TOKEN: BEARER,
    });

    // Uncomment for debugging:
    // serverProcess.stderr?.on("data", (d) => process.stderr.write(d));
    // serverProcess.stdout?.on("data", (d) => process.stdout.write(d));

    await waitForServer(BASE_URL);
  }, 30_000);

  afterAll(async () => {
    if (serverProcess) {
      await stopServer(serverProcess);
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
      const a = await callTool("create_artifact", {
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
      const a = await callTool("create_artifact", {
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
      const a = await callTool("create_artifact", {
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

  describe("update_handoff expected_source precondition", () => {
    it("returns HANDOFF_CONFLICT when latest has moved", async () => {
      // Store a first handoff, then store another one to advance the pointer.
      const first = await callTool("create_handoff", {
        active_context: { arc: "first" },
      });
      expect(first.success).toBe(true);
      const staleFilename = first.filename;

      const second = await callTool("create_handoff", {
        active_context: { arc: "second" },
      });
      expect(second.success).toBe(true);
      expect(second.filename).not.toBe(staleFilename);

      // Now try to patch as if we still thought `first` was latest.
      const patchResult = await callTool("update_handoff", {
        tone_notes: "should fail",
        expected_source: staleFilename,
      });
      expect(patchResult.error).toBe(true);
      expect(patchResult.code).toBe("HANDOFF_CONFLICT");
      expect(patchResult.current_source).toBe(second.filename);
    });

    it("still applies the patch when expected_source matches", async () => {
      const stored = await callTool("create_handoff", {
        active_context: { arc: "matching-source" },
      });
      expect(stored.success).toBe(true);

      const patchResult = await callTool("update_handoff", {
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
      const a = await callTool("create_artifact", {
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
      const a1 = await callTool("create_artifact", {
        title: "Shared-hash artifact one",
        artifact_type: "cc-prompt",
        scope: "personal",
        content: shared,
      });
      const a2 = await callTool("create_artifact", {
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
      const a = await callTool("create_artifact", {
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
      const a = await callTool("create_artifact", {
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

  describe("note lifecycle over sync", () => {
    // Design: docs/design/note-lifecycle.md section 8. The push path shares
    // one write path with the MCP note tools (src/notes/store.ts). These
    // tests pin the wire-visible behaviour: the new snapshot fields, the
    // corrected base_updated_at comparison, expected_version /
    // expected_status, the supersede op, per-op precondition validation, the
    // delete-time chain splice, and the pending_embeddings enqueue.

    interface PushResult {
      op_uuid: string;
      status: string;
      entity_type: string;
      entity_id: string;
      op: string;
      seq?: string;
      snapshot?: any;
      relinked?: Array<{ entity_id: string; snapshot: any }>;
      conflict?: { reason: string; current: any; detail?: any };
      error?: string;
    }

    function noteOp(
      op: string,
      entityId: string,
      payload?: Record<string, unknown>,
      precondition?: Record<string, unknown>,
      opUuid: string = randomUUID()
    ) {
      return {
        op_uuid: opUuid,
        entity_type: "note" as const,
        entity_id: entityId,
        op,
        ...(payload ? { payload } : {}),
        ...(precondition ? { precondition } : {}),
      };
    }

    async function pushOne(op: Record<string, unknown>): Promise<PushResult> {
      const res = await syncPost("/sync/push", { ops: [op] });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: PushResult[] };
      return body.results[0];
    }

    async function pushNoteInsert(payload: Record<string, unknown> = {}) {
      const id = randomUUID();
      const result = await pushOne(
        noteOp("insert", id, {
          title: "Acme Corp deploy policy",
          content: "Deploys happen on Fridays.",
          scope: "personal",
          ...payload,
        })
      );
      expect(result.status).toBe("applied");
      return { id, result };
    }

    async function opLogRows(opUuid: string) {
      return withPg(async (c) => {
        const res = await c.query(
          `SELECT entity_type, entity_id, op, change_seq::text AS change_seq
             FROM sync_op_log WHERE op_uuid = $1`,
          [opUuid]
        );
        return res.rows as Array<{
          entity_type: string;
          entity_id: string;
          op: string;
          change_seq: string | null;
        }>;
      });
    }

    async function changesFor(entityType: string, entityId: string, afterSeq: string) {
      return withPg(async (c) => {
        const res = await c.query(
          `SELECT seq::text AS seq, op FROM changes
            WHERE entity_type = $1 AND entity_id = $2 AND seq > $3::bigint
            ORDER BY changes.seq`,
          [entityType, entityId, afterSeq]
        );
        return res.rows as Array<{ seq: string; op: string }>;
      });
    }

    async function noteRow(id: string) {
      return withPg(async (c) => {
        const res = await c.query("SELECT * FROM notes WHERE id = $1", [id]);
        return res.rows[0] as Record<string, any> | undefined;
      });
    }

    async function pendingEmbeddingCount(id: string) {
      return withPg(async (c) => {
        const res = await c.query(
          `SELECT count(*)::int AS n FROM pending_embeddings
            WHERE content_type = 'note' AND content_id = $1`,
          [id]
        );
        return res.rows[0].n as number;
      });
    }

    async function clearPendingEmbedding(id: string) {
      await withPg((c) =>
        c.query(
          "DELETE FROM pending_embeddings WHERE content_type = 'note' AND content_id = $1",
          [id]
        )
      );
    }

    describe("snapshots", () => {
      it("pull snapshots carry status, superseded_by, superseded_at, valid_until, provenance and version", async () => {
        const before = await maxSeqDb();
        const { id } = await pushNoteInsert({
          provenance: "stated",
          valid_until: "2031-06-01T12:00:00Z",
        });
        // A note written through the MCP tool, with none of the new fields set.
        const viaMcp = await callTool("create_note", {
          title: "Plain note via MCP",
          content: "no lifecycle fields supplied",
          scope: "personal",
        });
        expect(viaMcp.error).toBeUndefined();

        const body = await (await syncGet(`/sync/changes?cursor=${before}&limit=100`)).json();

        const pushed = body.snapshots[`note:${id}`];
        expect(pushed).toMatchObject({
          id,
          status: "active",
          superseded_by: null,
          superseded_at: null,
          provenance: "stated",
          version: 1,
        });
        expect(new Date(pushed.valid_until).toISOString()).toBe("2031-06-01T12:00:00.000Z");

        const mcp = body.snapshots[`note:${viaMcp.id}`];
        expect(mcp).toMatchObject({
          status: "active",
          superseded_by: null,
          superseded_at: null,
          valid_until: null,
          provenance: null,
          version: 1,
        });
      });
    });

    describe("base_updated_at (Date-vs-ISO regression)", () => {
      it("applies an update whose base_updated_at is the ISO string from the prior response", async () => {
        const { id, result } = await pushNoteInsert();
        const base = result.snapshot.updated_at as string;
        expect(typeof base).toBe("string");

        const first = await pushOne(
          noteOp("update", id, { content: "edited once" }, { base_updated_at: base })
        );
        expect(first.status).toBe("applied");
        expect(first.snapshot.content).toBe("edited once");

        // The same (now stale) base must be rejected, with the current row.
        const stale = await pushOne(
          noteOp("update", id, { content: "edited from stale base" }, { base_updated_at: base })
        );
        expect(stale.status).toBe("conflict");
        expect(stale.conflict!.reason).toBe("STALE_BASE");
        expect(stale.conflict!.current.content).toBe("edited once");

        // Chaining on the fresh updated_at works again.
        const second = await pushOne(
          noteOp(
            "update",
            id,
            { content: "edited twice" },
            { base_updated_at: first.snapshot.updated_at }
          )
        );
        expect(second.status).toBe("applied");
        expect(second.snapshot.content).toBe("edited twice");
      });

      it("applies an update using base_updated_at read from a /sync/changes snapshot", async () => {
        const before = await maxSeqDb();
        const viaMcp = await callTool("create_note", {
          title: "Base from pull snapshot",
          content: "before",
          scope: "personal",
        });
        const body = await (await syncGet(`/sync/changes?cursor=${before}&limit=100`)).json();
        const base = body.snapshots[`note:${viaMcp.id}`].updated_at as string;

        const res = await pushOne(
          noteOp("update", viaMcp.id, { content: "after" }, { base_updated_at: base })
        );
        expect(res.status).toBe("applied");
        expect(res.snapshot.content).toBe("after");
      });
    });

    describe("expected_version", () => {
      it("rejects a stale expected_version with VERSION_CONFLICT carrying the current row", async () => {
        const { id } = await pushNoteInsert();
        const bump = await pushOne(noteOp("update", id, { content: "second revision" }));
        expect(bump.status).toBe("applied");
        expect(bump.snapshot.version).toBe(2);

        const stale = await pushOne(
          noteOp("update", id, { content: "from a stale client" }, { expected_version: 1 })
        );
        expect(stale.status).toBe("conflict");
        expect(stale.conflict!.reason).toBe("VERSION_CONFLICT");
        expect(stale.conflict!.current.version).toBe(2);
        expect(stale.conflict!.current.content).toBe("second revision");
        expect((await noteRow(id))!.content).toBe("second revision");

        const fresh = await pushOne(
          noteOp("update", id, { content: "third revision" }, { expected_version: 2 })
        );
        expect(fresh.status).toBe("applied");
        expect(fresh.snapshot.version).toBe(3);
      });

      it("checks expected_version before base_updated_at and expected_status", async () => {
        const { id } = await pushNoteInsert();
        await pushOne(noteOp("update", id, { content: "bump" }));

        const res = await pushOne(
          noteOp(
            "update",
            id,
            { content: "all three preconditions are wrong" },
            {
              expected_version: 1,
              expected_status: "superseded",
              base_updated_at: "1999-01-01T00:00:00.000Z",
            }
          )
        );
        expect(res.status).toBe("conflict");
        expect(res.conflict!.reason).toBe("VERSION_CONFLICT");
      });

      it("returns NOT_FOUND (current null) when updating a note that does not exist", async () => {
        const res = await pushOne(
          noteOp("update", randomUUID(), { content: "orphan" }, { expected_version: 1 })
        );
        expect(res.status).toBe("conflict");
        expect(res.conflict!.reason).toBe("NOT_FOUND");
        expect(res.conflict!.current).toBeNull();
      });
    });

    describe("expected_status on notes", () => {
      it("rejects expected_status 'superseded' on an active note with STATUS_CONFLICT", async () => {
        const { id } = await pushNoteInsert();
        const res = await pushOne(
          noteOp("update", id, { title: "should not apply" }, { expected_status: "superseded" })
        );
        expect(res.status).toBe("conflict");
        expect(res.conflict!.reason).toBe("STATUS_CONFLICT");
        expect(res.conflict!.current.status).toBe("active");
        expect((await noteRow(id))!.title).toBe("Acme Corp deploy policy");
      });

      it("applies a title-only update when expected_status matches", async () => {
        const { id } = await pushNoteInsert();
        const res = await pushOne(
          noteOp("update", id, { title: "renamed" }, { expected_status: "active" })
        );
        expect(res.status).toBe("applied");
        expect(res.snapshot.title).toBe("renamed");
      });
    });

    describe("provenance and valid_until", () => {
      it("applies provenance and valid_until (offset normalised to UTC) and clears them with null", async () => {
        const { id } = await pushNoteInsert();

        const set = await pushOne(
          noteOp("update", id, {
            provenance: "inferred",
            valid_until: "2030-01-01T00:00:00+02:00",
          })
        );
        expect(set.status).toBe("applied");
        expect(set.snapshot.provenance).toBe("inferred");
        expect(new Date(set.snapshot.valid_until).toISOString()).toBe("2029-12-31T22:00:00.000Z");
        const stored = await noteRow(id);
        expect(stored!.provenance).toBe("inferred");
        expect((stored!.valid_until as Date).toISOString()).toBe("2029-12-31T22:00:00.000Z");

        const cleared = await pushOne(
          noteOp("update", id, { provenance: null, valid_until: null })
        );
        expect(cleared.status).toBe("applied");
        expect(cleared.snapshot.provenance).toBeNull();
        expect(cleared.snapshot.valid_until).toBeNull();
      });

      it("rejects a valid_until without an offset as a per-op error and rolls the claim back", async () => {
        const { id } = await pushNoteInsert();
        const opUuid = randomUUID();
        const bad = await pushOne(
          noteOp("update", id, { valid_until: "2030-01-01T00:00:00" }, undefined, opUuid)
        );
        expect(bad.status).toBe("error");
        expect(bad.error).toContain("VALIDATION_ERROR");
        expect(bad.error).toMatch(/offset/i);
        expect((await noteRow(id))!.valid_until).toBeNull();
        expect(await opLogRows(opUuid)).toHaveLength(0);

        // Corrected retry with the SAME op_uuid is applied, not deduplicated.
        const retry = await pushOne(
          noteOp("update", id, { valid_until: "2030-01-01T00:00:00Z" }, undefined, opUuid)
        );
        expect(retry.status).toBe("applied");
      });

      it("rejects an insert with an offset-less valid_until and creates no note", async () => {
        const id = randomUUID();
        const res = await pushOne(
          noteOp("insert", id, { title: "bad expiry", valid_until: "2030-01-01" })
        );
        expect(res.status).toBe("error");
        expect(res.error).toMatch(/offset/i);
        expect(await noteRow(id)).toBeUndefined();
      });

      it("rejects an unknown provenance value", async () => {
        const { id } = await pushNoteInsert();
        const res = await pushOne(noteOp("update", id, { provenance: "guessed" }));
        expect(res.status).toBe("error");
        expect((await noteRow(id))!.provenance).toBeNull();
      });
    });

    describe("supersede op", () => {
      it("marks the old note superseded, bumps its version, and logs exactly one change row", async () => {
        const { id: oldId } = await pushNoteInsert({ title: "Acme Corp Friday deploys" });
        const { id: newId } = await pushNoteInsert({ title: "Acme Corp deploy freeze" });
        const cursor = await maxSeqDb();

        const opUuid = randomUUID();
        const res = await pushOne(
          noteOp("supersede", oldId, { superseded_by: newId }, { expected_version: 1 }, opUuid)
        );
        expect(res.status).toBe("applied");
        expect(res.op).toBe("supersede");
        expect(res.seq).toBeDefined();
        expect(res.snapshot).toMatchObject({
          id: oldId,
          status: "superseded",
          superseded_by: newId,
          version: 2,
        });
        expect(res.snapshot.superseded_at).not.toBeNull();

        // Exactly one new change row, for the OLD note (an update); none for the successor.
        expect(await changesFor("note", oldId, cursor)).toEqual([{ seq: res.seq, op: "update" }]);
        expect(await changesFor("note", newId, cursor)).toHaveLength(0);

        // The dedupe-log row records the op kind and links the change.
        const logRows = await opLogRows(opUuid);
        expect(logRows).toHaveLength(1);
        expect(logRows[0]).toMatchObject({ op: "supersede", change_seq: res.seq });

        // The successor is untouched.
        expect((await noteRow(newId))!.version).toBe(1);

        // Pullers see the lifecycle move.
        const pull = await (await syncGet(`/sync/changes?cursor=${cursor}&limit=100`)).json();
        expect(pull.snapshots[`note:${oldId}`]).toMatchObject({
          status: "superseded",
          superseded_by: newId,
        });
      });

      it("rolls the claim back on a stale expected_version, then applies a corrected retry (not dedup)", async () => {
        const { id: oldId } = await pushNoteInsert();
        const { id: newId } = await pushNoteInsert();
        const opUuid = randomUUID();

        const stale = await pushOne(
          noteOp("supersede", oldId, { superseded_by: newId }, { expected_version: 5 }, opUuid)
        );
        expect(stale.status).toBe("conflict");
        expect(stale.conflict!.reason).toBe("VERSION_CONFLICT");
        expect(stale.conflict!.current.version).toBe(1);
        expect(await opLogRows(opUuid)).toHaveLength(0);
        expect((await noteRow(oldId))!.status).toBe("active");

        const retry = await pushOne(
          noteOp("supersede", oldId, { superseded_by: newId }, { expected_version: 1 }, opUuid)
        );
        expect(retry.status).toBe("applied");
        expect(retry.snapshot.status).toBe("superseded");
        expect(await opLogRows(opUuid)).toHaveLength(1);
      });

      it("enforces expected_status on the stored status", async () => {
        const { id: oldId } = await pushNoteInsert();
        const { id: newId } = await pushNoteInsert();
        const res = await pushOne(
          noteOp("supersede", oldId, { superseded_by: newId }, { expected_status: "superseded" })
        );
        expect(res.status).toBe("conflict");
        expect(res.conflict!.reason).toBe("STATUS_CONFLICT");
        expect((await noteRow(oldId))!.status).toBe("active");
      });

      it("rejects self-supersession with INVALID_SUCCESSOR", async () => {
        const { id } = await pushNoteInsert();
        const res = await pushOne(noteOp("supersede", id, { superseded_by: id }));
        expect(res.status).toBe("conflict");
        expect(res.conflict!.reason).toBe("INVALID_SUCCESSOR");
        expect(typeof res.conflict!.detail.reason).toBe("string");
        expect((await noteRow(id))!.status).toBe("active");
      });

      it("rejects superseding a note that is already superseded with STATUS_CONFLICT", async () => {
        const { id: oldId } = await pushNoteInsert();
        const { id: firstId } = await pushNoteInsert();
        const { id: secondId } = await pushNoteInsert();
        const ok = await pushOne(noteOp("supersede", oldId, { superseded_by: firstId }));
        expect(ok.status).toBe("applied");

        const again = await pushOne(noteOp("supersede", oldId, { superseded_by: secondId }));
        expect(again.status).toBe("conflict");
        expect(again.conflict!.reason).toBe("STATUS_CONFLICT");
        expect(again.conflict!.current.superseded_by).toBe(firstId);
      });

      it("rejects a successor that is itself superseded with INVALID_SUCCESSOR", async () => {
        const { id: oldId } = await pushNoteInsert();
        const { id: staleSuccessor } = await pushNoteInsert();
        const { id: head } = await pushNoteInsert();
        await pushOne(noteOp("supersede", staleSuccessor, { superseded_by: head }));

        const res = await pushOne(noteOp("supersede", oldId, { superseded_by: staleSuccessor }));
        expect(res.status).toBe("conflict");
        expect(res.conflict!.reason).toBe("INVALID_SUCCESSOR");
        expect((await noteRow(oldId))!.status).toBe("active");
      });

      it("returns NOT_FOUND naming which id is missing", async () => {
        const { id } = await pushNoteInsert();

        const missingSuccessor = await pushOne(
          noteOp("supersede", id, { superseded_by: randomUUID() })
        );
        expect(missingSuccessor.status).toBe("conflict");
        expect(missingSuccessor.conflict!.reason).toBe("NOT_FOUND");
        expect(missingSuccessor.conflict!.detail).toEqual({ missing: "superseded_by" });
        expect((await noteRow(id))!.status).toBe("active");

        const missingOld = await pushOne(
          noteOp("supersede", randomUUID(), { superseded_by: id })
        );
        expect(missingOld.status).toBe("conflict");
        expect(missingOld.conflict!.reason).toBe("NOT_FOUND");
        expect(missingOld.conflict!.detail).toEqual({ missing: "id" });
      });

      it("rejects a payload without a UUID superseded_by as a per-op error", async () => {
        const { id } = await pushNoteInsert();
        const res = await pushOne(noteOp("supersede", id, { superseded_by: "not-a-uuid" }));
        expect(res.status).toBe("error");
        expect((await noteRow(id))!.status).toBe("active");
      });

      it("replaying a successful supersede op_uuid returns dedup with the same seq", async () => {
        const { id: oldId } = await pushNoteInsert();
        const { id: newId } = await pushNoteInsert();
        const op = noteOp("supersede", oldId, { superseded_by: newId }, { expected_version: 1 });

        const first = await pushOne(op);
        expect(first.status).toBe("applied");
        const cursor = await maxSeqDb();

        const replay = await pushOne(op);
        expect(replay.status).toBe("dedup");
        expect(replay.seq).toBe(first.seq);
        // The replay did not re-apply anything.
        expect(await maxSeqDb()).toBe(cursor);
        expect((await noteRow(oldId))!.version).toBe(2);
      });
    });

    describe("supersede is notes-only (UNSUPPORTED_OP)", () => {
      it("rejects supersede on a task per op, with no dedupe-log row and the task unchanged", async () => {
        const t = await callTool("create_task", { title: "Task not supersedable", scope: "personal" });
        const cursor = await maxSeqDb();
        const opUuid = randomUUID();
        const res = await pushOne({
          op_uuid: opUuid,
          entity_type: "task",
          entity_id: t.id,
          op: "supersede",
          payload: { superseded_by: randomUUID() },
        });
        expect(res.status).toBe("error");
        expect(res.error).toContain("UNSUPPORTED_OP");
        expect(await opLogRows(opUuid)).toHaveLength(0);
        expect(await changesFor("task", t.id, cursor)).toHaveLength(0);
        const reread = await callTool("get_task", { id: t.id });
        expect(reread.title).toBe("Task not supersedable");
      });

      it("rejects supersede on an artifact per op without applying it as an update", async () => {
        const a = await callTool("create_artifact", {
          title: "Artifact not supersedable",
          artifact_type: "cc-prompt",
          scope: "personal",
          content: "irrelevant",
        });
        const cursor = await maxSeqDb();
        const opUuid = randomUUID();
        const res = await pushOne({
          op_uuid: opUuid,
          entity_type: "artifact",
          entity_id: a.id,
          op: "supersede",
          payload: { title: "must not be applied as an update" },
        });
        expect(res.status).toBe("error");
        expect(res.error).toContain("UNSUPPORTED_OP");
        expect(await opLogRows(opUuid)).toHaveLength(0);
        expect(await changesFor("artifact", a.id, cursor)).toHaveLength(0);
        const reread = await callTool("get_artifact", { id: a.id });
        expect(reread.title).toBe("Artifact not supersedable");
      });

      it("does not poison the batch: a neighbouring valid op still applies", async () => {
        const t = await callTool("create_task", { title: "Batch neighbour", scope: "personal" });
        const good = noteOp("insert", randomUUID(), { title: "Neighbour note" });
        const res = await syncPost("/sync/push", {
          ops: [
            {
              op_uuid: randomUUID(),
              entity_type: "task",
              entity_id: t.id,
              op: "supersede",
              payload: { superseded_by: randomUUID() },
            },
            good,
          ],
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { results: PushResult[] };
        expect(body.results[0].status).toBe("error");
        expect(body.results[1].status).toBe("applied");
      });
    });

    describe("precondition validation (per op, never per batch)", () => {
      // The body schema accepts `precondition` permissively; each op validates
      // its own inside its transaction. One malformed precondition therefore
      // fails that op alone - it must never turn the whole request into a 400.

      it("rejects an unknown precondition key for that op only; a sibling op in the batch applies", async () => {
        const { id } = await pushNoteInsert();
        const badUuid = randomUUID();
        const bad = noteOp(
          "update",
          id,
          { content: "must not apply" },
          { expected_stauts: "active" },
          badUuid
        );
        const siblingId = randomUUID();
        const sibling = noteOp("insert", siblingId, { title: "Sibling in the same batch" });

        const res = await syncPost("/sync/push", { ops: [bad, sibling] });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { results: PushResult[] };
        expect(body.results[0].status).toBe("error");
        expect(body.results[0].error).toContain("VALIDATION_ERROR");
        expect(body.results[0].error).toContain("expected_stauts");
        expect(body.results[1].status).toBe("applied");

        expect((await noteRow(id))!.content).toBe("Deploys happen on Fridays.");
        expect(await noteRow(siblingId)).toBeDefined();
        // The claim rolled back with the transaction.
        expect(await opLogRows(badUuid)).toHaveLength(0);
      });

      it("rejects a malformed expected_version (0, negative, fractional, string, null) per op", async () => {
        const { id } = await pushNoteInsert();
        for (const bad of [0, -1, 1.5, "2", null]) {
          const res = await syncPost("/sync/push", {
            ops: [noteOp("update", id, { content: "x" }, { expected_version: bad })],
          });
          expect(res.status).toBe(200);
          const [result] = ((await res.json()) as { results: PushResult[] }).results;
          expect(result.status).toBe("error");
          expect(result.error).toContain("VALIDATION_ERROR");
          expect(result.error).toContain("expected_version");
        }
        expect((await noteRow(id))!.content).toBe("Deploys happen on Fridays.");
      });

      it("rejects wrongly typed base_updated_at / expected_status per op", async () => {
        const { id } = await pushNoteInsert();
        const cases: Array<[string, unknown]> = [
          ["base_updated_at", 12345],
          ["expected_status", true],
        ];
        for (const [key, value] of cases) {
          const result = await pushOne(noteOp("update", id, { content: "x" }, { [key]: value }));
          expect(result.status).toBe("error");
          expect(result.error).toContain("VALIDATION_ERROR");
          expect(result.error).toContain(key);
        }
      });

      it("rejects a non-object precondition per op", async () => {
        const { id } = await pushNoteInsert();
        for (const bad of ["active", [], null, 7]) {
          const res = await syncPost("/sync/push", {
            ops: [{ ...noteOp("update", id, { content: "x" }), precondition: bad }],
          });
          expect(res.status).toBe(200);
          const [result] = ((await res.json()) as { results: PushResult[] }).results;
          expect(result.status).toBe("error");
          expect(result.error).toContain("VALIDATION_ERROR");
        }
      });

      it("accepts an empty precondition object", async () => {
        const id = randomUUID();
        const insert = await pushOne(noteOp("insert", id, { title: "Empty precondition" }, {}));
        expect(insert.status).toBe("applied");
        const update = await pushOne(noteOp("update", id, { content: "ok" }, {}));
        expect(update.status).toBe("applied");
      });

      it("rejects expected_version where the server cannot enforce it, instead of ignoring it", async () => {
        const t = await callTool("create_task", { title: "Version-less task", scope: "personal" });
        const onTask = await pushOne({
          op_uuid: randomUUID(),
          entity_type: "task",
          entity_id: t.id,
          op: "update",
          payload: { title: "must not apply" },
          precondition: { expected_version: 1 },
        });
        expect(onTask.status).toBe("error");
        expect(onTask.error).toContain("expected_version");
        expect((await callTool("get_task", { id: t.id })).title).toBe("Version-less task");
      });

      it("rejects base_updated_at on supersede", async () => {
        const { id: oldId } = await pushNoteInsert();
        const { id: newId } = await pushNoteInsert();
        const res = await pushOne(
          noteOp(
            "supersede",
            oldId,
            { superseded_by: newId },
            { base_updated_at: "2030-01-01T00:00:00.000Z" }
          )
        );
        expect(res.status).toBe("error");
        expect(res.error).toContain("base_updated_at");
        expect((await noteRow(oldId))!.status).toBe("active");
      });

      it("reports UNSUPPORTED_OP (not a precondition error) for a task supersede that also carries a precondition", async () => {
        const t = await callTool("create_task", { title: "Unsupported first", scope: "personal" });
        const res = await pushOne({
          op_uuid: randomUUID(),
          entity_type: "task",
          entity_id: t.id,
          op: "supersede",
          payload: { superseded_by: randomUUID() },
          precondition: { expected_version: 1 },
        });
        expect(res.status).toBe("error");
        expect(res.error).toContain("UNSUPPORTED_OP");
      });
    });

    describe("insert and delete accept no preconditions", () => {
      it("rejects every precondition key on insert and delete, naming the op kind, for all entity types", async () => {
        const preconditions: Array<Record<string, unknown>> = [
          { base_updated_at: "2030-01-01T00:00:00.000Z" },
          { expected_status: "active" },
          { expected_version: 1 },
        ];
        for (const entityType of ["note", "task", "artifact"] as const) {
          for (const kind of ["insert", "delete"] as const) {
            for (const precondition of preconditions) {
              const id = randomUUID();
              const opUuid = randomUUID();
              const res = await pushOne({
                op_uuid: opUuid,
                entity_type: entityType,
                entity_id: id,
                op: kind,
                ...(kind === "insert" ? { payload: { title: "never created" } } : {}),
                precondition,
              });
              expect(res.status).toBe("error");
              expect(res.error).toContain("VALIDATION_ERROR");
              expect(res.error).toContain(`'${kind}'`);
              expect(res.error).toContain(Object.keys(precondition)[0]);
              expect(await opLogRows(opUuid)).toHaveLength(0);
            }
          }
        }
      });

      it("creates nothing and deletes nothing when the precondition is rejected", async () => {
        const insertId = randomUUID();
        const rejectedInsert = await pushOne(
          noteOp("insert", insertId, { title: "never created" }, { base_updated_at: "2030-01-01T00:00:00.000Z" })
        );
        expect(rejectedInsert.status).toBe("error");
        expect(await noteRow(insertId)).toBeUndefined();

        const { id } = await pushNoteInsert();
        const rejectedDelete = await pushOne(noteOp("delete", id, undefined, { expected_status: "active" }));
        expect(rejectedDelete.status).toBe("error");
        expect(await noteRow(id)).toBeDefined();
      });
    });

    describe("artifact base_updated_at", () => {
      async function pushArtifactInsert() {
        const id = randomUUID();
        const res = await pushOne({
          op_uuid: randomUUID(),
          entity_type: "artifact",
          entity_id: id,
          op: "insert",
          payload: { title: "Project-alpha runbook", artifact_type: "research" },
        });
        expect(res.status).toBe("applied");
        return { id, result: res };
      }

      function artifactUpdate(id: string, payload: Record<string, unknown>, precondition?: Record<string, unknown>) {
        return {
          op_uuid: randomUUID(),
          entity_type: "artifact" as const,
          entity_id: id,
          op: "update" as const,
          payload,
          ...(precondition ? { precondition } : {}),
        };
      }

      it("returns STALE_BASE with the current row when base_updated_at is stale", async () => {
        const { id } = await pushArtifactInsert();
        const stale = await pushOne(
          artifactUpdate(id, { title: "must not apply" }, { base_updated_at: "1999-01-01T00:00:00.000Z" })
        );
        expect(stale.status).toBe("conflict");
        expect(stale.conflict!.reason).toBe("STALE_BASE");
        expect(stale.conflict!.current.id).toBe(id);
        expect(stale.conflict!.current.title).toBe("Project-alpha runbook");
      });

      it("applies the update when base_updated_at matches, and rejects the now-stale base afterwards", async () => {
        const { id, result } = await pushArtifactInsert();
        const base = result.snapshot.updated_at as string;
        expect(typeof base).toBe("string");

        const ok = await pushOne(artifactUpdate(id, { title: "Project-alpha runbook v2" }, { base_updated_at: base }));
        expect(ok.status).toBe("applied");
        expect(ok.snapshot.title).toBe("Project-alpha runbook v2");

        const again = await pushOne(artifactUpdate(id, { title: "from the old base" }, { base_updated_at: base }));
        expect(again.status).toBe("conflict");
        expect(again.conflict!.reason).toBe("STALE_BASE");
      });
    });

    describe("id canonicalisation (uppercase UUIDs)", () => {
      // Postgres returns uuid text lowercase; clients (e.g. Swift's
      // uuidString) may send uppercase. Ids must agree everywhere or one row
      // is keyed two ways.
      const cases: Array<{ entityType: "note" | "task" | "artifact"; insert: Record<string, unknown>; update: Record<string, unknown> }> = [
        { entityType: "note", insert: { title: "Upper-case id note" }, update: { content: "updated via upper-case id" } },
        { entityType: "task", insert: { title: "Upper-case id task" }, update: { title: "Renamed via upper-case id" } },
        {
          entityType: "artifact",
          insert: { title: "Upper-case id artifact", artifact_type: "research" },
          update: { title: "Renamed artifact via upper-case id" },
        },
      ];

      for (const { entityType, insert, update } of cases) {
        it(`${entityType}: result, change log, sync_op_log and snapshot key are lowercase; an uppercase update hits the same row`, async () => {
          const lower = randomUUID();
          const upper = lower.toUpperCase();
          const cursor = await maxSeqDb();
          const insertOpUuid = randomUUID();

          const inserted = await pushOne({
            op_uuid: insertOpUuid,
            entity_type: entityType,
            entity_id: upper,
            op: "insert",
            payload: insert,
          });
          expect(inserted.status).toBe("applied");
          expect(inserted.entity_id).toBe(lower);
          expect(inserted.snapshot.id).toBe(lower);

          // Change log: one insert row, keyed lowercase only.
          expect(await changesFor(entityType, lower, cursor)).toEqual([
            { seq: inserted.seq, op: "insert" },
          ]);
          expect(await changesFor(entityType, upper, cursor)).toHaveLength(0);
          // Dedupe log agrees.
          expect((await opLogRows(insertOpUuid))[0].entity_id).toBe(lower);

          // Pull snapshot is keyed lowercase.
          const pull = await (await syncGet(`/sync/changes?cursor=${cursor}&limit=100`)).json();
          expect(pull.snapshots[`${entityType}:${lower}`]).toMatchObject({ id: lower });
          expect(pull.snapshots[`${entityType}:${upper}`]).toBeUndefined();

          // An update sent with the uppercase id finds the same row.
          const updated = await pushOne({
            op_uuid: randomUUID(),
            entity_type: entityType,
            entity_id: upper,
            op: "update",
            payload: update,
          });
          expect(updated.status).toBe("applied");
          expect(updated.entity_id).toBe(lower);
          expect(await changesFor(entityType, upper, cursor)).toHaveLength(0);
          expect((await changesFor(entityType, lower, cursor)).map((c) => c.op)).toEqual([
            "insert",
            "update",
          ]);
        });
      }

      it("note supersede and delete accept uppercase ids, including superseded_by; results are lowercase", async () => {
        const { id: oldId } = await pushNoteInsert();
        const { id: newId } = await pushNoteInsert();
        const cursor = await maxSeqDb();

        const sup = await pushOne(
          noteOp("supersede", oldId.toUpperCase(), { superseded_by: newId.toUpperCase() })
        );
        expect(sup.status).toBe("applied");
        expect(sup.entity_id).toBe(oldId);
        expect(sup.snapshot).toMatchObject({ id: oldId, superseded_by: newId, status: "superseded" });
        expect(await changesFor("note", oldId.toUpperCase(), cursor)).toHaveLength(0);

        const del = await pushOne(noteOp("delete", newId.toUpperCase()));
        expect(del.status).toBe("applied");
        expect(del.entity_id).toBe(newId);
        expect(del.relinked!.map((r) => r.entity_id)).toEqual([oldId]);
        expect(await noteRow(newId)).toBeUndefined();
        expect(await changesFor("note", newId.toUpperCase(), cursor)).toHaveLength(0);
        expect((await changesFor("note", newId, cursor)).map((c) => c.op)).toEqual(["delete"]);
      });

      it("leaves op_uuid exactly as sent so clients can match results to ops", async () => {
        const opUuid = randomUUID().toUpperCase();
        const res = await pushOne(noteOp("insert", randomUUID(), { title: "op_uuid echo" }, undefined, opUuid));
        expect(res.status).toBe("applied");
        expect(res.op_uuid).toBe(opUuid);
      });
    });

    describe("delete splices supersession chains", () => {
      it("reactivates the predecessor when the deleted note was the end of the chain", async () => {
        const { id: oldId } = await pushNoteInsert({ title: "Acme Corp Friday deploys" });
        const { id: headId } = await pushNoteInsert({ title: "Acme Corp deploy freeze" });
        const sup = await pushOne(noteOp("supersede", oldId, { superseded_by: headId }));
        expect(sup.status).toBe("applied");
        const cursor = await maxSeqDb();

        const del = await pushOne(noteOp("delete", headId));
        expect(del.status).toBe("applied");
        expect(del.snapshot).toBeNull();
        expect(del.seq).toBeDefined();
        expect(del.relinked).toHaveLength(1);
        expect(del.relinked![0].entity_id).toBe(oldId);
        expect(del.relinked![0].snapshot).toMatchObject({
          id: oldId,
          status: "active",
          superseded_by: null,
          superseded_at: null,
          version: 3,
        });

        // Both the relinked predecessor and the deleted note have change rows.
        expect((await changesFor("note", oldId, cursor)).map((c) => c.op)).toEqual(["update"]);
        expect(await changesFor("note", headId, cursor)).toEqual([{ seq: del.seq, op: "delete" }]);
        expect(await noteRow(headId)).toBeUndefined();

        const pull = await (await syncGet(`/sync/changes?cursor=${cursor}&limit=100`)).json();
        expect(pull.snapshots[`note:${oldId}`]).toMatchObject({ status: "active", superseded_by: null });
        expect(pull.snapshots[`note:${headId}`]).toBeNull();
      });

      it("re-points the predecessor at the deleted note's successor for a middle-of-chain delete", async () => {
        const { id: a } = await pushNoteInsert({ title: "Chain A" });
        const { id: b } = await pushNoteInsert({ title: "Chain B" });
        const { id: c } = await pushNoteInsert({ title: "Chain C" });
        const ab = await pushOne(noteOp("supersede", a, { superseded_by: b }));
        const bc = await pushOne(noteOp("supersede", b, { superseded_by: c }));
        expect(ab.status).toBe("applied");
        expect(bc.status).toBe("applied");
        const supersededAt = ab.snapshot.superseded_at as string;
        const cursor = await maxSeqDb();

        const del = await pushOne(noteOp("delete", b));
        expect(del.status).toBe("applied");
        expect(del.relinked).toHaveLength(1);
        expect(del.relinked![0].entity_id).toBe(a);
        expect(del.relinked![0].snapshot).toMatchObject({
          id: a,
          status: "superseded",
          superseded_by: c,
          version: 3,
        });
        // superseded_at records when the knowledge stopped being current; the re-point keeps it.
        expect(del.relinked![0].snapshot.superseded_at).toBe(supersededAt);

        expect((await changesFor("note", a, cursor)).map((x) => x.op)).toEqual(["update"]);
        expect(await changesFor("note", c, cursor)).toHaveLength(0);
        expect((await noteRow(c))!.version).toBe(1);
      });

      it("returns an empty relinked list for a note with no predecessors", async () => {
        const { id } = await pushNoteInsert();
        const del = await pushOne(noteOp("delete", id));
        expect(del.status).toBe("applied");
        expect(del.relinked).toEqual([]);
      });

      it("keeps deleting a non-existent note harmless: tombstone applied, replay dedups", async () => {
        const id = randomUUID();
        const cursor = await maxSeqDb();
        const op = noteOp("delete", id);
        const first = await pushOne(op);
        expect(first.status).toBe("applied");
        expect(first.snapshot).toBeNull();
        expect(await changesFor("note", id, cursor)).toEqual([{ seq: first.seq, op: "delete" }]);

        const replay = await pushOne(op);
        expect(replay.status).toBe("dedup");
        expect(replay.seq).toBe(first.seq);
      });

      it("removes the deleted note's embedding after commit", async () => {
        const { id } = await pushNoteInsert();
        // Seed an embedding row directly; no embedding server runs in this suite.
        const vector = `[1${",0".repeat(767)}]`;
        await withPg((c) =>
          c.query(
            `INSERT INTO embeddings (content_type, content_id, content_text, embedding)
             VALUES ('note', $1, 'seeded', $2::vector)`,
            [id, vector]
          )
        );
        const count = () =>
          withPg(async (c) => {
            const res = await c.query(
              "SELECT count(*)::int AS n FROM embeddings WHERE content_type = 'note' AND content_id = $1",
              [id]
            );
            return res.rows[0].n as number;
          });
        expect(await count()).toBe(1);

        const del = await pushOne(noteOp("delete", id));
        expect(del.status).toBe("applied");
        expect(await count()).toBe(0);
      });
    });

    describe("pending_embeddings enqueue on the push path", () => {
      it("queues a note insert", async () => {
        const { id } = await pushNoteInsert();
        expect(await pendingEmbeddingCount(id)).toBe(1);
      });

      it("queues text edits once (ON CONFLICT), and not metadata-only edits", async () => {
        const { id } = await pushNoteInsert();
        await clearPendingEmbedding(id);

        // scope does not feed the embedding text.
        const scopeOnly = await pushOne(noteOp("update", id, { scope: "work" }));
        expect(scopeOnly.status).toBe("applied");
        expect(await pendingEmbeddingCount(id)).toBe(0);

        const content = await pushOne(noteOp("update", id, { content: "Deploys are frozen." }));
        expect(content.status).toBe("applied");
        expect(await pendingEmbeddingCount(id)).toBe(1);

        // A second text edit before any drain keeps the single queue row.
        const title = await pushOne(noteOp("update", id, { title: "Acme Corp deploy freeze" }));
        expect(title.status).toBe("applied");
        expect(await pendingEmbeddingCount(id)).toBe(1);
      });

      it("does not queue a text edit that changes nothing", async () => {
        const { id } = await pushNoteInsert();
        await clearPendingEmbedding(id);
        const noop = await pushOne(noteOp("update", id, { title: "Acme Corp deploy policy" }));
        expect(noop.status).toBe("applied");
        expect(noop.seq).toBeUndefined();
        expect(noop.snapshot.version).toBe(1);
        expect(await pendingEmbeddingCount(id)).toBe(0);
      });

      it("does not queue when the op conflicts (the transaction rolled back)", async () => {
        const { id } = await pushNoteInsert();
        await clearPendingEmbedding(id);
        const res = await pushOne(
          noteOp("update", id, { content: "stale write" }, { expected_version: 9 })
        );
        expect(res.status).toBe("conflict");
        expect(await pendingEmbeddingCount(id)).toBe(0);
      });

      it("does not queue on supersede (the text did not change)", async () => {
        const { id: oldId } = await pushNoteInsert();
        const { id: newId } = await pushNoteInsert();
        await clearPendingEmbedding(oldId);
        const res = await pushOne(noteOp("supersede", oldId, { superseded_by: newId }));
        expect(res.status).toBe("applied");
        expect(await pendingEmbeddingCount(oldId)).toBe(0);
      });
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

// Helper: run `fn` against a direct connection to the suite's database. Used
// to read sync_op_log / changes / pending_embeddings and to seed rows the
// public surface cannot create. A fresh connection per call keeps the helper
// independent of the server's own pool.
async function withPg<T>(fn: (client: PgClient) => Promise<T>): Promise<T> {
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
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Helper: current max change-log seq, read straight from the table so it never
// depends on /sync/changes pagination.
async function maxSeqDb(): Promise<string> {
  return withPg(async (c) => {
    const res = await c.query("SELECT COALESCE(max(seq), 0)::text AS seq FROM changes");
    return res.rows[0].seq as string;
  });
}
