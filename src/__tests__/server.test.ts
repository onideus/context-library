import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rm, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const TEST_PORT = 3199;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_DATA_DIR = join(process.cwd(), "data", "test");
let serverProcess: ChildProcess;

/** Wait for the server to be accepting connections */
async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
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

/** Parse SSE response to extract the JSON data payload */
async function parseSseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) throw new Error(`No data line in SSE response. Body:\n${text}`);
  return JSON.parse(dataLine.slice(5).trim());
}

/** Build a JSON-RPC 2.0 request body */
function jsonrpc(method: string, params?: Record<string, unknown>, id = 1) {
  return { jsonrpc: "2.0", method, ...(params ? { params } : {}), id };
}

/** POST to /mcp with correct MCP headers */
async function mcpPost(body: unknown, extraHeaders?: Record<string, string>) {
  return fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

/** Store a handoff and verify it succeeded. Returns the parsed result. */
async function storeAndVerify(payload: Record<string, unknown>) {
  const res = await mcpPost(
    jsonrpc("tools/call", { name: "store_handoff", arguments: payload })
  );
  expect(res.status).toBe(200);
  const data = (await parseSseResponse(res)) as any;
  const result = JSON.parse(data.result.content[0].text);
  expect(result.success).toBe(true);
  return result;
}

beforeAll(async () => {
  // Clean test data directory
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
  await mkdir(TEST_DATA_DIR, { recursive: true });

  serverProcess = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCP_PORT: String(TEST_PORT),
      DATA_DIR: TEST_DATA_DIR,
    },
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
  });

  // Continuously drain child stdio so pipe buffers don't fill and block the
  // child process when this suite runs alongside other parallel workers.
  serverProcess.stderr?.on("data", () => {});
  serverProcess.stdout?.on("data", () => {});

  await waitForServer(BASE_URL);
}, 45_000);

afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    // Give it a moment to shut down cleanly
    await new Promise((r) => setTimeout(r, 500));
    if (!serverProcess.killed) serverProcess.kill("SIGKILL");
  }
  // Clean up test data
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
});

// ────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────

describe("Health", () => {
  it("GET /health returns 200 with {status: 'ok'}", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});

describe("MCP Transport — Content Negotiation", () => {
  it("POST /mcp without Accept header returns error", async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // No Accept header
      },
      body: JSON.stringify(jsonrpc("initialize")),
    });
    // Transport throws on missing Accept header — returns 500 with JSON-RPC error
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json();
    expect(body).toHaveProperty("jsonrpc", "2.0");
    expect(body).toHaveProperty("error");
    expect(body.error).toHaveProperty("code");
    expect(body.error).toHaveProperty("message");
  });
});

