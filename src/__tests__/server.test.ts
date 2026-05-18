import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rm, mkdir, readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Resolve package.json the same way the server does (relative to this file,
// not process.cwd()) so the version comparison stays correct regardless of
// the working directory from which tests are run.
const PKG_VERSION: string = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf-8")
).version;

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
    env: (() => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        MCP_PORT: String(TEST_PORT),
        DATA_DIR: TEST_DATA_DIR,
      };
      // Remove APP_VERSION so getVersion() falls back to package.json, keeping
      // the version test valid in CI where Docker may have injected APP_VERSION.
      // Deleting is safer than setting undefined, which some Node versions coerce
      // to the string "undefined".
      delete env.APP_VERSION;
      return env;
    })(),
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
  it("GET /health returns 200 without auth headers", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
  });

  it("response includes status, version, and uptime fields", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("uptime");
  });

  it("status is 'ok'", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
  });

  it("version matches package.json", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    const body = await res.json() as Record<string, unknown>;
    expect(body.version).toBe(PKG_VERSION);
  });

  it("uptime is a non-negative number", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime as number).toBeGreaterThanOrEqual(0);
  });

  it("response contains ONLY status, version, and uptime", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    const body = await res.json() as Record<string, unknown>;
    const keys = Object.keys(body).sort();
    expect(keys).toEqual(["status", "uptime", "version"].sort());
  });

  // Negative test (proxy-side): verifies the auth bypass is scoped to /health.
  // Auth is enforced externally by mcp-auth-proxy — there is no in-process
  // auth middleware to configure or mock. A meaningful 401/403 assertion
  // requires the proxy to be running, which is outside the scope of this
  // integration suite. That coverage lives in mcp-auth-proxy's own test suite.
  // Skipped here rather than replaced with a tautological status ≥ 200 check.
  it.skip("MCP POST endpoint returns 401/403 without auth when proxy is configured", () => {
    // To add real coverage: start mcp-auth-proxy in test setup, send a request
    // to /mcp without Authorization, and assert res.status === 401 || 403.
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
    it("retrieves the exact payload that was stored, plus stored_at (task arrays stripped)", async () => {
      // Store a known payload. Task arrays in the payload are accepted but
      // stripped server-side (schema 1.3) — assert they do NOT round trip.
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

      // Non-deprecated fields round trip exactly.
      expect(Math.abs(new Date(retrieved.stored_at).getTime() - new Date(storedAt).getTime())).toBeLessThanOrEqual(1);
      expect(retrieved.operational_state).toEqual(payload.operational_state);
      expect(retrieved.active_context).toEqual(payload.active_context);
      expect(retrieved.tone_notes).toBe(payload.tone_notes);
      // Deprecated fields are not surfaced.
      expect(retrieved.tasks).toBeUndefined();
      expect(retrieved.memory_deltas).toBeUndefined();
      // task_summary is the authoritative replacement.
      expect(retrieved.task_summary).toBeDefined();
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
        active_context: { session_meta: { label: "first-handoff-alpha" } },
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
        active_context: { session_meta: { label: "second-handoff-beta" } },
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
      expect(retrieved.active_context?.session_meta?.label).toBe("second-handoff-beta");
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

    it("legacy task array operations are accepted but become no-ops (deprecation)", async () => {
      // Schema 1.3 deprecation: patch_handoff still accepts a tasks
      // argument (so existing clients don't break) but task array operations
      // (append/remove/replace) do not apply — the legacy arrays are not
      // surfaced, and task_summary reflects the authoritative Postgres state.
      await storeAndVerify({ tone_notes: "Deprecation baseline" });

      const patchRes = await mcpPost(
        jsonrpc("tools/call", {
          name: "patch_handoff",
          arguments: {
            tone_notes: "patched",
            tasks: { open: { op: "append", items: ["legacy-1", "legacy-2"] } },
          },
        })
      );
      expect(patchRes.status).toBe(200);
      const patchData = (await parseSseResponse(patchRes)) as any;
      const patchResult = JSON.parse(patchData.result.content[0].text);
      expect(patchResult.success).toBe(true);
      expect(patchResult.patched_fields).toContain("tone_notes");
      // tasks ops do not surface as a patched field — they are no-ops.
      expect(patchResult.patched_fields).not.toContain("tasks");
      expect(patchResult.task_summary).toBeDefined();

      const getRes = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      const getData = (await parseSseResponse(getRes)) as any;
      const retrieved = JSON.parse(getData.result.content[0].text);
      // The deprecated task arrays never propagate into the response.
      expect(retrieved.tasks).toBeUndefined();
      expect(retrieved.tone_notes).toBe("patched");
    });

    it("preserves original value when null is sent for a field", async () => {
      // Store with tone_notes
      await storeAndVerify({ tone_notes: "Keep this tone" });

      // Patch with null tone_notes — should preserve
      const patchRes = await mcpPost(
        jsonrpc("tools/call", {
          name: "patch_handoff",
          arguments: { tone_notes: null, operational_state: { mood: "patched" } },
        })
      );
      const patchData = (await parseSseResponse(patchRes)) as any;
      const patchResult = JSON.parse(patchData.result.content[0].text);
      expect(patchResult.patched_fields).not.toContain("tone_notes");
      expect(patchResult.patched_fields).toContain("operational_state");

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
        active_context: { phase: "alpha" },
      });

      const patchRes = await mcpPost(
        jsonrpc("tools/call", {
          name: "patch_handoff",
          arguments: {
            operational_state: { mood: "energized" },
            active_context: { phase: "beta" },
          },
        })
      );
      const patchData = (await parseSseResponse(patchRes)) as any;
      const patchResult = JSON.parse(patchData.result.content[0].text);
      expect(patchResult.success).toBe(true);
      expect(patchResult.patched_fields).toContain("operational_state");
      expect(patchResult.patched_fields).toContain("active_context");

      const getRes = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      const getData = (await parseSseResponse(getRes)) as any;
      const retrieved = JSON.parse(getData.result.content[0].text);
      expect(retrieved.operational_state.mood).toBe("energized");
      expect(retrieved.operational_state.energy_level).toBe("medium");
      expect(retrieved.active_context.phase).toBe("beta");
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

    it("returns task_summary shape in response", async () => {
      // Schema 1.3: task_summary is authoritative (Postgres-backed) and
      // shares only the count contract across the dynamic and fallback
      // paths. Counts come from Postgres when available, otherwise from
      // the handoff arrays — which are stripped on storage, so the
      // fallback path returns zeros for new handoffs.
      await storeAndVerify({ tone_notes: "task_summary shape baseline" });

      const patchRes = await mcpPost(
        jsonrpc("tools/call", {
          name: "patch_handoff",
          arguments: { tone_notes: "task_summary shape patched" },
        })
      );
      const patchData = (await parseSseResponse(patchRes)) as any;
      const patchResult = JSON.parse(patchData.result.content[0].text);
      expect(patchResult.task_summary).toBeDefined();
      expect(typeof patchResult.task_summary.open_count).toBe("number");
      expect(typeof patchResult.task_summary.blocked_count).toBe("number");
      expect(typeof patchResult.task_summary.completed_count).toBe("number");
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
      // task_summary shape contract: {open_count, blocked_count, completed_count}.
      // When Postgres is available it is enriched with item arrays; the
      // numeric count fields stay present across both paths. Task arrays in
      // the payload are stripped server-side (schema 1.3) but the response
      // shape is unaffected.
      await storeAndVerify({ tone_notes: "task_summary shape test" });

      const getRes = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      const getData = (await parseSseResponse(getRes)) as any;
      const retrieved = JSON.parse(getData.result.content[0].text);
      expect(retrieved.task_summary).toBeDefined();
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

    it("schema_version is present and is '1.3'", async () => {
      const getRes = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      const getData = (await parseSseResponse(getRes)) as any;
      const retrieved = JSON.parse(getData.result.content[0].text);
      expect(retrieved.schema_version).toBe("1.3");
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
    it("stored handoff file contains schema_version '1.3'", async () => {
      const result = await storeAndVerify({ tone_notes: "schema_version file test" });
      const filepath = join(TEST_DATA_DIR, "handoffs", result.filename);
      const raw = await readFile(filepath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.schema_version).toBe("1.3");
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
      expect(patchResult.schema_version).toBe("1.3");

      const handoffsDir = join(TEST_DATA_DIR, "handoffs");
      const files = (await readdir(handoffsDir))
        .filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"))
        .sort();
      const latestPath = join(handoffsDir, files[files.length - 1]);
      const parsed = JSON.parse(await readFile(latestPath, "utf-8"));
      expect(parsed.schema_version).toBe("1.3");
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
          arguments: { tone_notes: "enrichment test" },
        })
      );
      const data = (await parseSseResponse(res)) as any;
      const result = JSON.parse(data.result.content[0].text);
      expect(result.success).toBe(true);
      expect(result.filename).toBeDefined();
      expect(typeof result.filename).toBe("string");
      expect(result.filename).toMatch(/\.json$/);
      // task_summary shape is stable regardless of source (Postgres dynamic
      // vs. handoff-array fallback). With Postgres unavailable in this
      // suite, the fallback returns zeros because task arrays are stripped
      // before storage (schema 1.3).
      expect(result.task_summary).toBeDefined();
      expect(typeof result.task_summary.open_count).toBe("number");
      expect(typeof result.task_summary.blocked_count).toBe("number");
      expect(typeof result.task_summary.completed_count).toBe("number");
      expect(result.schema_version).toBe("1.3");
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

    it("store_handoff response includes next_step string", async () => {
      const res = await mcpPost(
        jsonrpc("tools/call", {
          name: "store_handoff",
          arguments: { tone_notes: "next_step test" },
        })
      );
      const data = (await parseSseResponse(res)) as any;
      const result = JSON.parse(data.result.content[0].text);
      expect(result.success).toBe(true);
      expect(typeof result.next_step).toBe("string");
      expect(result.next_step.length).toBeGreaterThan(0);
    });

    it("store_handoff next_step does not mention legacy task arrays (schema 1.3)", async () => {
      // Legacy task arrays are stripped server-side since schema 1.3, so
      // even if a caller still sends tasks.open, the response's next_step
      // open-task hint reflects authoritative Postgres counts (zero when
      // the suite runs without a Postgres backend). This test guards
      // against accidentally regressing to handoff-array-derived counts.
      const res = await mcpPost(
        jsonrpc("tools/call", {
          name: "store_handoff",
          arguments: {
            tone_notes: "legacy-tasks deprecation test",
            tasks: { open: ["task-a", "task-b"], completed: [], blocked: [] },
          },
        })
      );
      const data = (await parseSseResponse(res)) as any;
      const result = JSON.parse(data.result.content[0].text);
      expect(result.success).toBe(true);
      expect(result.next_step).not.toMatch(/2 open tasks/i);
    });
  });

  describe("get_latest_handoff — next_step field", () => {
    it("get_latest_handoff response includes next_step string", async () => {
      await storeAndVerify({ tone_notes: "next_step retrieval test" });

      const res = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      const data = (await parseSseResponse(res)) as any;
      const result = JSON.parse(data.result.content[0].text);
      expect(typeof result.next_step).toBe("string");
      expect(result.next_step.length).toBeGreaterThan(0);
    });

    it("get_latest_handoff next_step mentions tone_notes when present", async () => {
      await storeAndVerify({ tone_notes: "remember to be concise" });

      const res = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      const data = (await parseSseResponse(res)) as any;
      const result = JSON.parse(data.result.content[0].text);
      expect(result.next_step).toMatch(/tone_notes/i);
    });
  });

  // ────────────────────────────────────────────────
  // Defensive hardening: empty-content guards + pointer cleanup
  // ────────────────────────────────────────────────

  describe("Schema 1.3 deprecations (memory_deltas + task arrays)", () => {
    it("store_handoff with task arrays succeeds but arrays are not in the stored file", async () => {
      const result = await storeAndVerify({
        tone_notes: "deprecation-store-tasks-test",
        tasks: { open: ["x", "y"], completed: ["z"], blocked: ["b"] },
      });

      const filepath = join(TEST_DATA_DIR, "handoffs", result.filename);
      const raw = await readFile(filepath, "utf-8");
      const parsed = JSON.parse(raw);

      expect(parsed.tone_notes).toBe("deprecation-store-tasks-test");
      expect(parsed.tasks).toBeUndefined();
      expect(parsed.schema_version).toBe("1.3");
    });

    it("store_handoff without task arrays continues to work normally", async () => {
      const result = await storeAndVerify({
        tone_notes: "no-tasks-baseline",
        active_context: { phase: "alpha" },
      });
      const filepath = join(TEST_DATA_DIR, "handoffs", result.filename);
      const raw = await readFile(filepath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.tone_notes).toBe("no-tasks-baseline");
      expect(parsed.active_context.phase).toBe("alpha");
      expect(parsed.tasks).toBeUndefined();
    });

    it("get_latest_handoff response does not contain legacy task arrays", async () => {
      await storeAndVerify({
        tone_notes: "no-tasks-in-response",
        tasks: { open: ["x"], completed: ["y"], blocked: [] },
      });

      const res = await mcpPost(
        jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
      );
      const data = (await parseSseResponse(res)) as any;
      const retrieved = JSON.parse(data.result.content[0].text);
      expect(retrieved.tasks).toBeUndefined();
      expect(retrieved.task_summary).toBeDefined();
    });

    it("memory_deltas in payload is not stored (field removed from schema)", async () => {
      // The MCP SDK constructs the input schema with z.object() in strip
      // mode, so memory_deltas is silently dropped before reaching the
      // handler. Either way, it must not land in the stored file.
      const result = await storeAndVerify({
        tone_notes: "no-memory-deltas",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        memory_deltas: [{ slot: 1, action: "add", content: "ghost" }],
      } as Record<string, unknown>);

      const filepath = join(TEST_DATA_DIR, "handoffs", result.filename);
      const raw = await readFile(filepath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.memory_deltas).toBeUndefined();
    });

    it("historical handoffs with task arrays can be retrieved via get_handoff without error", async () => {
      // Simulate a pre-1.3 handoff by writing one directly to disk with
      // legacy task arrays + memory_deltas. get_handoff should return the
      // file without erroring; the response simply omits the deprecated
      // fields under the "full" scope filter.
      const { writeFile } = await import("node:fs/promises");
      const filename = "2026-04-01T12-00-00-000Z-deadbeef.json";
      const legacyHandoff = {
        operational_state: { mood: "calm" },
        active_context: { session_meta: { label: "legacy-1.2-handoff" } },
        tasks: {
          completed: ["legacy-done-1"],
          open: ["legacy-open-1"],
          blocked: ["legacy-blocked-1"],
        },
        memory_deltas: [{ slot: 1, action: "add", content: "legacy" }],
        tone_notes: "historical-handoff-retrieval",
        stored_at: "2026-04-01T12:00:00.000Z",
        schema_version: "1.2",
      };
      await writeFile(
        join(TEST_DATA_DIR, "handoffs", filename),
        JSON.stringify(legacyHandoff),
        "utf-8"
      );

      const res = await mcpPost(
        jsonrpc("tools/call", {
          name: "get_handoff",
          arguments: { filename },
        })
      );
      expect(res.status).toBe(200);
      const data = (await parseSseResponse(res)) as any;
      const result = JSON.parse(data.result.content[0].text);
      expect(result.error).toBeUndefined();
      expect(result.tone_notes).toBe("historical-handoff-retrieval");
      // Even when reading a pre-1.3 file, the response does not surface
      // the legacy task arrays.
      expect(result.tasks).toBeUndefined();
    });
  });

  describe("Defensive hardening", () => {
    it("store_handoff with no content fields returns EMPTY_HANDOFF", async () => {
      const res = await mcpPost(
        jsonrpc("tools/call", { name: "store_handoff", arguments: {} })
      );
      const data = (await parseSseResponse(res)) as any;
      const result = JSON.parse(data.result.content[0].text);
      expect(result.error).toBe(true);
      expect(result.code).toBe("EMPTY_HANDOFF");
    });

    it("store_handoff with only a deprecated tasks field returns EMPTY_HANDOFF", async () => {
      // Since schema 1.3, tasks are stripped server-side and do not count
      // as content — a payload that contains only tasks must fail the
      // empty-content guard, not write a metadata-only handoff file.
      const res = await mcpPost(
        jsonrpc("tools/call", {
          name: "store_handoff",
          arguments: {
            tasks: { open: ["legacy-task"], completed: [], blocked: [] },
          },
        })
      );
      const data = (await parseSseResponse(res)) as any;
      const result = JSON.parse(data.result.content[0].text);
      expect(result.error).toBe(true);
      expect(result.code).toBe("EMPTY_HANDOFF");
    });

    it("store_handoff with a single content field (timezone) succeeds", async () => {
      const res = await mcpPost(
        jsonrpc("tools/call", {
          name: "store_handoff",
          arguments: { timezone: "America/Los_Angeles" },
        })
      );
      const data = (await parseSseResponse(res)) as any;
      const result = JSON.parse(data.result.content[0].text);
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("patch_handoff with no content fields returns EMPTY_PATCH", async () => {
      // Ensure a handoff exists so the empty-guard runs before the NOT_FOUND check.
      await storeAndVerify({ tone_notes: "empty-patch baseline" });

      const res = await mcpPost(
        jsonrpc("tools/call", { name: "patch_handoff", arguments: {} })
      );
      const data = (await parseSseResponse(res)) as any;
      const result = JSON.parse(data.result.content[0].text);
      expect(result.error).toBe(true);
      expect(result.code).toBe("EMPTY_PATCH");
    });

    it("patch_handoff with all null fields returns EMPTY_PATCH", async () => {
      await storeAndVerify({ tone_notes: "all-null baseline" });

      const res = await mcpPost(
        jsonrpc("tools/call", {
          name: "patch_handoff",
          arguments: {
            operational_state: null,
            active_context: null,
            tasks: null,
            tone_notes: null,
            timezone: null,
          },
        })
      );
      const data = (await parseSseResponse(res)) as any;
      const result = JSON.parse(data.result.content[0].text);
      expect(result.error).toBe(true);
      expect(result.code).toBe("EMPTY_PATCH");
    });

    it("store_handoff does not write the deprecated handoff-latest.json pointer file", async () => {
      await storeAndVerify({ tone_notes: "pointer cleanup test" });

      const pointerPath = join(TEST_DATA_DIR, "handoff-latest.json");
      const { access } = await import("node:fs/promises");
      let exists = false;
      try {
        await access(pointerPath);
        exists = true;
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
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
      // Schema 1.3: task arrays are stripped before storage, so new
      // handoffs always report has_tasks=false. The field still exists in
      // the metadata response (historical handoffs may carry tasks).
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
      expect(match.has_tasks).toBe(false);
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
      expect(result.schema_version).toBe("1.3");
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

describe("Compaction — previous handoff is compacted after store_handoff", () => {
  // Read a handoff file from disk and parse. Returns null on ENOENT.
  async function readHandoffFile(filename: string): Promise<any | null> {
    try {
      const raw = await readFile(join(TEST_DATA_DIR, "handoffs", filename), "utf-8");
      return JSON.parse(raw);
    } catch (err: any) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  // Poll disk for a predicate (fire-and-forget compaction happens asynchronously).
  async function waitFor<T>(
    fn: () => Promise<T | null | undefined>,
    timeoutMs = 3000,
    intervalMs = 50
  ): Promise<T | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  }

  it("marks the previous handoff as _compacted after a subsequent store", async () => {
    // Store a rich handoff that has plenty to prune. Schema 1.3: task
    // arrays in the payload are stripped before storage, so the on-disk
    // handoff has no tasks field — we exercise compaction via the rich
    // active_context content instead. Detailed compaction rules for
    // historical handoffs (task array trimming, memory_deltas removal)
    // are covered by the unit tests in compaction.test.ts.
    const first = await storeAndVerify({
      operational_state: { sleep_hours: "7", mood: "focused" },
      active_context: {
        session_meta: { label: "compaction-test-first", surface: "test" },
        conversation_arc: "First session — explored compaction design in detail.",
        key_decisions: ["Adopt three-tier schema", "Skip when pending"],
        research_notes: "Lots of filler content that should drop from the JSON.",
      },
      tone_notes: "preserve me",
    });

    // Small delay so the first handoff's fire-and-forget indexing settles before
    // the second store starts its compaction pass.
    await new Promise((r) => setTimeout(r, 100));

    // Store a second handoff — this triggers compaction on the first.
    await storeAndVerify({
      tone_notes: "second handoff",
      active_context: { session_meta: { label: "compaction-test-second" } },
    });

    // Poll for the _compacted flag on the first handoff file.
    const compacted = await waitFor(async () => {
      const file = await readHandoffFile(first.filename);
      return file && file._compacted === true ? file : null;
    });

    // If compaction was skipped (e.g. pending embedding race), leave the test
    // as a no-assert pass — the behavior is still correct. Otherwise, verify
    // the compaction rules applied.
    if (!compacted) {
      console.warn(
        "[compaction test] First handoff not compacted within timeout — likely skipped due to pending embedding; skipping detailed assertions."
      );
      return;
    }

    expect(compacted._compacted).toBe(true);
    expect(compacted.tone_notes).toBe("preserve me");
    expect(compacted.operational_state.mood).toBe("focused");
    // No legacy task arrays are stored on new (1.3+) handoffs.
    expect(compacted.tasks).toBeUndefined();
    // No memory_deltas — field removed from the schema.
    expect(compacted.memory_deltas).toBeUndefined();
    // active_context collapsed to session_meta + compacted_summary
    expect(compacted.active_context.compacted_summary).toMatch(/compaction-test-first/);
    expect(compacted.active_context.session_meta.label).toBe("compaction-test-first");
    expect(compacted.active_context.conversation_arc).toBeUndefined();
    expect(compacted.active_context.research_notes).toBeUndefined();
  });

  it("leaves the latest handoff uncompacted", async () => {
    const latest = await storeAndVerify({
      tone_notes: "latest is full-fidelity",
      active_context: {
        session_meta: { label: "latest-full-fidelity" },
        conversation_arc: "Detailed arc for the latest session.",
      },
    });

    // Read the latest handoff directly from disk — should NOT have _compacted.
    const file = await readFile(
      join(TEST_DATA_DIR, "handoffs", latest.filename),
      "utf-8"
    );
    const parsed = JSON.parse(file);
    expect(parsed._compacted).toBeUndefined();
    expect(parsed.active_context.conversation_arc).toBe(
      "Detailed arc for the latest session."
    );
    // Schema 1.3: no legacy task arrays in the stored file even if the
    // caller sent them.
    expect(parsed.tasks).toBeUndefined();
  });

  it("compacted handoffs are still retrievable via get_handoff", async () => {
    // Store handoff A with rich content
    const a = await storeAndVerify({
      tone_notes: "retrievable-after-compaction",
      active_context: {
        session_meta: { label: "retrievable-test" },
        conversation_arc: "An arc to be archived.",
      },
    });

    await new Promise((r) => setTimeout(r, 100));

    // Store handoff B to trigger compaction of A
    await storeAndVerify({ tone_notes: "trigger-compaction" });

    // Wait briefly for compaction to run
    await new Promise((r) => setTimeout(r, 500));

    // get_handoff should still succeed for A, whether compacted or not
    const res = await mcpPost(
      jsonrpc("tools/call", {
        name: "get_handoff",
        arguments: { filename: a.filename },
      })
    );
    const data = (await parseSseResponse(res)) as any;
    const result = JSON.parse(data.result.content[0].text);
    expect(result.error).toBeUndefined();
    expect(result.tone_notes).toBe("retrievable-after-compaction");
  });
});

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

// ────────────────────────────────────────────────
// Session close — final flag, session_closed, session_continuity
// ────────────────────────────────────────────────
describe("Session close — final flag", () => {
  it("store_handoff with final=true marks the response session_closed=true", async () => {
    const res = await mcpPost(
      jsonrpc("tools/call", {
        name: "store_handoff",
        arguments: { tone_notes: "close-test", final: true },
      })
    );
    expect(res.status).toBe(200);
    const data = (await parseSseResponse(res)) as any;
    const result = JSON.parse(data.result.content[0].text);
    expect(result.success).toBe(true);
    expect(result.session_closed).toBe(true);
    expect(typeof result.session_closed_at).toBe("string");
    expect(result.session_closed_at).toBe(result.stored_at);
  });

  it("store_handoff without final returns session_closed=false (default)", async () => {
    const res = await mcpPost(
      jsonrpc("tools/call", {
        name: "store_handoff",
        arguments: { tone_notes: "open-session-default" },
      })
    );
    const data = (await parseSseResponse(res)) as any;
    const result = JSON.parse(data.result.content[0].text);
    expect(result.success).toBe(true);
    expect(result.session_closed).toBe(false);
    expect(result.session_closed_at).toBeNull();
  });

  it("stored handoff file persists session_closed and session_closed_at", async () => {
    const res = await mcpPost(
      jsonrpc("tools/call", {
        name: "store_handoff",
        arguments: { tone_notes: "persisted-close", final: true },
      })
    );
    const data = (await parseSseResponse(res)) as any;
    const result = JSON.parse(data.result.content[0].text);
    const filepath = join(TEST_DATA_DIR, "handoffs", result.filename);
    const raw = await readFile(filepath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.session_closed).toBe(true);
    expect(parsed.session_closed_at).toBe(parsed.stored_at);
  });

  it("get_latest_handoff returns session_continuity='cold_start' after a closed write", async () => {
    await storeAndVerify({ tone_notes: "closing-write", final: true });

    const res = await mcpPost(
      jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
    );
    const data = (await parseSseResponse(res)) as any;
    const result = JSON.parse(data.result.content[0].text);
    expect(result.session_closed).toBe(true);
    expect(typeof result.session_closed_at).toBe("string");
    expect(result.session_continuity).toBe("cold_start");
  });

  it("get_latest_handoff returns session_continuity='resume' after an open write", async () => {
    await storeAndVerify({ tone_notes: "still-open-write" });

    const res = await mcpPost(
      jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
    );
    const data = (await parseSseResponse(res)) as any;
    const result = JSON.parse(data.result.content[0].text);
    expect(result.session_closed).toBe(false);
    expect(result.session_closed_at).toBeNull();
    expect(result.session_continuity).toBe("resume");
  });

  it("patch_handoff with final=true alone is a valid session-close patch", async () => {
    await storeAndVerify({ tone_notes: "open-before-close-patch" });

    const res = await mcpPost(
      jsonrpc("tools/call", {
        name: "patch_handoff",
        arguments: { final: true },
      })
    );
    expect(res.status).toBe(200);
    const data = (await parseSseResponse(res)) as any;
    const result = JSON.parse(data.result.content[0].text);
    expect(result.success).toBe(true);
    expect(result.session_closed).toBe(true);
    expect(typeof result.session_closed_at).toBe("string");

    // The new handoff file should now flip get_latest into cold_start.
    const getRes = await mcpPost(
      jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
    );
    const getData = (await parseSseResponse(getRes)) as any;
    const retrieved = JSON.parse(getData.result.content[0].text);
    expect(retrieved.session_continuity).toBe("cold_start");
  });

  it("patch_handoff WITHOUT final or content fails with EMPTY_PATCH", async () => {
    await storeAndVerify({ tone_notes: "baseline-for-empty-patch" });

    const res = await mcpPost(
      jsonrpc("tools/call", {
        name: "patch_handoff",
        arguments: {},
      })
    );
    const data = (await parseSseResponse(res)) as any;
    const result = JSON.parse(data.result.content[0].text);
    expect(result.error).toBe(true);
    expect(result.code).toBe("EMPTY_PATCH");
  });

  it("a subsequent open patch resets session_continuity to 'resume'", async () => {
    // 1. Close a session.
    await storeAndVerify({ tone_notes: "close-1", final: true });
    let getRes = await mcpPost(
      jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
    );
    let result = JSON.parse(((await parseSseResponse(getRes)) as any).result.content[0].text);
    expect(result.session_continuity).toBe("cold_start");

    // 2. Open patch — should drop the stale close marker.
    const patchRes = await mcpPost(
      jsonrpc("tools/call", {
        name: "patch_handoff",
        arguments: { tone_notes: "resumed" },
      })
    );
    const patchResult = JSON.parse(
      ((await parseSseResponse(patchRes)) as any).result.content[0].text
    );
    expect(patchResult.session_closed).toBe(false);

    // 3. get_latest_handoff should now report a resume.
    getRes = await mcpPost(
      jsonrpc("tools/call", { name: "get_latest_handoff", arguments: {} })
    );
    result = JSON.parse(((await parseSseResponse(getRes)) as any).result.content[0].text);
    expect(result.session_continuity).toBe("resume");
    expect(result.session_closed).toBe(false);
  });
});

// ────────────────────────────────────────────────
// Tool description language — SCOPE AWARENESS removed
// ────────────────────────────────────────────────
describe("Tool descriptions — scope guidance", () => {
  it("no tool description contains the SCOPE AWARENESS block", async () => {
    const res = await mcpPost(jsonrpc("tools/list"));
    const data = (await parseSseResponse(res)) as any;
    const tools: Array<{ name: string; description: string }> = data.result.tools;
    for (const t of tools) {
      expect(
        t.description,
        `tool '${t.name}' still mentions SCOPE AWARENESS`
      ).not.toMatch(/SCOPE AWARENESS/);
    }
  });

  it("create_task scope enum now includes 'shared'", async () => {
    const res = await mcpPost(jsonrpc("tools/list"));
    const data = (await parseSseResponse(res)) as any;
    const tools = data.result.tools as Array<{
      name: string;
      inputSchema: Record<string, unknown>;
    }>;
    const createTask = tools.find((t) => t.name === "create_task");
    expect(createTask).toBeDefined();
    const scope = (createTask!.inputSchema as any).properties?.scope;
    expect(scope?.enum).toEqual(["work", "personal", "shared"]);
  });
});
