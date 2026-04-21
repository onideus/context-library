import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock("../db/client.js", () => ({
  query: mockQuery,
}));

vi.mock("../embeddings/indexer.js", () => ({
  indexArtifact: vi.fn().mockResolvedValue(undefined),
}));

import { registerArtifactTools } from "../tools/artifacts.js";

function buildHandlers(): Record<string, Function> {
  const handlers: Record<string, Function> = {};
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: Function) => {
      handlers[name] = handler;
    },
  } as unknown as McpServer;
  registerArtifactTools(server);
  return handlers;
}

function parseResult(raw: { content: Array<{ text: string }> }) {
  return JSON.parse(raw.content[0].text);
}

const FAKE_ROW = {
  id: "aaaaaaaa-0000-0000-0000-000000000000",
  title: "Test artifact",
  artifact_type: "cc-prompt",
  content: "body",
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

describe("artifact_type normalization", () => {
  let handlers: Record<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = buildHandlers();
  });

  describe("store_artifact", () => {
    it("lowercases artifact_type before INSERT", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [FAKE_ROW] });

      const raw = await handlers["store_artifact"]({
        title: "Test",
        artifact_type: "CC-Prompt",
        scope: "work",
        content: "body",
      });
      const result = parseResult(raw);

      expect(result.error).toBeUndefined();
      // params[1] is artifact_type in the INSERT VALUES ($1, $2, ...)
      const insertParams = mockQuery.mock.calls[0][1];
      expect(insertParams[1]).toBe("cc-prompt");
    });

    it("trims whitespace from artifact_type before INSERT", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [FAKE_ROW] });

      await handlers["store_artifact"]({
        title: "Test",
        artifact_type: " cc-prompt ",
        scope: "work",
        content: "body",
      });

      const insertParams = mockQuery.mock.calls[0][1];
      expect(insertParams[1]).toBe("cc-prompt");
    });
  });

  describe("list_artifacts", () => {
    it("normalizes artifact_type filter to lowercase before WHERE clause", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: "1" }] })
        .mockResolvedValueOnce({ rows: [FAKE_ROW] });

      await handlers["list_artifacts"]({ artifact_type: "CC-Prompt" });

      // COUNT query receives the normalized filter as the first param
      const countParams = mockQuery.mock.calls[0][1];
      expect(countParams[0]).toBe("cc-prompt");
    });
  });

  describe("update_artifact", () => {
    it("trims and lowercases artifact_type before UPDATE SET", async () => {
      // First call: SELECT existing row
      mockQuery.mockResolvedValueOnce({ rows: [FAKE_ROW] });
      // Second call: UPDATE
      mockQuery.mockResolvedValueOnce({ rows: [{ ...FAKE_ROW, artifact_type: "cc-prompt" }] });

      const raw = await handlers["update_artifact"]({
        id: FAKE_ROW.id,
        artifact_type: " CC-Prompt ",
      });
      const result = parseResult(raw);

      expect(result.error).toBeUndefined();
      // UPDATE params: [normalizedType, id] (artifact_type is the only SET field)
      const updateParams = mockQuery.mock.calls[1][1];
      expect(updateParams[0]).toBe("cc-prompt");
    });
  });

  describe("search_artifacts", () => {
    it("normalizes artifact_type filter to lowercase before search WHERE clause", async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: "0" }] })
        .mockResolvedValueOnce({ rows: [] });

      await handlers["search_artifacts"]({
        query: "some content",
        artifact_type: "CC-Prompt",
      });

      // COUNT query params: [query_text, artifact_type_filter]
      const countParams = mockQuery.mock.calls[0][1];
      expect(countParams[1]).toBe("cc-prompt");
    });
  });
});