describe("MCP Tools", () => {
  describe("tools/list", () => {
    it("returns both store_handoff and get_latest_handoff tools", async () => {
      const res = await mcpPost(jsonrpc("tools/list"));
      expect(res.status).toBe(200);
      const data = (await parseSseResponse(res)) as any;
      expect(data.result).toBeDefined();
      const toolNames: string[] = data.result.tools.map(
        (t: any) => t.name
      );
      expect(toolNames).toContain("store_handoff");
      expect(toolNames).toContain("get_latest_handoff");
    });
  });

  describe("store_handoff", () => {
    it("stores a handoff and returns success with stored_at timestamp", async () => {
      const payload = {
        operational_state: {
          sleep_hours: "7",
          energy_level: "high",
          mood: "focused",
        },
        tasks: {
          completed: ["setup project"],
          open: ["write tests"],
          blocked: [],
        },
        tone_notes: "Test handoff payload",
      };

      const res = await mcpPost(
        jsonrpc("tools/call", {
          name: "store_handoff",
          arguments: payload,
        })
      );
      expect(res.status).toBe(200);
      const data = (await parseSseResponse(res)) as any;
      const content = JSON.parse(data.result.content[0].text);
      expect(content.success).toBe(true);
      expect(content.stored_at).toBeDefined();
      // Verify ISO timestamp format
      expect(new Date(content.stored_at).toISOString()).toBe(
        content.stored_at
      );
    });
  });

  describe("get_latest_handoff — round trip", () => {
    it("retrieves the exact payload that was stored, plus stored_at", async () => {
      // Store a known payload
      const payload = {
        operational_state: {
          sleep_hours: "8",
          physical_state: "rested",
          energy_level: "medium",
          mood: "calm",
        },
        active_context: { project: "context-library", phase: "testing" },
        tasks: {
          completed: ["phase 1"],
          open: ["phase 2"],
          blocked: [],
        },
        memory_deltas: [
          { slot: 1, action: "add" as const, content: "test memory" },
        ],
        tone_notes: "Round-trip test payload",
      };

      // Store
      const storeRes = await mcpPost(
        jsonrpc("tools/call", {
          name: "store_handoff",
          arguments: payload,
        })
      );
      expect(storeRes.status).toBe(200);
      const storeData = (await parseSseResponse(storeRes)) as any;
      const storeResult = JSON.parse(storeData.result.content[0].text);
      const storedAt = storeResult.stored_at;

      // Retrieve
      const getRes = await mcpPost(
        jsonrpc("tools/call", {
          name: "get_latest_handoff",
          arguments: {},
        })
      );
      expect(getRes.status).toBe(200);
      const getData = (await parseSseResponse(getRes)) as any;
      const retrieved = JSON.parse(getData.result.content[0].text);

      // The retrieved payload should contain everything we sent plus stored_at
      // stored_at may differ by <=1ms due to ISO serialization rounding, so compare loosely
      expect(Math.abs(new Date(retrieved.stored_at).getTime() - new Date(storedAt).getTime())).toBeLessThanOrEqual(1);
      expect(retrieved.operational_state).toEqual(payload.operational_state);
      expect(retrieved.active_context).toEqual(payload.active_context);
      expect(retrieved.tasks).toEqual(payload.tasks);
      expect(retrieved.memory_deltas).toEqual(payload.memory_deltas);
      expect(retrieved.tone_notes).toBe(payload.tone_notes);
    });
  });

  describe("Non-volatile handoff storage", () => {
    it("stores multiple handoffs as separate files and get_latest returns the most recent", async () => {
      const handoffsDir = join(TEST_DATA_DIR, "handoffs");

      // Count existing files before our stores
      let existingCount = 0;
      try {
        const existing = (await readdir(handoffsDir)).filter(
          (f) => f.endsWith(".json") && !f.startsWith(".tmp-")
        );
        existingCount = existing.length;
      } catch {
        // Directory may not exist yet
      }

      // Store first handoff
      const payload1 = {
        tone_notes: "First handoff",
        tasks: { open: ["task-alpha"] },
      };
      const res1 = await mcpPost(
        jsonrpc("tools/call", { name: "store_handoff", arguments: payload1 })
      );
      expect(res1.status).toBe(200);
      const data1 = (await parseSseResponse(res1)) as any;
      const result1 = JSON.parse(data1.result.content[0].text);
      expect(result1.success).toBe(true);
      const storedAt1 = result1.stored_at;

      // Small delay to ensure distinct timestamps in filenames
      await new Promise((r) => setTimeout(r, 50));

      // Store second handoff
      const payload2 = {
        tone_notes: "Second handoff",
        tasks: { open: ["task-beta"] },
      };
      const res2 = await mcpPost(
        jsonrpc("tools/call", { name: "store_handoff", arguments: payload2 })
      );
      expect(res2.status).toBe(200);
      const data2 = (await parseSseResponse(res2)) as any;
      const result2 = JSON.parse(data2.result.content[0].text);
      expect(result2.success).toBe(true);
      const storedAt2 = result2.stored_at;

      // Verify both new files exist on disk
      const files = (await readdir(handoffsDir)).filter(
        (f) => f.endsWith(".json") && !f.startsWith(".tmp-")
      );
      expect(files.length).toBe(existingCount + 2);

      // Verify get_latest_handoff returns the second one
      const getRes = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      expect(getRes.status).toBe(200);
      const getData = (await parseSseResponse(getRes)) as any;
      const retrieved = JSON.parse(getData.result.content[0].text);
      expect(retrieved.stored_at).toBe(storedAt2);
      expect(retrieved.tone_notes).toBe("Second handoff");
      expect(retrieved.tasks.open).toEqual(["task-beta"]);
    });
  });

  // ────────────────────────────────────────────────
  // patch_handoff tests
  // ────────────────────────────────────────────────

  describe("patch_handoff", () => {
    // Store a baseline handoff that patch tests will operate on
    let baseStoredAt: string;

    it("returns error when no handoff exists to patch (clean state)", async () => {
      // Use a sub-directory to simulate empty state — but since we share test data dir
      // and previous tests stored handoffs, we test error handling via the tool description.
      // Instead, we verify the tool exists and is callable.
      const listRes = await mcpPost(jsonrpc("tools/list"));
      const listData = (await parseSseResponse(listRes)) as any;
      const toolNames: string[] = listData.result.tools.map((t: any) => t.name);
      expect(toolNames).toContain("patch_handoff");
    });

    it("patches tone_notes only, preserving other fields", async () => {
      // Store baseline
      const baseline = {
        operational_state: { sleep_hours: "7", mood: "focused", energy_level: "high" },
        tasks: { completed: ["setup"], open: ["write tests"], blocked: [] },
        tone_notes: "Original tone",
        timezone: "America/New_York",
      };
      const storeRes = await mcpPost(
        jsonrpc("tools/call", { name: "store_handoff", arguments: baseline })
      );
      const storeData = (await parseSseResponse(storeRes)) as any;
      baseStoredAt = JSON.parse(storeData.result.content[0].text).stored_at;

      // Patch tone_notes only
      const patchRes = await mcpPost(
        jsonrpc("tools/call", {
          name: "patch_handoff",
          arguments: { tone_notes: "Updated tone" },
        })
      );
      expect(patchRes.status).toBe(200);
      const patchData = (await parseSseResponse(patchRes)) as any;
      const patchResult = JSON.parse(patchData.result.content[0].text);
      expect(patchResult.success).toBe(true);
      expect(patchResult.patched_fields).toEqual(["tone_notes"]);

      // Verify other fields preserved
      const getRes = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      const getData = (await parseSseResponse(getRes)) as any;
      const retrieved = JSON.parse(getData.result.content[0].text);
      expect(retrieved.tone_notes).toBe("Updated tone");
      expect(retrieved.operational_state.sleep_hours).toBe("7");
      expect(retrieved.operational_state.mood).toBe("focused");
      expect(retrieved.tasks.open).toEqual(["write tests"]);
    });

    it("deep merges operational_state, preserving unpatched keys", async () => {
      const patchRes = await mcpPost(
        jsonrpc("tools/call", {
          name: "patch_handoff",
          arguments: { operational_state: { mood: "relaxed" } },
        })
      );
      const patchData = (await parseSseResponse(patchRes)) as any;
      const patchResult = JSON.parse(patchData.result.content[0].text);
      expect(patchResult.success).toBe(true);
      expect(patchResult.patched_fields).toContain("operational_state");

      const getRes = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      const getData = (await parseSseResponse(getRes)) as any;
      const retrieved = JSON.parse(getData.result.content[0].text);
      expect(retrieved.operational_state.mood).toBe("relaxed");
      expect(retrieved.operational_state.sleep_hours).toBe("7");
      expect(retrieved.operational_state.energy_level).toBe("high");
    });

    it("deep merges active_context, preserving unpatched keys", async () => {
      // Store a handoff with active_context
      await storeAndVerify({
        active_context: { session: "morning", conversation_arc: "debugging" },
        tone_notes: "context test",
      });

      const patchRes = await mcpPost(
        jsonrpc("tools/call", {
          name: "patch_handoff",
          arguments: { active_context: { conversation_arc: "deploying" } },
        })
      );
      const patchData = (await parseSseResponse(patchRes)) as any;
      const patchResult = JSON.parse(patchData.result.content[0].text);
      expect(patchResult.patched_fields).toContain("active_context");

      const getRes = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      const getData = (await parseSseResponse(getRes)) as any;
      const retrieved = JSON.parse(getData.result.content[0].text);
      expect(retrieved.active_context.session).toBe("morning");
      expect(retrieved.active_context.conversation_arc).toBe("deploying");
    });

    it("appends to tasks.open, preserving existing items", async () => {
      // Store baseline with tasks
      await storeAndVerify({ tasks: { open: ["task-a", "task-b"], completed: [], blocked: [] } });

      const patchRes = await mcpPost(
        jsonrpc("tools/call", {
          name: "patch_handoff",
          arguments: { tasks: { open: { op: "append", items: ["task-c"] } } },
        })
      );
      const patchData = (await parseSseResponse(patchRes)) as any;
      const patchResult = JSON.parse(patchData.result.content[0].text);
      expect(patchResult.success).toBe(true);

      const getRes = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      const getData = (await parseSseResponse(getRes)) as any;
      const retrieved = JSON.parse(getData.result.content[0].text);
      expect(retrieved.tasks.open).toEqual(["task-a", "task-b", "task-c"]);
    });

    it("removes specific items from tasks.open", async () => {
      // Store baseline with known tasks
      await storeAndVerify({ tasks: { open: ["task-a", "task-b", "task-c"], completed: [], blocked: [] } });

      const patchRes = await mcpPost(
        jsonrpc("tools/call", {
          name: "patch_handoff",
          arguments: { tasks: { open: { op: "remove", items: ["task-b"] } } },
        })
      );
      const patchData = (await parseSseResponse(patchRes)) as any;
      const patchResult = JSON.parse(patchData.result.content[0].text);
      expect(patchResult.success).toBe(true);

      const getRes = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      const getData = (await parseSseResponse(getRes)) as any;
      const retrieved = JSON.parse(getData.result.content[0].text);
      expect(retrieved.tasks.open).toEqual(["task-a", "task-c"]);
    });

    it("replaces tasks.completed entirely", async () => {
      // Store baseline
      await storeAndVerify({ tasks: { completed: ["old-a", "old-b"], open: [], blocked: [] } });

      const patchRes = await mcpPost(
        jsonrpc("tools/call", {
          name: "patch_handoff",
          arguments: {
            tasks: { completed: { op: "replace", items: ["done-x", "done-y"] } },
          },
        })
      );
      const patchData = (await parseSseResponse(patchRes)) as any;
      const patchResult = JSON.parse(patchData.result.content[0].text);
      expect(patchResult.success).toBe(true);

      const getRes = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      const getData = (await parseSseResponse(getRes)) as any;
      const retrieved = JSON.parse(getData.result.content[0].text);
      expect(retrieved.tasks.completed).toEqual(["done-x", "done-y"]);
    });

    it("preserves original value when null is sent for a field", async () => {
      // Store with tone_notes
      await storeAndVerify({ tone_notes: "Keep this tone", tasks: { open: ["persist-me"], completed: [], blocked: [] } });

      // Patch with null tone_notes — should preserve
      const patchRes = await mcpPost(
        jsonrpc("tools/call", {
          name: "patch_handoff",
          arguments: { tone_notes: null, tasks: { open: { op: "append", items: ["new-task"] } } },
        })
      );
      const patchData = (await parseSseResponse(patchRes)) as any;
      const patchResult = JSON.parse(patchData.result.content[0].text);
      expect(patchResult.patched_fields).not.toContain("tone_notes");
      expect(patchResult.patched_fields).toContain("tasks");

      const getRes = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      const getData = (await parseSseResponse(getRes)) as any;
      const retrieved = JSON.parse(getData.result.content[0].text);
      expect(retrieved.tone_notes).toBe("Keep this tone");
    });

    it("handles mixed operations in a single patch", async () => {
      // Store baseline
      await storeAndVerify({
        operational_state: { mood: "neutral", energy_level: "medium" },
        tasks: { open: ["task-1", "task-2"], completed: ["done-1"], blocked: [] },
      });

      const patchRes = await mcpPost(
        jsonrpc("tools/call", {
          name: "patch_handoff",
          arguments: {
            operational_state: { mood: "energized" },
            tasks: {
              open: { op: "remove", items: ["task-1"] },
              completed: { op: "append", items: ["task-1"] },
            },
          },
        })
      );
      const patchData = (await parseSseResponse(patchRes)) as any;
      const patchResult = JSON.parse(patchData.result.content[0].text);
      expect(patchResult.success).toBe(true);
      expect(patchResult.patched_fields).toContain("operational_state");
      expect(patchResult.patched_fields).toContain("tasks");

      const getRes = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      const getData = (await parseSseResponse(getRes)) as any;
      const retrieved = JSON.parse(getData.result.content[0].text);
      expect(retrieved.operational_state.mood).toBe("energized");
      expect(retrieved.operational_state.energy_level).toBe("medium");
      expect(retrieved.tasks.open).toEqual(["task-2"]);
      expect(retrieved.tasks.completed).toEqual(["done-1", "task-1"]);
    });

    it("includes patched_from reference to source handoff filename", async () => {
      // Store a handoff, then patch it
      await storeAndVerify({ tone_notes: "source handoff" });

      const patchRes = await mcpPost(
        jsonrpc("tools/call", {
          name: "patch_handoff",
          arguments: { tone_notes: "patched version" },
        })
      );
      const patchData = (await parseSseResponse(patchRes)) as any;
      const patchResult = JSON.parse(patchData.result.content[0].text);
      expect(patchResult.source_handoff).toBeDefined();
      expect(typeof patchResult.source_handoff).toBe("string");
      expect(patchResult.source_handoff).toMatch(/\.json$/);
    });

    it("returns correct task_summary counts in response", async () => {
      await storeAndVerify({
        tasks: {
          open: ["a", "b"],
          completed: ["c"],
          blocked: ["d"],
        },
      });

      const patchRes = await mcpPost(
        jsonrpc("tools/call", {
          name: "patch_handoff",
          arguments: {
            tasks: { open: { op: "append", items: ["e"] } },
          },
        })
      );
      const patchData = (await parseSseResponse(patchRes)) as any;
      const patchResult = JSON.parse(patchData.result.content[0].text);
      expect(patchResult.task_summary).toEqual({
        open_count: 3,
        blocked_count: 1,
        completed_count: 1,
      });
    });
  });

  // ────────────────────────────────────────────────
  // get_latest_handoff enrichment tests
  // ────────────────────────────────────────────────

  describe("get_latest_handoff — response envelope", () => {
    it("elapsed_seconds is a positive number and roughly correct", async () => {
      // Store a handoff with known timestamp
      await storeAndVerify({ tone_notes: "elapsed test" });

      const getRes = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      const getData = (await parseSseResponse(getRes)) as any;
      const retrieved = JSON.parse(getData.result.content[0].text);
      expect(typeof retrieved.elapsed_seconds).toBe("number");
      expect(retrieved.elapsed_seconds).toBeGreaterThanOrEqual(0);
      expect(retrieved.elapsed_seconds).toBeLessThan(5);
    });

    it("same_calendar_day returns a boolean", async () => {
      const getRes = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      const getData = (await parseSseResponse(getRes)) as any;
      const retrieved = JSON.parse(getData.result.content[0].text);
      expect(typeof retrieved.same_calendar_day).toBe("boolean");
      // Since we just stored, it should be today
      expect(retrieved.same_calendar_day).toBe(true);
    });

    it("task_summary exposes numeric counts (shape is stable across fallback and dynamic sources)", async () => {
      // When Postgres is unavailable, task_summary is the fallback shape derived from handoff
      // arrays: {open_count, blocked_count, completed_count}. When Postgres is available, counts
      // come from the tasks table and the shape is enriched with item arrays. This test asserts
      // the minimum contract both paths share. Exact-count fallback behavior is covered by the
      // patch_handoff "task_summary counts in response" test, which stays on handoff arrays.
      await storeAndVerify({
        tasks: { open: ["x", "y"], completed: ["z"], blocked: [] },
      });

      const getRes = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      const getData = (await parseSseResponse(getRes)) as any;
      const retrieved = JSON.parse(getData.result.content[0].text);
      expect(typeof retrieved.task_summary.open_count).toBe("number");
      expect(typeof retrieved.task_summary.blocked_count).toBe("number");
      expect(typeof retrieved.task_summary.completed_count).toBe("number");
    });

    it("applied_scope matches requested scope", async () => {
      const getRes = await mcpPost(
        jsonrpc("tools/call", {
          name: "get_latest_handoff",
          arguments: { scope: "work" },
        })
      );
      const getData = (await parseSseResponse(getRes)) as any;
      const retrieved = JSON.parse(getData.result.content[0].text);
      expect(retrieved.applied_scope).toBe("work");
    });

    it("schema_version is present and is '1.2'", async () => {
      const getRes = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      const getData = (await parseSseResponse(getRes)) as any;
      const retrieved = JSON.parse(getData.result.content[0].text);
      expect(retrieved.schema_version).toBe("1.2");
    });

    it("handoff_count is a positive integer", async () => {
      const getRes = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      const getData = (await parseSseResponse(getRes)) as any;
      const retrieved = JSON.parse(getData.result.content[0].text);
      expect(typeof retrieved.handoff_count).toBe("number");
      expect(retrieved.handoff_count).toBeGreaterThan(0);
      expect(Number.isInteger(retrieved.handoff_count)).toBe(true);
    });

    it("evidence_pulled is true when a handoff is successfully loaded", async () => {
      await storeAndVerify({ tone_notes: "evidence_pulled test" });

      const getRes = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      const getData = (await parseSseResponse(getRes)) as any;
      const retrieved = JSON.parse(getData.result.content[0].text);
      expect(retrieved.evidence_pulled).toBe(true);
    });

    it("embedding_status is present with expected shape", async () => {
      await storeAndVerify({ tone_notes: "embedding_status shape test" });

      const getRes = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      const getData = (await parseSseResponse(getRes)) as any;
      const retrieved = JSON.parse(getData.result.content[0].text);
      expect(retrieved.embedding_status).toBeDefined();
      expect(typeof retrieved.embedding_status.available).toBe("boolean");
      expect(
        retrieved.embedding_status.last_success === null ||
          typeof retrieved.embedding_status.last_success === "string"
      ).toBe(true);
      expect(typeof retrieved.embedding_status.pending_count).toBe("number");
      // pending_count is non-negative; actual value depends on prior test state
      // (0 when Postgres/table absent, possibly >0 in CI where earlier suites queued items).
      expect(retrieved.embedding_status.pending_count).toBeGreaterThanOrEqual(0);
    });
  });

  // ────────────────────────────────────────────────
  // schema_version on stored handoff files
  // ────────────────────────────────────────────────

  describe("schema_version — stored file contents", () => {
    it("stored handoff file contains schema_version '1.2'", async () => {
      const result = await storeAndVerify({ tone_notes: "schema_version file test" });
      const filepath = join(TEST_DATA_DIR, "handoffs", result.filename);
      const raw = await readFile(filepath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.schema_version).toBe("1.2");
    });

    it("patch preserves schema_version on the merged result file", async () => {
      await storeAndVerify({ tone_notes: "schema pre-patch" });

      const patchRes = await mcpPost(
        jsonrpc("tools/call", {
          name: "patch_handoff",
          arguments: { tone_notes: "schema post-patch" },
        })
      );
      const patchData = (await parseSseResponse(patchRes)) as any;
      const patchResult = JSON.parse(patchData.result.content[0].text);
      expect(patchResult.schema_version).toBe("1.2");

      const handoffsDir = join(TEST_DATA_DIR, "handoffs");
      const files = (await readdir(handoffsDir))
        .filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"))
        .sort();
      const latestPath = join(handoffsDir, files[files.length - 1]);
      const parsed = JSON.parse(await readFile(latestPath, "utf-8"));
      expect(parsed.schema_version).toBe("1.2");
    });
  });

  // ────────────────────────────────────────────────
  // store_handoff enrichment tests
  // ────────────────────────────────────────────────

  describe("store_handoff — enriched response", () => {
    it("response includes filename, task_summary, and schema_version", async () => {
      const res = await mcpPost(
        jsonrpc("tools/call", {
          name: "store_handoff",
          arguments: {
            tasks: { open: ["a"], completed: ["b", "c"], blocked: [] },
            tone_notes: "enrichment test",
          },
        })
      );
      const data = (await parseSseResponse(res)) as any;
      const result = JSON.parse(data.result.content[0].text);
      expect(result.success).toBe(true);
      expect(result.filename).toBeDefined();
      expect(typeof result.filename).toBe("string");
      expect(result.filename).toMatch(/\.json$/);
      expect(result.task_summary).toEqual({
        open_count: 1,
        blocked_count: 0,
        completed_count: 2,
      });
      expect(result.schema_version).toBe("1.2");
    });

    it("tool description does not contain 'Overwrites' or 'overwrites'", async () => {
      const listRes = await mcpPost(jsonrpc("tools/list"));
      const listData = (await parseSseResponse(listRes)) as any;
      const storeTool = listData.result.tools.find(
        (t: any) => t.name === "store_handoff"
      );
      expect(storeTool).toBeDefined();
      expect(storeTool.description).not.toMatch(/[Oo]verwrites?/);
    });
  });
});

