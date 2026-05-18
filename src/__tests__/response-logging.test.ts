import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
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

const TEST_DATA_DIR_OFF = join(process.cwd(), "data", "test-resp-log-off");
const TEST_DATA_DIR_ON = join(process.cwd(), "data", "test-resp-log-on");

/** Reserve an ephemeral port by listening on 0 then closing — avoids fixed-port flake. */
async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("Could not get port from server"));
      }
    });
  });
}

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

/**
 * Poll `stdout` for log entries matching `predicate` until `timeoutMs`
 * elapses. Avoids fixed setTimeout sleeps in tests, which are flaky on
 * slow CI. Returns the matched entries (may be empty on timeout).
 */
async function waitForLogEntries(
  stdout: string[],
  baseline: number,
  predicate: (entry: Record<string, unknown>) => boolean,
  timeoutMs = 5_000
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = parseLogEntries(stdout.slice(baseline)).filter(predicate);
    if (entries.length > 0) return entries;
    await new Promise((r) => setTimeout(r, 25));
  }
  return parseLogEntries(stdout.slice(baseline)).filter(predicate);
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
let offPort: number;
let onPort: number;

beforeAll(async () => {
  await rm(TEST_DATA_DIR_OFF, { recursive: true, force: true });
  await rm(TEST_DATA_DIR_ON, { recursive: true, force: true });
  await mkdir(TEST_DATA_DIR_OFF, { recursive: true });
  await mkdir(TEST_DATA_DIR_ON, { recursive: true });

  offPort = await pickFreePort();
  onPort = await pickFreePort();

  offServer = spawnServer(offPort, TEST_DATA_DIR_OFF);
  onServer = spawnServer(onPort, TEST_DATA_DIR_ON, {
    LOG_RESPONSE_BODIES: "true",
  });

  await Promise.all([
    waitForServer(`http://localhost:${offPort}`),
    waitForServer(`http://localhost:${onPort}`),
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
    const res = await mcpPost(`http://localhost:${offPort}`, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "store_handoff", arguments: { tone_notes: "log test" } },
      id: 99,
    });
    expect(res.status).toBe(200);

    const entries = await waitForLogEntries(
      offServer.stdout,
      before,
      (e) => e.request_id === 99
    );
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
    await mcpPost(`http://localhost:${offPort}`, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "store_handoff", arguments: { tone_notes: "no-body-log" } },
      id: 100,
    });
    const entries = await waitForLogEntries(
      offServer.stdout,
      before,
      (e) => e.request_id === 100
    );
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries[entries.length - 1];
    expect("body" in entry).toBe(false);
  });

  it("includes the response body when LOG_RESPONSE_BODIES=true is set", async () => {
    const before = onServer.stdout.length;
    await mcpPost(`http://localhost:${onPort}`, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "store_handoff", arguments: { tone_notes: "with-body-log" } },
      id: 101,
    });
    const entries = await waitForLogEntries(
      onServer.stdout,
      before,
      (e) => e.request_id === 101
    );
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries[entries.length - 1];
    expect(typeof entry.body).toBe("string");
    // The body is the SSE-formatted response.
    expect((entry.body as string).length).toBeGreaterThan(0);
  });
});
