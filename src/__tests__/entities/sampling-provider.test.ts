import { describe, it, expect, vi, beforeEach } from "vitest";
import { SamplingProvider } from "../../entities/providers/sampling.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

// ── Mock server factory ──────────────────────────────────────────────────────

function makeServer(overrides: Partial<{
  caps: Record<string, unknown> | undefined | null;
  createMessageResult: Record<string, unknown>;
  createMessageError: Error;
}> = {}): Server {
  const defaultResult = {
    role: "assistant",
    model: "claude-opus-4-5",
    content: { type: "text", text: "[]" },
    stopReason: "end_turn",
  };

  // Use "caps" in overrides to detect explicit undefined vs. omitted key
  const capsValue = "caps" in overrides ? overrides.caps : { sampling: {} };

  return {
    getClientCapabilities: vi.fn().mockReturnValue(capsValue),
    createMessage: overrides.createMessageError
      ? vi.fn().mockRejectedValue(overrides.createMessageError)
      : vi.fn().mockResolvedValue(overrides.createMessageResult ?? defaultResult),
  } as unknown as Server;
}

function makeProvider(server: Server, opts = {}) {
  return new SamplingProvider(server, { minConfidence: 0.5, ...opts });
}

// ── available() ──────────────────────────────────────────────────────────────

describe("SamplingProvider.available()", () => {
  it("returns true when client capabilities include sampling", async () => {
    const server = makeServer({ caps: { sampling: { createMessage: {} } } });
    expect(await makeProvider(server).available()).toBe(true);
  });

  it("returns false when client capabilities are undefined", async () => {
    const server = makeServer({ caps: undefined });
    expect(await makeProvider(server).available()).toBe(false);
  });

  it("returns false when sampling capability is absent", async () => {
    const server = makeServer({ caps: { roots: {} } });
    expect(await makeProvider(server).available()).toBe(false);
  });

  it("returns false when capabilities object is empty", async () => {
    const server = makeServer({ caps: {} });
    expect(await makeProvider(server).available()).toBe(false);
  });
});

// ── extract() — happy path ────────────────────────────────────────────────────

describe("SamplingProvider.extract() — happy path", () => {
  it("returns an ExtractionResult with parsed triples", async () => {
    const triples = [
      { subject: "auth service", predicate: "depends_on", object: "postgres", confidence: 0.9 },
    ];
    const server = makeServer({
      createMessageResult: {
        role: "assistant",
        model: "claude-opus-4-5",
        content: { type: "text", text: JSON.stringify(triples) },
        stopReason: "end_turn",
      },
    });

    const provider = makeProvider(server);
    const result = await provider.extract("some content", "note", "note-001");

    expect(result.provider).toBe("mcp-sampling");
    expect(result.providerVersion).toBe("claude-opus-4-5");
    expect(result.contentType).toBe("note");
    expect(result.contentId).toBe("note-001");
    expect(result.triples).toHaveLength(1);
    expect(result.triples[0].subject).toBe("auth service");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports model from sampling response as providerVersion", async () => {
    const server = makeServer({
      createMessageResult: {
        role: "assistant",
        model: "custom-model-v2",
        content: { type: "text", text: "[]" },
        stopReason: "end_turn",
      },
    });
    const result = await makeProvider(server).extract("content", "handoff", "hf-1");
    expect(result.providerVersion).toBe("custom-model-v2");
  });

  it("falls back to 'unknown' when model is absent from response", async () => {
    const server = makeServer({
      createMessageResult: {
        role: "assistant",
        content: { type: "text", text: "[]" },
        stopReason: "end_turn",
      },
    });
    const result = await makeProvider(server).extract("content", "note", "n-1");
    expect(result.providerVersion).toBe("unknown");
  });

  it("calls createMessage with the extraction prompt containing content", async () => {
    const server = makeServer();
    const createMessage = server.createMessage as ReturnType<typeof vi.fn>;

    await makeProvider(server).extract("unique-test-content-ABC", "note", "n-1");

    expect(createMessage).toHaveBeenCalledOnce();
    const [params] = createMessage.mock.calls[0] as [{ messages: Array<{ content: { text: string } }> }];
    expect(params.messages[0].content.text).toContain("unique-test-content-ABC");
    expect(params.messages[0].content.text).toContain("Examples:");
  });

  it("returns empty triples when response content is not text type", async () => {
    const server = makeServer({
      createMessageResult: {
        role: "assistant",
        model: "m",
        content: { type: "image", data: "base64...", mimeType: "image/png" },
        stopReason: "end_turn",
      },
    });
    const result = await makeProvider(server).extract("content", "note", "n-1");
    expect(result.triples).toEqual([]);
  });
});

// ── extract() — filtering ─────────────────────────────────────────────────────

describe("SamplingProvider.extract() — confidence filtering", () => {
  it("filters out triples below minConfidence", async () => {
    const triples = [
      { subject: "A", predicate: "rel", object: "B", confidence: 0.9 },
      { subject: "C", predicate: "rel", object: "D", confidence: 0.2 },
    ];
    const server = makeServer({
      createMessageResult: {
        role: "assistant",
        model: "m",
        content: { type: "text", text: JSON.stringify(triples) },
        stopReason: "end_turn",
      },
    });
    const result = await makeProvider(server, { minConfidence: 0.5 }).extract("c", "note", "n-1");
    expect(result.triples).toHaveLength(1);
    expect(result.triples[0].subject).toBe("A");
  });
});

// ── extract() — error propagation ────────────────────────────────────────────

describe("SamplingProvider.extract() — error handling", () => {
  it("throws when createMessage rejects", async () => {
    const server = makeServer({ createMessageError: new Error("Client sampling failed") });
    await expect(makeProvider(server).extract("c", "note", "n-1")).rejects.toThrow("Client sampling failed");
  });
});

// ── provider metadata ─────────────────────────────────────────────────────────

describe("SamplingProvider metadata", () => {
  it("exposes provider name 'mcp-sampling' and static version", () => {
    const server = makeServer();
    const p = makeProvider(server);
    expect(p.provider).toBe("mcp-sampling");
    expect(p.version).toBe("1.0.0");
  });
});
