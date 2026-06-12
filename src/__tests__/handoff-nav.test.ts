import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Handoff navigation tool integration tests (list_handoffs + get_handoff).
 *
 * Handoffs are file-based — no Postgres required. The server is spawned
 * against an isolated data directory so listing counts are deterministic.
 */

const TEST_PORT = 3193;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_DATA_DIR = join(process.cwd(), "data", "test-handoff-nav");
const HANDOFFS_DIR = join(TEST_DATA_DIR, "handoffs");

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

/** Call a tool and return the parsed result payload */
async function callTool(name: string, args: Record<string, unknown> = {}) {
  const res = await mcpPost(jsonrpc("tools/call", { name, arguments: args }));
  expect(res.status).toBe(200);
  const data = (await parseSseResponse(res)) as any;
  return JSON.parse(data.result.content[0].text);
}

/** Store a handoff and verify it succeeded. Returns the parsed result. */
async function storeAndVerify(payload: Record<string, unknown>) {
  const result = await callTool("store_handoff", payload);
  expect(result.success).toBe(true);
  return result;
}

// Filenames of the three handoffs stored by the ordering test, in store order
// (oldest first). Later pagination/filter tests reference these.
const storedFilenames: string[] = [];

beforeAll(async () => {
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
  await mkdir(TEST_DATA_DIR, { recursive: true });

  serverProcess = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCP_PORT: String(TEST_PORT),
      DATA_DIR: TEST_DATA_DIR,
      // This suite is file-based — force the Postgres-unavailable path
      // deterministically by pointing pg at a closed port (instant
      // ECONNREFUSED). Without this the server inherits PG* env or pg's
      // defaults (localhost:5432, OS user, no password) and, when a local
      // Postgres is running, every query fails mid-SASL-auth — node-postgres
      // leaks the socket and the backend sits in authentication until
      // timeout, exhausting connection slots for the Postgres-gated suites
      // running in parallel.
      PGHOST: "127.0.0.1",
      PGPORT: "1",
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
    await new Promise((r) => setTimeout(r, 500));
    if (!serverProcess.killed) serverProcess.kill("SIGKILL");
  }
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
});

// ────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────

