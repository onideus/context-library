import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock db/client and embeddings/indexer before importing the module under test
vi.mock("../db/client.js", () => ({
  query: vi.fn(),
}));

vi.mock("../embeddings/indexer.js", () => ({
  indexArtifact: vi.fn().mockResolvedValue(undefined),
}));

import { query } from "../db/client.js";
import { registerArtifactTools } from "../tools/artifacts.js";

const mockQuery = vi.mocked(query);

// Minimal fake row returned from the DB so the handlers don't blow up
function fakeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    title: "Test artifact",
    artifact_type: "cc-prompt",
    content: "hello",
    pointer: null,
    status: "draft",
    scope: "work",
    tags: [],
    dependencies: [],
    execution_order: null,
    related_task_ids: [],
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// Capture tool handlers by intercepting mcpServer.tool()
type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function buildMockServer() {
  const handlers: Record<string, ToolHandler> = {};
  const mcpServer = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      handlers[name] = handler;
    },
  };
  registerArtifactTools(mcpServer as never);
  return handlers;
}

describe("artifact_type normalization", () => {
  let handlers: Record<string, ToolHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = buildMockServer();
  });

  it("store_artifact normalizes uppercase artifact_type to lowercase", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow()], rowCount: 1 } as never);

    await handlers["store_artifact"]({
      title: "My prompt",
      artifact_type: "CC-Prompt",
      scope: "work",
      content: "some content",
    });

    const insertCall = mockQuery.mock.calls[0];
    const params = insertCall[1] as unknown[];
    // $2 is artifact_type (index 1 in params array)
    expect(params[1]).toBe("cc-prompt");
  });

  it("store_artifact trims whitespace from artifact_type", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow()], rowCount: 1 } as never);

    await handlers["store_artifact"]({
      title: "My prompt",
      artifact_type: " cc-prompt ",
      scope: "work",
      content: "some content",
    });

    const insertCall = mockQuery.mock.calls[0];
    const params = insertCall[1] as unknown[];
    expect(params[1]).toBe("cc-prompt");
  });

  it("update_artifact normalizes artifact_type in SET clause", async () => {
    const existing = fakeRow();
    // First query: SELECT existing row
    mockQuery.mockResolvedValueOnce({ rows: [existing], rowCount: 1 } as never);
    // Second query: UPDATE RETURNING
    mockQuery.mockResolvedValueOnce({ rows: [existing], rowCount: 1 } as never);

    await handlers["update_artifact"]({
      id: existing.id,
      artifact_type: "CC-Prompt",
    });

    const updateCall = mockQuery.mock.calls[1];
    const params = updateCall[1] as unknown[];
    // The first param in the UPDATE is artifact_type (only field being set)
    expect(params[0]).toBe("cc-prompt");
  });

  it("list_artifacts normalizes artifact_type filter", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await handlers["list_artifacts"]({ artifact_type: "CC-Prompt" });

    // Both COUNT and SELECT queries receive the normalized value as $1
    const countCall = mockQuery.mock.calls[0];
    const countParams = countCall[1] as unknown[];
    expect(countParams[0]).toBe("cc-prompt");
  });

  it("search_artifacts normalizes artifact_type filter", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await handlers["search_artifacts"]({
      query: "hello",
      artifact_type: "CC-Prompt",
    });

    // The COUNT query params: [$1=query, $2=artifact_type_filter]
    const countCall = mockQuery.mock.calls[0];
    const countParams = countCall[1] as unknown[];
    expect(countParams[1]).toBe("cc-prompt");
  });
});
