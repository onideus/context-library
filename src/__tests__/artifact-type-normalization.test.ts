import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../db/client.js", () => ({
  query: vi.fn(),
}));

vi.mock("../embeddings/indexer.js", () => ({
  indexArtifact: vi.fn().mockResolvedValue(undefined),
}));

import { query } from "../db/client.js";
import { registerArtifactTools } from "../tools/artifacts.js";

const mockQuery = query as ReturnType<typeof vi.fn>;

const MOCK_ROW = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  title: "Test artifact",
  artifact_type: "cc-prompt",
  content: "test content",
  pointer: null,
  status: "draft",
  scope: "work",
  tags: [],
  dependencies: [],
  execution_order: null,
  related_task_ids: [],
  metadata: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

function buildHandlers(): Record<string, ToolHandler> {
  const handlers: Record<string, ToolHandler> = {};
  const mockServer = {
    tool(name: string, _desc: string, _schema: unknown, handler: ToolHandler) {
      handlers[name] = handler;
    },
  } as unknown as McpServer;
  registerArtifactTools(mockServer);
  return handlers;
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("artifact_type normalization on write", () => {
  let handlers: Record<string, ToolHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = buildHandlers();
  });

  it("store_artifact normalizes casing before INSERT", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...MOCK_ROW, artifact_type: "cc-prompt" }] });

    await handlers.store_artifact({
      title: "My artifact",
      artifact_type: "CC-Prompt",
      scope: "work",
      content: "some content",
    });

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    // INSERT params: $1=title, $2=artifact_type
    expect(params[1]).toBe("cc-prompt");
  });

  it("store_artifact trims whitespace before INSERT", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...MOCK_ROW, artifact_type: "cc-prompt" }] });

    await handlers.store_artifact({
      title: "My artifact",
      artifact_type: " cc-prompt ",
      scope: "work",
      content: "some content",
    });

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBe("cc-prompt");
  });

  it("update_artifact normalizes artifact_type in UPDATE SET", async () => {
    // First query: SELECT current artifact
    mockQuery.mockResolvedValueOnce({ rows: [MOCK_ROW] });
    // Second query: UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [{ ...MOCK_ROW, artifact_type: "cc-prompt" }] });

    await handlers.update_artifact({
      id: MOCK_ROW.id,
      artifact_type: "CC-Prompt",
    });

    // UPDATE is the second call; params[0] = artifact_type value, params[1] = id
    const [, params] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(params[0]).toBe("cc-prompt");
  });

  it("list_artifacts normalizes artifact_type filter in WHERE", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await handlers.list_artifacts({ artifact_type: "CC-Prompt" });

    // Both COUNT and data queries share the same params array; check COUNT call
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe("cc-prompt");
  });

  it("search_artifacts normalizes artifact_type filter in WHERE", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await handlers.search_artifacts({
      query: "test search",
      artifact_type: "CC-Prompt",
    });

    // params[0] = FTS query ($1), params[1] = artifact_type ($2)
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe("test search");
    expect(params[1]).toBe("cc-prompt");
  });
});