describe("list_handoffs", () => {
  it("returns an empty result before any handoff is stored", async () => {
    // The handoffs/ directory does not exist yet — the ENOENT path must
    // return an empty page, not throw.
    const result = await callTool("list_handoffs", {});
    expect(result.handoffs).toEqual([]);
    expect(result.total_count).toBe(0);
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(0);
  });

  it("returns metadata sorted newest first with the documented shape", async () => {
    // Store three handoffs with small delays so filename timestamps differ.
    const first = await storeAndVerify({
      tone_notes: "nav-first",
      active_context: { session_meta: { label: "nav-label-first" } },
      tasks: { open: ["a"], completed: [], blocked: [] },
    });
    await new Promise((r) => setTimeout(r, 50));
    const second = await storeAndVerify({
      tone_notes: "nav-second",
      active_context: { session_meta: { label: "nav-label-second" } },
    });
    await new Promise((r) => setTimeout(r, 50));
    const third = await storeAndVerify({
      tone_notes: "nav-third",
      active_context: { session_meta: { label: "nav-label-third" } },
      tasks: { open: [], completed: ["done"], blocked: [] },
    });
    storedFilenames.push(first.filename, second.filename, third.filename);

    const result = await callTool("list_handoffs", {});
    expect(result.total_count).toBe(3);
    expect(result.handoffs.length).toBe(3);

    // Newest first
    expect(result.handoffs.map((h: any) => h.filename)).toEqual([
      third.filename,
      second.filename,
      first.filename,
    ]);

    // Metadata-only entry shape — no handoff content fields
    const entry = result.handoffs[0];
    expect(entry).toHaveProperty("filename");
    expect(entry).toHaveProperty("stored_at");
    expect(entry).toHaveProperty("session_label");
    expect(entry).toHaveProperty("size_bytes");
    expect(entry).toHaveProperty("has_tasks");
    expect(entry).toHaveProperty("schema_version");
    expect(entry).not.toHaveProperty("tone_notes");
    expect(entry).not.toHaveProperty("operational_state");

    // Extracted metadata values
    expect(entry.session_label).toBe("nav-label-third");
    // Since schema 1.3, store_handoff drops legacy task arrays on write, so
    // newly stored handoffs never contain a tasks key — has_tasks is true
    // only for pre-1.3 files already on disk.
    expect(entry.has_tasks).toBe(false);
    expect(entry.size_bytes).toBeGreaterThan(0);
    expect(entry.schema_version).toBe("1.3");

    expect(result.handoffs[1].session_label).toBe("nav-label-second");
    expect(result.handoffs[1].has_tasks).toBe(false);

    // stored_at parses back from the filename as a valid ISO timestamp
    for (const h of result.handoffs) {
      expect(new Date(h.stored_at).toISOString()).toBe(h.stored_at);
    }
  });

  it("paginates with limit and offset and reports stable total_count", async () => {
    const page1 = await callTool("list_handoffs", { limit: 2, offset: 0 });
    expect(page1.handoffs.length).toBe(2);
    expect(page1.total_count).toBe(3);
    expect(page1.limit).toBe(2);
    expect(page1.offset).toBe(0);
    expect(page1.handoffs.map((h: any) => h.filename)).toEqual([
      storedFilenames[2],
      storedFilenames[1],
    ]);

    const page2 = await callTool("list_handoffs", { limit: 2, offset: 2 });
    expect(page2.handoffs.length).toBe(1);
    expect(page2.total_count).toBe(3);
    expect(page2.offset).toBe(2);
    expect(page2.handoffs[0].filename).toBe(storedFilenames[0]);
  });

  it("returns an empty page when offset is beyond total_count", async () => {
    const result = await callTool("list_handoffs", { limit: 10, offset: 50 });
    expect(result.handoffs).toEqual([]);
    expect(result.total_count).toBe(3);
    expect(result.offset).toBe(50);
  });

  it("ignores temp files and non-handoff files in the directory", async () => {
    await writeFile(join(HANDOFFS_DIR, ".tmp-abc123.json"), "{}", "utf-8");
    await writeFile(join(HANDOFFS_DIR, "not-a-handoff.json"), "{}", "utf-8");
    await writeFile(join(HANDOFFS_DIR, "README.txt"), "stray", "utf-8");

    const result = await callTool("list_handoffs", {});
    expect(result.total_count).toBe(3);
    const filenames = result.handoffs.map((h: any) => h.filename);
    expect(filenames).not.toContain(".tmp-abc123.json");
    expect(filenames).not.toContain("not-a-handoff.json");
    expect(filenames).not.toContain("README.txt");
  });

  it("lists corrupt handoff files with default (null) metadata instead of failing", async () => {
    // Valid filename pattern, invalid JSON content — the metadata read is
    // wrapped in try/catch, so the entry appears with defaults.
    const corruptFilename = "2020-01-01T00-00-00-000Z-deadbeef.json";
    await writeFile(join(HANDOFFS_DIR, corruptFilename), "{not valid json", "utf-8");

    const result = await callTool("list_handoffs", {});
    expect(result.total_count).toBe(4);
    const corrupt = result.handoffs.find((h: any) => h.filename === corruptFilename);
    expect(corrupt).toBeDefined();
    expect(corrupt.session_label).toBeNull();
    expect(corrupt.has_tasks).toBe(false);
    expect(corrupt.schema_version).toBeNull();
    expect(corrupt.size_bytes).toBeGreaterThan(0);
    // 2020 timestamp sorts oldest — last in the newest-first ordering
    expect(result.handoffs[result.handoffs.length - 1].filename).toBe(corruptFilename);
  });

  it("filters by after (exclusive) using the filename timestamp", async () => {
    // Use the stored_at values the tool itself derives from filenames so the
    // boundary comparison is exact.
    const all = await callTool("list_handoffs", {});
    const storedAtByFilename = new Map<string, string>(
      all.handoffs.map((h: any) => [h.filename, h.stored_at])
    );
    const oldestRealStoredAt = storedAtByFilename.get(storedFilenames[0])!;

    const result = await callTool("list_handoffs", { after: oldestRealStoredAt });
    const filenames = result.handoffs.map((h: any) => h.filename);
    // Boundary is exclusive — the oldest real handoff and the 2020 corrupt
    // file are both excluded.
    expect(result.total_count).toBe(2);
    expect(filenames).toEqual([storedFilenames[2], storedFilenames[1]]);
  });

  it("filters by before (exclusive) using the filename timestamp", async () => {
    const all = await callTool("list_handoffs", {});
    const storedAtByFilename = new Map<string, string>(
      all.handoffs.map((h: any) => [h.filename, h.stored_at])
    );
    const newestStoredAt = storedAtByFilename.get(storedFilenames[2])!;

    const result = await callTool("list_handoffs", { before: newestStoredAt });
    const filenames = result.handoffs.map((h: any) => h.filename);
    expect(result.total_count).toBe(3);
    expect(filenames).not.toContain(storedFilenames[2]);
    expect(filenames).toContain(storedFilenames[0]);
    expect(filenames).toContain(storedFilenames[1]);
  });

  it("combines after and before into a window", async () => {
    const all = await callTool("list_handoffs", {});
    const storedAtByFilename = new Map<string, string>(
      all.handoffs.map((h: any) => [h.filename, h.stored_at])
    );

    const result = await callTool("list_handoffs", {
      after: storedAtByFilename.get(storedFilenames[0])!,
      before: storedAtByFilename.get(storedFilenames[2])!,
    });
    expect(result.total_count).toBe(1);
    expect(result.handoffs[0].filename).toBe(storedFilenames[1]);
  });

  it("returns nothing for an after date in the future", async () => {
    const future = new Date(Date.now() + 1000 * 60 * 60).toISOString();
    const result = await callTool("list_handoffs", { after: future });
    expect(result.handoffs).toEqual([]);
    expect(result.total_count).toBe(0);
  });

  it("ignores unparseable after/before strings instead of failing", async () => {
    const result = await callTool("list_handoffs", {
      after: "not-a-date",
      before: "also-not-a-date",
    });
    // NaN filters are skipped — full unfiltered listing
    expect(result.total_count).toBe(4);
  });
});

