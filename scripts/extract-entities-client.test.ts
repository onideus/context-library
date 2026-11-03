import { describe, it, expect } from "vitest";
import Anthropic, { APIError, BadRequestError } from "@anthropic-ai/sdk";
import { extractBatch, buildUserMessage } from "./extract-entities.js";

/**
 * Contract test for extractBatch against the real @anthropic-ai/sdk client.
 *
 * The client is constructed with a stub `fetch`, so the test sees exactly what
 * the SDK puts on the wire for the script's one Messages call and exactly how
 * the script reads what comes back. An SDK upgrade that reshapes the request
 * or the response surfaces here instead of only on a live run.
 *
 * What this test cannot do is prove the API accepts the request; that is the
 * job of the live smoke test (extract-entities.live.test.ts), which is gated
 * behind EXTRACT_ENTITIES_LIVE=1 and a real key.
 */

// ── Pinned wire-level expectations ─────────────────────────────────
//
// These constants exist to force a human look at the next API-version or
// auth change. They detect change; they do not prove the server accepts the
// request. Source: @anthropic-ai/sdk 1.3.0, client.js:972 sets
// `anthropic-version: 2026-10-21`; client.js:438-458 send `apiKey` as
// `Authorization: Bearer <key>` and never as `x-api-key`. The 0.x line sent
// `anthropic-version: 2023-06-01` and the key under `x-api-key`, so on 0.x
// the header assertions below fail on purpose.
const EXPECTED_ANTHROPIC_VERSION = "2026-10-21";
const FAKE_API_KEY = "test-key-not-a-real-credential";
const EXPECTED_AUTHORIZATION = `Bearer ${FAKE_API_KEY}`;

// ── Stub transport ────────────────────────────────────────────────

interface Captured {
  url: URL;
  method: string | undefined;
  headers: Headers;
  body: Record<string, unknown>;
}

interface CannedReply {
  status: number;
  json: unknown;
}

