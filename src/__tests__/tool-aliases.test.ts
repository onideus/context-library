import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawnServer, stopServer } from "./helpers/spawn-server.js";
import {
  TOOL_ALIASES,
  aliasDescription,
  legacyNamesFor,
  registerTool,
} from "../tools/tool-aliases.js";

/**
 * Deprecated tool-name aliases (LEGACY_TOOL_NAMES).
 *
 * Two servers: one with the flag unset (aliases on, the default) and one with
 * LEGACY_TOOL_NAMES=false. tools/list and the file-backed handoff aliases run
 * without Postgres; the artifact aliases are Postgres-gated. The note alias
 * (str_replace_note) is covered in notes.test.ts and the entity-graph aliases
 * in entities/entity-tools.test.ts.
 */

const PORT_ON = 3189;
const PORT_OFF = 3188;
const DATA_ON = join(process.cwd(), "data", "test-tool-aliases-on");
const DATA_OFF = join(process.cwd(), "data", "test-tool-aliases-off");

const PG_DATABASE = "cl_test_tool_aliases";
const PG_USER = process.env.PGUSER ?? "cl";
const PG_PASSWORD = process.env.PGPASSWORD ?? "test";
const PG_HOST = process.env.PGHOST ?? "localhost";
const PG_PORT = process.env.PGPORT ?? "5432";

const NEW_NAMES = [
  "create_handoff",
  "update_handoff",
  "create_artifact",
  "edit_artifact",
  "edit_note",
  "list_entities",
  "get_entity_relations",
  "create_extraction_run",
  "compare_extraction_runs",
];
const OLD_NAMES = Object.keys(TOOL_ALIASES);

// ── Helpers ──────────────────────────────────────────────────────

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

async function parseSseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) return JSON.parse(text);
  return JSON.parse(dataLine.slice(5).trim());
}

function jsonrpc(method: string, params?: Record<string, unknown>, id = 1) {
  return { jsonrpc: "2.0", method, ...(params ? { params } : {}), id };
}

async function mcpPost(port: number, body: unknown) {
  return fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

async function callTool(port: number, name: string, args: Record<string, unknown> = {}) {
  const res = await mcpPost(port, jsonrpc("tools/call", { name, arguments: args }));
  const data = (await parseSseResponse(res)) as any;
  return JSON.parse(data.result.content[0].text);
}

interface ListedTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

async function listTools(port: number): Promise<Map<string, ListedTool>> {
  const res = await mcpPost(port, jsonrpc("tools/list"));
  const data = (await parseSseResponse(res)) as any;
  return new Map((data.result.tools as ListedTool[]).map((t) => [t.name, t]));
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
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [PG_DATABASE]);
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

function serverEnv(port: number, dataDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MCP_PORT: String(port),
    DATA_DIR: dataDir,
    ...(pgAvailable
      ? { PGHOST: PG_HOST, PGPORT: PG_PORT, PGUSER: PG_USER, PGPASSWORD: PG_PASSWORD, PGDATABASE: PG_DATABASE }
      : // Closed port: instant ECONNREFUSED, the file-only path.
        { PGHOST: "127.0.0.1", PGPORT: "1" }),
    ...extra,
  };
  delete env.LEGACY_TOOL_NAMES;
  if (extra.LEGACY_TOOL_NAMES !== undefined) env.LEGACY_TOOL_NAMES = extra.LEGACY_TOOL_NAMES;
  return env;
}

// ── Unit: the alias table and wrapper ────────────────────────────

