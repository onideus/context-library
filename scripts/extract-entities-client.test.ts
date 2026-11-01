import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { extractBatch } from "./extract-entities.js";

// Drives extractBatch through the real SDK client with a stubbed fetch, so an
// SDK upgrade that reshapes the Messages request or response surfaces here
// instead of only on a live run of the script.

interface Captured {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: Record<string, unknown>;
}

function stubClient(content: unknown[]): { client: Anthropic; calls: Captured[] } {
  const calls: Captured[] = [];
  const client = new Anthropic({
    apiKey: "test-key",
    baseURL: "http://anthropic.test",
    maxRetries: 0,
    fetch: async (input, init) => {
      calls.push({
        url: String(input instanceof Request ? input.url : input),
        method: init?.method,
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "test-model",
          container: null,
          content,
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });
  return { client, calls };
}

const batch = [{ filename: "2026-01-01T00-00-00.json", body: { summary: "Worked on project-alpha" } }];

describe("extractBatch against the SDK client", () => {
  it("sends a Messages request and parses the text block", async () => {
    const { client, calls } = stubClient([
      {
        type: "text",
        citations: null,
        text: JSON.stringify([
          { canonical_name: "project-alpha", scope: "work", aliases: ["alpha"], constraints: [], confidence: 0.8 },
          { canonical_name: "bogus", scope: "nowhere" },
        ]),
      },
    ]);

    const result = await extractBatch(client, "test-model", batch);

    expect(result).toEqual([
      { canonical_name: "project-alpha", scope: "work", aliases: ["alpha"], constraints: [], confidence: 0.8 },
    ]);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.method).toBe("POST");
    expect(new URL(call.url).pathname).toBe("/v1/messages");
    expect(call.headers.get("x-api-key")).toBe("test-key");
    expect(call.headers.get("anthropic-version")).toBeTruthy();
    expect(call.body.model).toBe("test-model");
    expect(call.body.max_tokens).toBe(4096);
    expect(typeof call.body.system).toBe("string");
    const messages = call.body.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("--- 2026-01-01T00-00-00.json ---");
  });

  it("skips non-text blocks and throws when no text block is returned", async () => {
    const { client } = stubClient([{ type: "thinking", thinking: "...", signature: "sig" }]);
    await expect(extractBatch(client, "test-model", batch)).rejects.toThrow(
      "Model response contained no text block"
    );
  });
});