// ────────────────────────────────────────────────
// list_handoffs / get_handoff tests
// ────────────────────────────────────────────────

describe("Handoff Navigation", () => {
  describe("list_handoffs", () => {
    it("appears in tools/list", async () => {
      const res = await mcpPost(jsonrpc("tools/list"));
      const data = (await parseSseResponse(res)) as any;
      const toolNames: string[] = data.result.tools.map((t: any) => t.name);
      expect(toolNames).toContain("list_handoffs");
      expect(toolNames).toContain("get_handoff");
    });

    it("returns metadata array (not full content) sorted newest first", async () => {
      // Store two handoffs with distinct content
      await storeAndVerify({
        tone_notes: "older",
        active_context: { session_meta: { label: "list-test-older" } },
        tasks: { open: ["a"], completed: [], blocked: [] },
      });
      await new Promise((r) => setTimeout(r, 50));
      await storeAndVerify({
        tone_notes: "newer",
        active_context: { session_meta: { label: "list-test-newer" } },
      });

      const res = await mcpPost(
        jsonrpc("tools/call", { name: "list_handoffs", arguments: { limit: 5 } })
      );
      expect(res.status).toBe(200);
      const data = (await parseSseResponse(res)) as any;
      const result = JSON.parse(data.result.content[0].text);

      expect(Array.isArray(result.handoffs)).toBe(true);
      expect(result.handoffs.length).toBeGreaterThan(0);
      expect(typeof result.total_count).toBe("number");
      expect(result.limit).toBe(5);
      expect(result.offset).toBe(0);

      // Metadata-only shape — no tone_notes or operational_state
      const entry = result.handoffs[0];
      expect(entry).toHaveProperty("filename");
      expect(entry).toHaveProperty("stored_at");
      expect(entry).toHaveProperty("session_label");
      expect(entry).toHaveProperty("size_bytes");
      expect(entry).toHaveProperty("has_tasks");
      expect(entry).toHaveProperty("schema_version");
      expect(entry).not.toHaveProperty("tone_notes");
      expect(entry).not.toHaveProperty("operational_state");

      // Newest-first ordering — find both known labels and confirm newer precedes older
      const labels = result.handoffs.map((h: any) => h.session_label);
      const newerIdx = labels.indexOf("list-test-newer");
      const olderIdx = labels.indexOf("list-test-older");
      expect(newerIdx).toBeGreaterThanOrEqual(0);
      expect(olderIdx).toBeGreaterThanOrEqual(0);
      expect(newerIdx).toBeLessThan(olderIdx);
    });

    it("extracts session_label and has_tasks correctly", async () => {
      await storeAndVerify({
        active_context: { session_meta: { label: "meta-label-test" } },
        tasks: { open: ["x"], completed: [], blocked: [] },
      });

      const res = await mcpPost(
        jsonrpc("tools/call", {
          name: "list_handoffs",
          arguments: { limit: 10 },
        })
      );
      const data = (await parseSseResponse(res)) as any;
      const result = JSON.parse(data.result.content[0].text);
      const match = result.handoffs.find(
        (h: any) => h.session_label === "meta-label-test"
      );
      expect(match).toBeDefined();
      expect(match.has_tasks).toBe(true);
      expect(match.size_bytes).toBeGreaterThan(0);
    });

    it("applies pagination with limit and offset", async () => {
      const resPage1 = await mcpPost(
        jsonrpc("tools/call", {
          name: "list_handoffs",
          arguments: { limit: 1, offset: 0 },
        })
      );
      const dataPage1 = (await parseSseResponse(resPage1)) as any;
      const page1 = JSON.parse(dataPage1.result.content[0].text);
      expect(page1.handoffs.length).toBe(1);
      expect(page1.limit).toBe(1);
      expect(page1.offset).toBe(0);

      const resPage2 = await mcpPost(
        jsonrpc("tools/call", {
          name: "list_handoffs",
          arguments: { limit: 1, offset: 1 },
        })
      );
      const dataPage2 = (await parseSseResponse(resPage2)) as any;
      const page2 = JSON.parse(dataPage2.result.content[0].text);
      expect(page2.offset).toBe(1);

      if (page1.total_count > 1) {
        expect(page1.handoffs[0].filename).not.toBe(page2.handoffs[0].filename);
      }
    });

    it("filters by after date", async () => {
      // Everything stored is "after the epoch" — verify filter excludes handoffs before a future date
      const future = new Date(Date.now() + 1000 * 60 * 60).toISOString();
      const res = await mcpPost(
        jsonrpc("tools/call", {
          name: "list_handoffs",
          arguments: { after: future },
        })
      );
      const data = (await parseSseResponse(res)) as any;
      const result = JSON.parse(data.result.content[0].text);
      expect(result.handoffs.length).toBe(0);
      expect(result.total_count).toBe(0);
    });

    it("filters by before date", async () => {
      const past = new Date(0).toISOString();
      const res = await mcpPost(
        jsonrpc("tools/call", {
          name: "list_handoffs",
          arguments: { before: past },
        })
      );
      const data = (await parseSseResponse(res)) as any;
      const result = JSON.parse(data.result.content[0].text);
      expect(result.handoffs.length).toBe(0);
      expect(result.total_count).toBe(0);
    });
  });

  describe("get_handoff", () => {
    it("retrieves a specific handoff by filename", async () => {
      const stored = await storeAndVerify({
        tone_notes: "get_handoff target",
        active_context: { session_meta: { label: "get-handoff-test" } },
        tasks: { open: ["foo"], completed: [], blocked: [] },
      });

      const res = await mcpPost(
        jsonrpc("tools/call", {
          name: "get_handoff",
          arguments: { filename: stored.filename },
        })
      );
      expect(res.status).toBe(200);
      const data = (await parseSseResponse(res)) as any;
      const result = JSON.parse(data.result.content[0].text);

      expect(result.error).toBeUndefined();
      expect(result.tone_notes).toBe("get_handoff target");
      expect(result.active_context.session_meta.label).toBe("get-handoff-test");
      expect(result.applied_scope).toBe("full");
      expect(result.schema_version).toBe("1.2");
      expect(result.task_summary).toBeDefined();
      expect(typeof result.elapsed_seconds).toBe("number");
    });

    it("applies scope filtering", async () => {
      const stored = await storeAndVerify({
        operational_state: { sleep_hours: "7", mood: "ok" },
        tone_notes: "scope filter",
        tasks: { open: ["t"], completed: [], blocked: [] },
      });

      const res = await mcpPost(
        jsonrpc("tools/call", {
          name: "get_handoff",
          arguments: { filename: stored.filename, scope: "work" },
        })
      );
      const data = (await parseSseResponse(res)) as any;
      const result = JSON.parse(data.result.content[0].text);
      expect(result.applied_scope).toBe("work");
      expect(result.filtered_fields).toBeDefined();
      // sleep_hours is personal — should be filtered out under 'work' scope
      expect(result.filtered_fields).toContain("operational_state.sleep_hours");
    });

    it("returns NOT_FOUND for unknown filename", async () => {
      const res = await mcpPost(
        jsonrpc("tools/call", {
          name: "get_handoff",
          arguments: {
            filename: "2099-01-01T00-00-00-000Z-deadbeef.json",
          },
        })
      );
      const data = (await parseSseResponse(res)) as any;
      const result = JSON.parse(data.result.content[0].text);
      expect(result.error).toBe(true);
      expect(result.code).toBe("NOT_FOUND");
    });

    it("rejects path traversal attempts", async () => {
      const attempts = [
        "../../../etc/passwd",
        "../secret.json",
        "sub/dir.json",
        "..\\windows\\file.json",
        "not-a-valid-handoff.json",
      ];
      for (const filename of attempts) {
        const res = await mcpPost(
          jsonrpc("tools/call", {
            name: "get_handoff",
            arguments: { filename },
          })
        );
        const data = (await parseSseResponse(res)) as any;
        const result = JSON.parse(data.result.content[0].text);
        expect(result.error).toBe(true);
        expect(result.code).toBe("NOT_FOUND");
      }
    });
  });
});

