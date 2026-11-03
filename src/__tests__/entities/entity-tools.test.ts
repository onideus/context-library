/**
 * Tests for entity MCP tools — parameter validation and response shape.
 * Storage layer is mocked; no real DB or provider calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../../db/client.js", () => ({
  query: vi.fn(),
  pool: { end: vi.fn() },
}));

vi.mock("../../entities/registry.js", () => ({
  getProvider: vi.fn(),
  getActiveProvider: vi.fn(),
}));

vi.mock("../../entities/store.js", () => ({
  createExtractionRun: vi.fn().mockResolvedValue("run-001"),
  completeExtractionRun: vi.fn().mockResolvedValue(undefined),
  failExtractionRun: vi.fn().mockResolvedValue(undefined),
  storeTriples: vi.fn().mockResolvedValue(3),
  getRelationsForEntity: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../embeddings/indexer.js", () => ({
  extractHandoffText: vi.fn().mockReturnValue("extracted handoff text"),
}));

vi.mock("../../storage/json-store.js", () => ({
  getLatestHandoffFilename: vi.fn().mockResolvedValue("handoff-001.json"),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue('{"session_goal":"test"}'),
  readdir: vi.fn().mockResolvedValue(["handoff-001.json"]),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { query } from "../../db/client.js";
import { getProvider, getActiveProvider } from "../../entities/registry.js";
import { createExtractionRun, storeTriples } from "../../entities/store.js";
import { registerEntityTools } from "../../tools/entity-tools.js";

const queryMock = query as ReturnType<typeof vi.fn>;
const getProviderMock = getProvider as ReturnType<typeof vi.fn>;
const getActiveProviderMock = getActiveProvider as ReturnType<typeof vi.fn>;
const createRunMock = createExtractionRun as ReturnType<typeof vi.fn>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeServer() {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerEntityTools(server);
  return server;
}

function makeMockProvider(name = "ollama", available = true) {
  return {
    provider: name,
    version: "1.0.0",
    available: vi.fn().mockResolvedValue(available),
    extract: vi.fn().mockResolvedValue({
      triples: [
        { subject: "A", predicate: "uses", object: "B", confidence: 0.9 },
        { subject: "C", predicate: "rel", object: "D", confidence: 0.8 },
      ],
      provider: name,
      providerVersion: "1.0.0",
      contentType: "note",
      contentId: "note-001",
      durationMs: 42,
    }),
  };
}

async function callTool(server: McpServer, toolName: string, args: Record<string, unknown>) {
  const tools = server["_registeredTools"] as Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool not found: ${toolName}`);
  const extra = { signal: new AbortController().signal };
  return tool.handler(args, extra);
}

function parseResult(result: unknown) {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text);
}

// ── extract_entities ──────────────────────────────────────────────────────────

describe("extract_entities tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns NO_PROVIDER error when no provider is configured", async () => {
    getActiveProviderMock.mockReturnValue(undefined);
    const server = makeServer();

    const result = parseResult(await callTool(server, "extract_entities", { content_type: "handoff" }));
    expect(result.error).toBe(true);
    expect(result.code).toBe("NO_PROVIDER");
  });

  it("returns PROVIDER_UNAVAILABLE when provider.available() is false", async () => {
    const provider = makeMockProvider("ollama", false);
    getActiveProviderMock.mockReturnValue(provider);
    const server = makeServer();

    const result = parseResult(await callTool(server, "extract_entities", { content_type: "handoff" }));
    expect(result.error).toBe(true);
    expect(result.code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("extracts from most recent handoff when content_id is omitted", async () => {
    const provider = makeMockProvider();
    getActiveProviderMock.mockReturnValue(provider);
    const server = makeServer();

    const result = parseResult(await callTool(server, "extract_entities", { content_type: "handoff" }));
    expect(result.error).toBeUndefined();
    expect(result.run_id).toBe("run-001");
    expect(result.provider_used).toBe("ollama");
    expect(result.triple_count).toBe(3); // storeTriples mock returns 3
    expect(result.entity_count).toBe(4); // A, B, C, D
  });

  it("uses named provider when provider param is specified", async () => {
    const provider = makeMockProvider("api");
    getProviderMock.mockReturnValue(provider);
    const server = makeServer();

    const result = parseResult(await callTool(server, "extract_entities", {
      content_type: "handoff",
      provider: "api",
    }));
    expect(result.provider_used).toBe("api");
  });

  it("returns VALIDATION_ERROR for note when content_id is omitted", async () => {
    const provider = makeMockProvider();
    getActiveProviderMock.mockReturnValue(provider);
    const server = makeServer();

    const result = parseResult(await callTool(server, "extract_entities", {
      content_type: "note",
      // no content_id
    }));
    expect(result.error).toBe(true);
    expect(result.code).toBe("VALIDATION_ERROR");
  });

  it("returns NOT_FOUND when note query returns no rows", async () => {
    const provider = makeMockProvider();
    getActiveProviderMock.mockReturnValue(provider);
    queryMock.mockResolvedValueOnce({ rows: [] });
    const server = makeServer();

    const result = parseResult(await callTool(server, "extract_entities", {
      content_type: "note",
      content_id: "00000000-0000-0000-0000-000000000001",
    }));
    expect(result.error).toBe(true);
    expect(result.code).toBe("NOT_FOUND");
  });
});

// ── create_extraction_run ────────────────────────────────────────────────────────────

describe("create_extraction_run tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockResolvedValue({ rows: [] }); // notes query returns nothing
  });

  it("returns NO_PROVIDER error when provider is not registered", async () => {
    getProviderMock.mockReturnValue(undefined);
    getActiveProviderMock.mockReturnValue(undefined);
    const server = makeServer();

    const result = parseResult(await callTool(server, "create_extraction_run", { provider: "nonexistent" }));
    expect(result.error).toBe(true);
    expect(result.code).toBe("NO_PROVIDER");
  });

  it("returns PROVIDER_UNAVAILABLE when provider.available() is false", async () => {
    const provider = makeMockProvider("ollama", false);
    getProviderMock.mockReturnValue(provider);
    const server = makeServer();

    const result = parseResult(await callTool(server, "create_extraction_run", { provider: "ollama" }));
    expect(result.error).toBe(true);
    expect(result.code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("processes handoffs only when scope is 'handoffs'", async () => {
    const provider = makeMockProvider();
    getProviderMock.mockReturnValue(provider);
    const server = makeServer();

    const result = parseResult(await callTool(server, "create_extraction_run", {
      provider: "ollama",
      scope: "handoffs",
    }));
    expect(result.error).toBeUndefined();
    expect(result.scope).toBe("handoffs");
    expect(result.status).toBe("completed");
  });

  it("returns run_ids array and metadata on success", async () => {
    const provider = makeMockProvider();
    getProviderMock.mockReturnValue(provider);
    const server = makeServer();

    const result = parseResult(await callTool(server, "create_extraction_run", {
      provider: "ollama",
      scope: "handoffs",
    }));
    expect(Array.isArray(result.run_ids)).toBe(true);
    expect(result.provider_used).toBe("ollama");
    expect(typeof result.duration_ms).toBe("number");
  });
});

// ── compare_extraction_runs ───────────────────────────────────────────────────────

describe("compare_extraction_runs tool", () => {
  const runA = {
    id: "aaa-run",
    provider: "ollama",
    provider_version: "1.0.0",
    status: "completed",
    content_scope: null,
    content_count: 0,
    triple_count: 5,
    started_at: "2025-01-01T00:00:00Z",
    completed_at: "2025-01-01T00:00:01Z",
    error: null,
  };
  const runB = {
    ...runA,
    id: "bbb-run",
    provider: "api",
    triple_count: 4,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns NOT_FOUND when run A does not exist", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }); // runs query
    const server = makeServer();

    const result = parseResult(await callTool(server, "compare_extraction_runs", {
      run_id_a: "aaa-run",
      run_id_b: "bbb-run",
    }));
    expect(result.error).toBe(true);
    expect(result.code).toBe("NOT_FOUND");
  });

  it("returns comparison stats when both runs exist", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [runA, runB] })       // runs fetch
      .mockResolvedValueOnce({ rows: [{ count: "2" }] })   // overlap
      .mockResolvedValueOnce({ rows: [                     // avg confidence
        { run_id: "aaa-run", avg_confidence: "0.88" },
        { run_id: "bbb-run", avg_confidence: "0.82" },
      ] })
      .mockResolvedValueOnce({ rows: [] })                  // type distribution
      .mockResolvedValueOnce({ rows: [] });                 // top triples

    const server = makeServer();
    const result = parseResult(await callTool(server, "compare_extraction_runs", {
      run_id_a: "aaa-run",
      run_id_b: "bbb-run",
    }));

    expect(result.error).toBeUndefined();
    expect(result.run_a.id).toBe("aaa-run");
    expect(result.run_a.provider).toBe("ollama");
    expect(result.run_a.triple_count).toBe(5);
    expect(result.run_b.id).toBe("bbb-run");
    expect(result.overlap_count).toBe(2);
    expect(result.unique_to_a).toBe(3);
    expect(result.unique_to_b).toBe(2);
    expect(typeof result.overlap_pct).toBe("number");
    expect(result.run_a.avg_confidence).toBeCloseTo(0.88);
  });
});

// ── list_extraction_runs ──────────────────────────────────────────────────────

describe("list_extraction_runs tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns runs list", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: "run-1",
          provider: "ollama",
          provider_version: "1.0.0",
          status: "completed",
          content_scope: null,
          content_count: 3,
          triple_count: 12,
          started_at: "2025-01-01T00:00:00Z",
          completed_at: "2025-01-01T00:00:05Z",
          error: null,
        },
      ],
    });

    const server = makeServer();
    const result = parseResult(await callTool(server, "list_extraction_runs", {}));

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].id).toBe("run-1");
    expect(result.runs[0].provider).toBe("ollama");
    expect(result.runs[0].triple_count).toBe(12);
    expect(result.total).toBe(1);
  });

  it("returns empty runs list when no runs exist", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const server = makeServer();
    const result = parseResult(await callTool(server, "list_extraction_runs", {}));
    expect(result.runs).toEqual([]);
    expect(result.total).toBe(0);
  });
});

// ── list_entities ───────────────────────────────────────────────────────────

describe("list_entities tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns entity list with mention and relation counts", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: "ent-1",
          name: "PostgreSQL",
          entity_type: "technology",
          canonical_name: "postgresql",
          mention_count: 5,
          relation_count: "3",
          first_seen: "2025-01-01T00:00:00Z",
          last_seen: "2025-01-02T00:00:00Z",
        },
      ],
    });

    const server = makeServer();
    const result = parseResult(await callTool(server, "list_entities", {}));

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].id).toBe("ent-1");
    expect(result.entities[0].name).toBe("PostgreSQL");
    expect(result.entities[0].entity_type).toBe("technology");
    expect(result.entities[0].mention_count).toBe(5);
    expect(result.entities[0].relation_count).toBe(3);
    expect(result.count).toBe(1);
  });

  it("returns empty result with helpful next_step when no entities", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const server = makeServer();
    const result = parseResult(await callTool(server, "list_entities", {}));

    expect(result.entities).toEqual([]);
    expect(result.next_step).toContain("extract_entities");
  });
});

// ── get_entity_relations ──────────────────────────────────────────────────────────

describe("get_entity_relations tool", () => {
  const rootEntity = {
    id: "ent-root",
    name: "PostgreSQL",
    entity_type: "technology",
    canonical_name: "postgresql",
    mention_count: 3,
    first_seen: "2025-01-01T00:00:00Z",
    last_seen: "2025-01-02T00:00:00Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns NOT_FOUND when entity does not exist", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }); // root entity fetch
    const server = makeServer();

    const result = parseResult(await callTool(server, "get_entity_relations", { entity_id: "ent-root" }));
    expect(result.error).toBe(true);
    expect(result.code).toBe("NOT_FOUND");
  });

  it("returns entity with empty relations when none exist", async () => {
    queryMock.mockResolvedValueOnce({ rows: [rootEntity] }); // root entity
    // getRelationsForEntity mock returns [] by default

    const server = makeServer();
    const result = parseResult(await callTool(server, "get_entity_relations", { entity_id: "ent-root" }));

    expect(result.entity.id).toBe("ent-root");
    expect(result.entity.name).toBe("PostgreSQL");
    expect(result.relations).toEqual([]);
    expect(result.relation_count).toBe(0);
  });

  it("includes entity names in enriched relations", async () => {
    const { getRelationsForEntity } = await import("../../entities/store.js");
    (getRelationsForEntity as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: "rel-1",
        source_entity_id: "ent-root",
        target_entity_id: "ent-other",
        relation_type: "used_by",
        confidence: 0.9,
        provider: "ollama",
        extraction_run_id: "run-1",
        source_content_type: "note",
        source_content_id: "note-1",
        context_snippet: null,
        created_at: "2025-01-01T00:00:00Z",
      },
    ]);

    queryMock
      .mockResolvedValueOnce({ rows: [rootEntity] })    // root entity
      .mockResolvedValueOnce({                          // resolve other entities
        rows: [{ id: "ent-other", name: "Backend Service", entity_type: "concept" }],
      });

    const server = makeServer();
    const result = parseResult(await callTool(server, "get_entity_relations", { entity_id: "ent-root" }));

    expect(result.relations).toHaveLength(1);
    expect(result.relations[0].source.name).toBe("PostgreSQL");
    expect(result.relations[0].target.name).toBe("Backend Service");
    expect(result.relations[0].relation_type).toBe("used_by");
    expect(result.relations[0].confidence).toBe(0.9);
  });
});

// ── Deprecated aliases (LEGACY_TOOL_NAMES, on by default) ───────────────────

describe("deprecated entity-graph aliases", () => {
  const ALIASES: Array<[string, string]> = [
    ["run_extraction", "create_extraction_run"],
    ["compare_extractions", "compare_extraction_runs"],
    ["browse_entities", "list_entities"],
    ["entity_relations", "get_entity_relations"],
  ];

  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function registered(server: McpServer) {
    return server["_registeredTools"] as Record<
      string,
      { description?: string; inputSchema?: unknown }
    >;
  }

  it("registers each alias with a deprecation description and the new tool's schema", () => {
    const tools = registered(makeServer());
    for (const [oldName, newName] of ALIASES) {
      expect(tools[oldName], oldName).toBeDefined();
      expect(tools[oldName].description).toMatch(new RegExp(`^Deprecated alias of ${newName}\\b`));
      expect(tools[oldName].inputSchema).toEqual(tools[newName].inputSchema);
    }
  });

  it("run_extraction returns the same NO_PROVIDER error as create_extraction_run", async () => {
    getProviderMock.mockReturnValue(undefined);
    getActiveProviderMock.mockReturnValue(undefined);
    const server = makeServer();
    const viaNew = parseResult(await callTool(server, "create_extraction_run", { provider: "nonexistent" }));
    const viaOld = parseResult(await callTool(server, "run_extraction", { provider: "nonexistent" }));
    expect(viaNew.code).toBe("NO_PROVIDER");
    expect(viaOld).toEqual(viaNew);
  });

  it("compare_extractions returns the same NOT_FOUND error as compare_extraction_runs", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const server = makeServer();
    const args = { run_id_a: "aaa-run", run_id_b: "bbb-run" };
    const viaNew = parseResult(await callTool(server, "compare_extraction_runs", args));
    const viaOld = parseResult(await callTool(server, "compare_extractions", args));
    expect(viaNew.code).toBe("NOT_FOUND");
    expect(viaOld).toEqual(viaNew);
  });

  it("browse_entities returns the same shape as list_entities", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const server = makeServer();
    const viaNew = parseResult(await callTool(server, "list_entities", {}));
    const viaOld = parseResult(await callTool(server, "browse_entities", {}));
    expect(Object.keys(viaOld).sort()).toEqual(Object.keys(viaNew).sort());
    expect(viaOld).toEqual(viaNew);
  });

  it("entity_relations returns the same NOT_FOUND error as get_entity_relations", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const server = makeServer();
    const viaNew = parseResult(await callTool(server, "get_entity_relations", { entity_id: "ent-root" }));
    const viaOld = parseResult(await callTool(server, "entity_relations", { entity_id: "ent-root" }));
    expect(viaNew.code).toBe("NOT_FOUND");
    expect(viaOld).toEqual(viaNew);
  });

  it("logs one deprecation line per alias call", async () => {
    getProviderMock.mockReturnValue(undefined);
    getActiveProviderMock.mockReturnValue(undefined);
    const server = makeServer();
    await callTool(server, "run_extraction", { provider: "nonexistent" });
    expect(logSpy).toHaveBeenCalledWith(
      "[deprecated-tool] run_extraction called; use create_extraction_run"
    );
  });
});