describe("get_handoff", () => {
  it("retrieves a stored handoff by filename with the enrichment envelope", async () => {
    const result = await callTool("get_handoff", {
      filename: storedFilenames[0],
    });

    expect(result.error).toBeUndefined();
    expect(result.tone_notes).toBe("nav-first");
    expect(result.active_context.session_meta.label).toBe("nav-label-first");
    expect(result.applied_scope).toBe("full");
    expect(result.filtered_fields).toBeUndefined();
    expect(result.schema_version).toBe("1.3");
    expect(typeof result.retrieved_at).toBe("string");
    expect(typeof result.elapsed_seconds).toBe("number");
    expect(result.elapsed_seconds).toBeGreaterThanOrEqual(0);
    expect(typeof result.same_calendar_day).toBe("boolean");
    // stored_at_local is null when the handoff has no timezone (this fixture
    // doesn't set one); the timezone-bearing case is covered below.
    expect(result.stored_at_local).toBeNull();
    // task_summary shape is dynamic (Postgres) or fallback (handoff arrays);
    // both expose the three numeric counts.
    expect(typeof result.task_summary.open_count).toBe("number");
    expect(typeof result.task_summary.blocked_count).toBe("number");
    expect(typeof result.task_summary.completed_count).toBe("number");
  });

  it("applies scope filtering and reports filtered_fields", async () => {
    const stored = await storeAndVerify({
      operational_state: { sleep_hours: "7", mood: "ok" },
      tone_notes: "nav scope filter",
      tasks: { open: ["t"], completed: [], blocked: [] },
      timezone: "America/New_York",
    });

    const result = await callTool("get_handoff", {
      filename: stored.filename,
      scope: "work",
    });
    expect(result.error).toBeUndefined();
    expect(result.applied_scope).toBe("work");
    expect(result.filtered_fields).toBeDefined();
    // sleep_hours is personal — filtered out under 'work' scope
    expect(result.filtered_fields).toContain("operational_state.sleep_hours");
    // With a timezone present, stored_at_local is a formatted local string
    expect(typeof result.stored_at_local).toBe("string");
  });

  it("returns NOT_FOUND for a well-formed filename that does not exist", async () => {
    const result = await callTool("get_handoff", {
      filename: "2099-01-01T00-00-00-000Z-deadbeef.json",
    });
    expect(result.error).toBe(true);
    expect(result.code).toBe("NOT_FOUND");
    expect(result.message).toBe("Handoff not found");
  });

  it("rejects path traversal, absolute paths, and malformed filenames", async () => {
    const attempts = [
      "../../etc/passwd",
      "../../../etc/passwd",
      "..%2F..%2Fetc%2Fpasswd", // encoded traversal still contains '..'
      "/etc/passwd", // absolute path
      "/data/handoffs/2099-01-01T00-00-00-000Z-deadbeef.json",
      "subdir/2099-01-01T00-00-00-000Z-deadbeef.json", // forward slash
      "..\\..\\secret.json", // backslash traversal
      "2099-01-01T00-00-00-000Z-deadbeef/../x.json", // embedded traversal
      "not-a-valid-handoff.json", // fails FILENAME_PATTERN
      "2099-01-01T00-00-00-000Z-deadbeef.json.bak", // suffix breaks pattern
      "", // empty filename
    ];
    for (const filename of attempts) {
      const result = await callTool("get_handoff", { filename });
      expect(result.error).toBe(true);
      expect(result.code).toBe("NOT_FOUND");
      // The validation branch (pre-filesystem) returns this message,
      // distinguishing rejection from a plain missing file.
      expect(result.message).toBe("Invalid or unknown filename");
    }
  });
});
