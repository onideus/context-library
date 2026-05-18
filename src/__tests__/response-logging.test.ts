import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Verifies the structured response logger emits one JSON line per /mcp
 * request with the expected fields, and that response bodies are only logged
 * when LOG_RESPONSE_BODIES=true.
 *
 * Spawns its own server (separate port + data dir) so it can capture stdout
 * directly. Two server instances are started — one with body logging off
 * (default) and one with body logging on — to cover both code paths.
 */

const TEST_PORT_OFF = 3196;
const TEST_PORT_ON = 3195;
const TEST_DATA_DIR_OFF = join(process.cwd(), "data", "test-resp-log-off");
const TEST_DATA_DIR_ON = join(process.cwd(), "data", "test-resp-log-on");

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

function spawnServer(
  port: number,
  dataDir: string,
  extraEnv: Record<string, string> = {}
): { proc: ChildProcess; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const proc = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: (() => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        MCP_PORT: String(port),
        DATA_DIR: dataDir,
        ...extraEnv,
      };
      delete env.APP_VERSION;
      return env;
    })(),
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
  });

  // Buffer the lines so tests can search for log entries after the request.
  let outBuf = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    outBuf += chunk.toString("utf-8");
    while (outBuf.includes("\n")) {
      const idx = outBuf.indexOf("\n");
      stdout.push(outBuf.slice(0, idx));
      outBuf = outBuf.slice(idx + 1);
    }
  });
  let errBuf = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    errBuf += chunk.toString("utf-8");
    while (errBuf.includes("\n")) {
      const idx = errBuf.indexOf("\n");
      stderr.push(errBuf.slice(0, idx));
      errBuf = errBuf.slice(idx + 1);
    }
  });
  return { proc, stdout, stderr };
}

function parseLogEntries(lines: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.type === "mcp_response") out.push(parsed);
    } catch {
      // Not a JSON line — ignore.
    }
  }
  return out;
}

async function mcpPost(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
    },
    body: JSON.stringify(body),
  });
}

let offServer: ReturnType<typeof spawnServer>;
let onServer: ReturnType<typeof spawnServer>;

beforeAll(async () => {
  await rm(TEST_DATA_DIR_OFF, { recursive: true, force: true });
  await rm(TEST_DATA_DIR_ON, { recursive: true, force: true });
  await mkdir(TEST_DATA_DIR_OFF, { recursive: true });
  await mkdir(TEST_DATA_DIR_ON, { recursive: true });

  offServer = spawnServer(TEST_PORT_OFF, TEST_DATA_DIR_OFF);
  onServer = spawnServer(TEST_PORT_ON, TEST_DATA_DIR_ON, {
    LOG_RESPONSE_BODIES: "true",
  });

  await Promise.all([
    waitForServer(`http://localhost:${TEST_PORT_OFF}`),
    waitForServer(`http://localhost:${TEST_PORT_ON}`),
  ]);
}, 45_000);

afterAll(async () => {
  for (const s of [offServer, onServer]) {
    if (!s?.proc) continue;
    s.proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (!s.proc.killed) s.proc.kill("SIGKILL");
  }
  await rm(TEST_DATA_DIR_OFF, { recursive: true, force: true });
  await rm(TEST_DATA_DIR_ON, { recursive: true, force: true });
});

describe("Structured response logging", () => {
  it("emits one mcp_response log entry per /mcp request with expected fields", async () => {
    const before = offServer.stdout.length;
    const res = await mcpPost(`http://localhost:${TEST_PORT_OFF}`, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "store_handoff", arguments: { tone_notes: "log test" } },
      id: 99,
    });
    expect(res.status).toBe(200);

    // Give the logger a moment to flush.
    await new Promise((r) => setTimeout(r, 100));

    const entries = parseLogEntries(offServer.stdout.slice(before));
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries[entries.length - 1];
    expect(entry.level).toBe("info");
    expect(entry.type).toBe("mcp_response");
    expect(typeof entry.correlation_id).toBe("string");
    expect(entry.tool).toBe("store_handoff");
    expect(entry.request_id).toBe(99);
    expect(entry.status).toBe("success");
    expect(entry.http_status).toBe(200);
    expect(typeof entry.duration_ms).toBe("number");
    expect((entry.duration_ms as number) >= 0).toBe(true);
    expect(typeof entry.size_bytes).toBe("number");
    expect((entry.size_bytes as number) > 0).toBe(true);
  });

  it("does not include response body at default log level (no LOG_RESPONSE_BODIES)", async () => {
    const before = offServer.stdout.length;
    await mcpPost(`http://localhost:${TEST_PORT_OFF}`, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "store_handoff", arguments: { tone_notes: "no-body-log" } },
      id: 100,
    });
    await new Promise((r) => setTimeout(r, 100));
    const entries = parseLogEntries(offServer.stdout.slice(before));
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries[entries.length - 1];
    expect("body" in entry).toBe(false);
  });

  it("includes the response body when LOG_RESPONSE_BODIES=true is set", async () => {
    const before = onServer.stdout.length;
    await mcpPost(`http://localhost:${TEST_PORT_ON}`, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "store_handoff", arguments: { tone_notes: "with-body-log" } },
      id: 101,
    });
    await new Promise((r) => setTimeout(r, 100));
    const entries = parseLogEntries(onServer.stdout.slice(before));
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries[entries.length - 1];
    expect(typeof entry.body).toBe("string");
    // The body is the SSE-formatted response.
    expect((entry.body as string).length).toBeGreaterThan(0);
  });
});