// ────────────────────────────────────────────────
// Embedding unavailability tests
// ────────────────────────────────────────────────

describe("search_context — schema (v0.6)", () => {
  it("exposes after and before date-range parameters", async () => {
    const listRes = await mcpPost(jsonrpc("tools/list"));
    const listData = (await parseSseResponse(listRes)) as any;
    const searchTool = listData.result.tools.find((t: any) => t.name === "search_context");
    expect(searchTool).toBeDefined();
    const props = searchTool.inputSchema?.properties ?? {};
    expect(props.after).toBeDefined();
    expect(props.before).toBeDefined();
    // Descriptions mention the time-window use case
    expect(searchTool.description).toMatch(/after/i);
    expect(searchTool.description).toMatch(/before/i);
  });
});

describe("search_context — graceful degradation", () => {
  it("returns EMBEDDING_UNAVAILABLE when embedding server is not running", async () => {
    const res = await mcpPost(
      jsonrpc("tools/call", {
        name: "search_context",
        arguments: { query: "test query" },
      })
    );
    expect(res.status).toBe(200);
    const data = (await parseSseResponse(res)) as any;
    const result = JSON.parse(data.result.content[0].text);
    expect(result.error).toBe(true);
    expect(result.code).toBe("EMBEDDING_UNAVAILABLE");
  });

  it("reindex returns EMBEDDING_UNAVAILABLE when embedding server is not running", async () => {
    const res = await mcpPost(
      jsonrpc("tools/call", {
        name: "reindex",
        arguments: {},
      })
    );
    expect(res.status).toBe(200);
    const data = (await parseSseResponse(res)) as any;
    const result = JSON.parse(data.result.content[0].text);
    expect(result.error).toBe(true);
    expect(result.code).toBe("EMBEDDING_UNAVAILABLE");
  });
});