function stubClient(reply: CannedReply): { client: Anthropic; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchStub = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({
      url: new URL(url),
      method: init?.method,
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(reply.json), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new Anthropic({
    apiKey: FAKE_API_KEY,
    // Explicit null so a developer's ANTHROPIC_AUTH_TOKEN can never leak into
    // the auth assertions; baseURL likewise overrides ANTHROPIC_BASE_URL.
    authToken: null,
    baseURL: "http://anthropic.test",
    maxRetries: 0,
    fetch: fetchStub,
  });
  return { client, calls };
}

function messageWith(content: unknown[]): unknown {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

function textReply(text: string): CannedReply {
  return { status: 200, json: messageWith([{ type: "text", text, citations: null }]) };
}

// Obviously fictional fixtures: this repository is public.
const BATCH = [
  {
    filename: "2026-01-05T09-00-00.json",
    body: { summary: "Jane Developer shipped project-alpha ingest for Acme Corp" },
  },
  {
    filename: "2026-01-06T09-00-00.json",
    body: { summary: "project-alpha deployed to staging-server" },
  },
];

const VALID_ROWS = [
  { canonical_name: "project-alpha", scope: "work", aliases: ["alpha"], constraints: [], confidence: 0.9 },
  { canonical_name: "Jane Developer", scope: "work", aliases: [], constraints: ["Colleague"], confidence: 0.8 },
];

// ── Request ───────────────────────────────────────────────────────

describe("extractBatch request", () => {
  it("POSTs /v1/messages with exactly the fields the script intends", async () => {
    const { client, calls } = stubClient(textReply(JSON.stringify(VALID_ROWS)));

    await extractBatch(client, "test-model", BATCH);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.method).toBe("POST");
    expect(call.url.pathname).toBe("/v1/messages");

    expect(Object.keys(call.body).sort()).toEqual(["max_tokens", "messages", "model", "system"]);
    expect(call.body.model).toBe("test-model");
    expect(call.body.max_tokens).toBe(4096);
    expect(typeof call.body.system).toBe("string");

    // Sampling parameters were removed from the Messages API in version
    // 2026-10-21; the script must not send them, even at defaults.
    expect(call.body).not.toHaveProperty("temperature");
    expect(call.body).not.toHaveProperty("top_p");
    expect(call.body).not.toHaveProperty("top_k");

    const messages = call.body.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("--- 2026-01-05T09-00-00.json ---");
    expect(messages[0].content).toContain("--- 2026-01-06T09-00-00.json ---");
    expect(messages[0].content).toBe(buildUserMessage(BATCH));
  });
});

// ── Headers (pinned) ──────────────────────────────────────────────

describe("extractBatch wire headers (pinned to the verified SDK line)", () => {
  it("sends the API version the script was verified against", async () => {
    const { client, calls } = stubClient(textReply("[]"));
    await extractBatch(client, "test-model", BATCH);
    expect(calls[0].headers.get("anthropic-version")).toBe(EXPECTED_ANTHROPIC_VERSION);
  });

  it("authenticates with a bearer Authorization header and never x-api-key", async () => {
    const { client, calls } = stubClient(textReply("[]"));
    await extractBatch(client, "test-model", BATCH);
    expect(calls[0].headers.get("authorization")).toBe(EXPECTED_AUTHORIZATION);
    expect(calls[0].headers.get("x-api-key")).toBeNull();
  });
});

// ── Response handling ─────────────────────────────────────────────

describe("extractBatch response handling", () => {
  it("parses a bare JSON array into validated entity seeds", async () => {
    const { client } = stubClient(textReply(JSON.stringify(VALID_ROWS)));
    const result = await extractBatch(client, "test-model", BATCH);
    expect(result).toEqual(VALID_ROWS);
  });

  it("parses an array the model wrapped in a ```json fence", async () => {
    const fenced = "```json\n" + JSON.stringify(VALID_ROWS, null, 2) + "\n```";
    const { client } = stubClient(textReply(fenced));
    const result = await extractBatch(client, "test-model", BATCH);
    expect(result).toEqual(VALID_ROWS);
  });

  it("filters rows with an invalid scope or a missing canonical_name", async () => {
    const rows = [
      ...VALID_ROWS,
      { canonical_name: "bogus", scope: "nowhere", aliases: [], constraints: [] },
      { scope: "work", aliases: ["nameless"], constraints: [] },
      "not an object",
      null,
    ];
    const { client } = stubClient(textReply(JSON.stringify(rows)));
    const result = await extractBatch(client, "test-model", BATCH);
    expect(result).toEqual(VALID_ROWS);
  });

  it("drops non-string aliases and constraints and a non-numeric confidence", async () => {
    const rows = [
      {
        canonical_name: "staging-server",
        scope: "shared",
        aliases: ["stage", 42, null, { nested: true }],
        constraints: ["Shared with other teams", false],
        confidence: "high",
      },
      { canonical_name: "Acme Corp", scope: "work", aliases: "not-an-array", constraints: null },
    ];
    const { client } = stubClient(textReply(JSON.stringify(rows)));
    const result = await extractBatch(client, "test-model", BATCH);
    expect(result).toEqual([
      { canonical_name: "staging-server", scope: "shared", aliases: ["stage"], constraints: ["Shared with other teams"] },
      { canonical_name: "Acme Corp", scope: "work", aliases: [], constraints: [] },
    ]);
  });

  it("throws when the response has no text block", async () => {
    const { client } = stubClient({
      status: 200,
      json: messageWith([{ type: "tool_use", id: "toolu_test", name: "noop", input: {} }]),
    });
    await expect(extractBatch(client, "test-model", BATCH)).rejects.toThrow(
      "Model response contained no text block"
    );
  });

  it("throws when the text block is JSON but not an array", async () => {
    const { client } = stubClient(textReply(JSON.stringify({ entities: VALID_ROWS })));
    await expect(extractBatch(client, "test-model", BATCH)).rejects.toThrow(
      "Model output was not a JSON array"
    );
  });
});

// ── Error path ────────────────────────────────────────────────────

describe("extractBatch error path", () => {
  it("surfaces an HTTP 400 as the SDK's BadRequestError", async () => {
    // This is what a removed or rejected request parameter looks like at
    // runtime: the API answers 400 and the SDK throws its typed error.
    const { client } = stubClient({
      status: 400,
      json: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "temperature: Extra inputs are not permitted",
        },
      },
    });

    let caught: unknown;
    try {
      await extractBatch(client, "test-model", BATCH);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BadRequestError);
    expect(caught).toBeInstanceOf(APIError);
    expect((caught as APIError).status).toBe(400);
  });
});