describe("tool alias table", () => {
  it("maps exactly the nine renamed tools", () => {
    expect(TOOL_ALIASES).toEqual({
      store_handoff: "create_handoff",
      patch_handoff: "update_handoff",
      store_artifact: "create_artifact",
      patch_artifact: "edit_artifact",
      str_replace_note: "edit_note",
      browse_entities: "list_entities",
      entity_relations: "get_entity_relations",
      run_extraction: "create_extraction_run",
      compare_extractions: "compare_extraction_runs",
    });
    expect(Object.values(TOOL_ALIASES).sort()).toEqual([...NEW_NAMES].sort());
    expect(OLD_NAMES).not.toContain("reindex");
  });

  it("registerTool registers the new name plus a logging alias with the same schema and handler", async () => {
    // LEGACY_TOOL_NAMES is unset in the test process, so aliases are on.
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const handler = vi.fn(async (args: { value: string }) => ({
      content: [{ type: "text" as const, text: JSON.stringify({ echoed: args.value }) }],
    }));
    registerTool(server, "create_handoff", "New description", { value: z.string() }, handler);

    const tools = (server as any)._registeredTools as Record<string, any>;
    expect(Object.keys(tools).sort()).toEqual(["create_handoff", "store_handoff"]);
    expect(tools.store_handoff.description).toBe(aliasDescription("create_handoff"));
    expect(tools.create_handoff.description).toBe("New description");
    expect(legacyNamesFor("create_handoff")).toEqual(["store_handoff"]);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const extra = { signal: new AbortController().signal };
      const viaAlias = await tools.store_handoff.handler({ value: "x" }, extra);
      expect(viaAlias.content[0].text).toBe(JSON.stringify({ echoed: "x" }));
      expect(log).toHaveBeenCalledWith("[deprecated-tool] store_handoff called; use create_handoff");
      log.mockClear();
      await tools.create_handoff.handler({ value: "y" }, extra);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

// ── Integration: tools/list with and without the flag ────────────

let serverOn: ChildProcess | null = null;
let serverOff: ChildProcess | null = null;

beforeAll(async () => {
  for (const dir of [DATA_ON, DATA_OFF]) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
  }
  serverOn = spawnServer(serverEnv(PORT_ON, DATA_ON));
  serverOff = spawnServer(
    serverEnv(PORT_OFF, DATA_OFF, { PGHOST: "127.0.0.1", PGPORT: "1", LEGACY_TOOL_NAMES: "false" })
  );
  await Promise.all([
    waitForServer(`http://localhost:${PORT_ON}`),
    waitForServer(`http://localhost:${PORT_OFF}`),
  ]);
}, 60_000);

afterAll(async () => {
  if (serverOn) await stopServer(serverOn);
  if (serverOff) await stopServer(serverOff);
  for (const dir of [DATA_ON, DATA_OFF]) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("tools/list", () => {
  it("with LEGACY_TOOL_NAMES unset lists every new and every old name, and no reindex", async () => {
    const tools = await listTools(PORT_ON);
    for (const name of [...NEW_NAMES, ...OLD_NAMES]) {
      expect(tools.has(name), name).toBe(true);
    }
    expect(tools.has("reindex")).toBe(false);
    expect(tools.has("search_context")).toBe(true);
  });

  it("with LEGACY_TOOL_NAMES=false lists the new names only", async () => {
    const on = await listTools(PORT_ON);
    const off = await listTools(PORT_OFF);
    for (const name of NEW_NAMES) expect(off.has(name), name).toBe(true);
    for (const name of OLD_NAMES) expect(off.has(name), name).toBe(false);
    expect(off.has("reindex")).toBe(false);
    expect(on.size - off.size).toBe(OLD_NAMES.length);
  });

  it("each alias is described as deprecated and shares the new tool's input schema", async () => {
    const tools = await listTools(PORT_ON);
    for (const [oldName, newName] of Object.entries(TOOL_ALIASES)) {
      const alias = tools.get(oldName)!;
      expect(alias.description.startsWith(`Deprecated alias of ${newName}`), oldName).toBe(true);
      if (oldName === "str_replace_note") continue; // keeps the old input shape
      expect(alias.inputSchema, oldName).toEqual(tools.get(newName)!.inputSchema);
    }
  });

  it("str_replace_note keeps its old input schema; edit_note takes edits", async () => {
    const tools = await listTools(PORT_ON);
    const oldProps = Object.keys((tools.get("str_replace_note")!.inputSchema as any).properties).sort();
    expect(oldProps).toEqual(["expected_version", "id", "new_str", "old_str", "replace_all"]);
    const newProps = Object.keys((tools.get("edit_note")!.inputSchema as any).properties).sort();
    expect(newProps).toEqual(["edits", "expected_version", "id"]);
  });

  it("no new-name description tells the caller to use an old name", async () => {
    const tools = await listTools(PORT_OFF);
    const oldNamePattern = new RegExp(
      `\\b(${[...OLD_NAMES.filter((n) => n !== "str_replace_note"), "reindex"].join("|")})\\b`
    );
    for (const tool of tools.values()) {
      // entity_relations is also a table name; only flag it as a tool reference.
      // `npm run reindex` (the operator script) is the allowed mention of reindex.
      const text = tool.description
        .replace(/entity_relations table/g, "")
        .replace(/npm run reindex/g, "");
      expect(text.match(oldNamePattern)?.[0], tool.name).toBeUndefined();
    }
    // str_replace_note may appear only in get_note_history, as a recorded value.
    for (const tool of tools.values()) {
      if (tool.name === "get_note_history") continue;
      expect(tool.description.includes("str_replace_note"), tool.name).toBe(false);
    }
  });
});

// ── Alias calls return what the new name returns ─────────────────

function sortedKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort();
}

describe("handoff aliases (file-backed)", () => {
  it("store_handoff returns the same top-level keys as create_handoff", async () => {
    // Warm-up so both compared calls see an existing previous handoff.
    await callTool(PORT_ON, "create_handoff", { tone_notes: "warm-up" });
    const viaNew = await callTool(PORT_ON, "create_handoff", { tone_notes: "alias check new" });
    const viaOld = await callTool(PORT_ON, "store_handoff", { tone_notes: "alias check old" });
    expect(viaNew.success).toBe(true);
    expect(sortedKeys(viaOld)).toEqual(sortedKeys(viaNew));
  });

  it("patch_handoff returns the same top-level keys as update_handoff", async () => {
    await callTool(PORT_ON, "create_handoff", { tone_notes: "patch base" });
    const viaNew = await callTool(PORT_ON, "update_handoff", { tone_notes: "patched new" });
    const viaOld = await callTool(PORT_ON, "patch_handoff", { tone_notes: "patched old" });
    expect(viaNew.error).toBeUndefined();
    expect(sortedKeys(viaOld)).toEqual(sortedKeys(viaNew));
  });

  it("patch_handoff returns the same error code as update_handoff", async () => {
    const viaNew = await callTool(PORT_ON, "update_handoff", {});
    const viaOld = await callTool(PORT_ON, "patch_handoff", {});
    expect(viaNew.error).toBe(true);
    expect(viaOld.code).toBe(viaNew.code);
    expect(sortedKeys(viaOld)).toEqual(sortedKeys(viaNew));
  });
});

describe.skipIf(!pgAvailable)("artifact aliases (Postgres)", () => {
  const draft = (title: string) => ({
    title,
    artifact_type: "research",
    scope: "work",
    content: "Acme Corp findings: alpha beta",
  });

  it("store_artifact returns the same top-level keys as create_artifact", async () => {
    const viaNew = await callTool(PORT_ON, "create_artifact", draft("Alias check new"));
    const viaOld = await callTool(PORT_ON, "store_artifact", draft("Alias check old"));
    expect(viaNew.error).toBeUndefined();
    expect(sortedKeys(viaOld)).toEqual(sortedKeys(viaNew));
  });

  it("patch_artifact returns the same keys and error codes as edit_artifact", async () => {
    const a = await callTool(PORT_ON, "create_artifact", draft("Patch alias a"));
    const b = await callTool(PORT_ON, "create_artifact", draft("Patch alias b"));
    const edits = [{ old_str: "alpha", new_str: "gamma" }];
    const viaNew = await callTool(PORT_ON, "edit_artifact", { id: a.id, edits });
    const viaOld = await callTool(PORT_ON, "patch_artifact", { id: b.id, edits });
    expect(viaNew.error).toBeUndefined();
    expect(viaOld.replacements).toEqual(viaNew.replacements);
    expect(sortedKeys(viaOld)).toEqual(sortedKeys(viaNew));

    const missing = [{ old_str: "absent", new_str: "x" }];
    const errNew = await callTool(PORT_ON, "edit_artifact", { id: a.id, edits: missing });
    const errOld = await callTool(PORT_ON, "patch_artifact", { id: b.id, edits: missing });
    expect(errNew.code).toBe("NO_MATCH");
    expect(errOld.code).toBe(errNew.code);
    expect(sortedKeys(errOld)).toEqual(sortedKeys(errNew));
  });
});
