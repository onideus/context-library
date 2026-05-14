import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiProvider } from "../../entities/providers/api.js";

// ── fetch mock ────────────────────────────────────────────────────────────────

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function anthropicProvider(overrides: Partial<ConstructorParameters<typeof ApiProvider>[0]> = {}) {
  return new ApiProvider({
    apiKey: "test-key",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-20250514",
    apiFormat: "anthropic",
    minConfidence: 0.5,
    timeoutMs: 5000,
    ...overrides,
  });
}

function openaiProvider(overrides: Partial<ConstructorParameters<typeof ApiProvider>[0]> = {}) {
  return new ApiProvider({
    apiKey: "test-key",
    baseUrl: "https://api.openai.com",
    model: "gpt-4o",
    apiFormat: "openai",
    minConfidence: 0.5,
    timeoutMs: 5000,
    ...overrides,
  });
}

function mockOk(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function anthropicResponse(text: string, model = "claude-sonnet-4-20250514") {
  return { content: [{ type: "text", text }], model };
}

function openaiResponse(text: string, model = "gpt-4o") {
  return { choices: [{ message: { content: text } }], model };
}

// ── available() ───────────────────────────────────────────────────────────────

describe("ApiProvider.available()", () => {
  it("returns true when apiKey is provided", async () => {
    expect(await anthropicProvider().available()).toBe(true);
  });

  it("returns false when apiKey is empty string", async () => {
    expect(await anthropicProvider({ apiKey: "" }).available()).toBe(false);
  });
});

// ── extract() — Anthropic format ──────────────────────────────────────────────

describe("ApiProvider.extract() — Anthropic format", () => {
  const triples = [
    { subject: "service", predicate: "uses", object: "postgres", confidence: 0.9 },
    { subject: "team", predicate: "owns", object: "service", confidence: 0.8 },
  ];

  it("returns an ExtractionResult with parsed triples", async () => {
    fetchMock.mockResolvedValueOnce(mockOk(anthropicResponse(JSON.stringify(triples))));

    const result = await anthropicProvider().extract("content", "note", "n-001");

    expect(result.provider).toBe("api");
    expect(result.providerVersion).toBe("claude-sonnet-4-20250514");
    expect(result.contentType).toBe("note");
    expect(result.contentId).toBe("n-001");
    expect(result.triples).toHaveLength(2);
    expect(result.triples[0].subject).toBe("service");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("sends POST to /v1/messages with x-api-key header", async () => {
    fetchMock.mockResolvedValueOnce(mockOk(anthropicResponse("[]")));

    await anthropicProvider({ apiKey: "my-key" }).extract("test", "handoff", "hf-1");

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(opts.method).toBe("POST");
    expect((opts.headers as Record<string, string>)["x-api-key"]).toBe("my-key");
    expect((opts.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
  });

  it("includes extraction prompt with content in request body", async () => {
    fetchMock.mockResolvedValueOnce(mockOk(anthropicResponse("[]")));

    await anthropicProvider().extract("my-unique-content", "note", "n-1");

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toContain("my-unique-content");
    expect(body.messages[0].content).toContain("Examples:");
  });

  it("filters triples below minConfidence", async () => {
    const mixed = [
      { subject: "A", predicate: "rel", object: "B", confidence: 0.9 },
      { subject: "C", predicate: "rel", object: "D", confidence: 0.2 },
    ];
    fetchMock.mockResolvedValueOnce(mockOk(anthropicResponse(JSON.stringify(mixed))));

    const result = await anthropicProvider({ minConfidence: 0.5 }).extract("c", "note", "n-1");
    expect(result.triples).toHaveLength(1);
    expect(result.triples[0].subject).toBe("A");
  });

  it("throws on non-200 Anthropic response", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: () => Promise.resolve("Unauthorized") });
    await expect(anthropicProvider().extract("c", "note", "n-1")).rejects.toThrow(/API error \(401\)/);
  });

  it("handles response with no text content block gracefully", async () => {
    fetchMock.mockResolvedValueOnce(mockOk({ content: [{ type: "image" }], model: "m" }));
    const result = await anthropicProvider().extract("c", "note", "n-1");
    expect(result.triples).toEqual([]);
  });
});

// ── extract() — OpenAI format ─────────────────────────────────────────────────

describe("ApiProvider.extract() — OpenAI format", () => {
  const triples = [
    { subject: "pipeline", predicate: "blocked_by", object: "TEI server", confidence: 0.85 },
  ];

  it("returns an ExtractionResult with parsed triples", async () => {
    fetchMock.mockResolvedValueOnce(mockOk(openaiResponse(JSON.stringify(triples))));

    const result = await openaiProvider().extract("content", "handoff", "hf-001");

    expect(result.provider).toBe("api");
    expect(result.providerVersion).toBe("gpt-4o");
    expect(result.triples).toHaveLength(1);
    expect(result.triples[0].predicate).toBe("blocked_by");
  });

  it("sends POST to /v1/chat/completions with Bearer token", async () => {
    fetchMock.mockResolvedValueOnce(mockOk(openaiResponse("[]")));

    await openaiProvider({ apiKey: "sk-test" }).extract("test", "note", "n-1");

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");
  });

  it("throws on non-200 OpenAI response", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, text: () => Promise.resolve("Rate limited") });
    await expect(openaiProvider().extract("c", "note", "n-1")).rejects.toThrow(/API error \(429\)/);
  });

  it("returns empty triples when choices array is empty", async () => {
    fetchMock.mockResolvedValueOnce(mockOk({ choices: [], model: "gpt-4o" }));
    const result = await openaiProvider().extract("c", "note", "n-1");
    expect(result.triples).toEqual([]);
  });
});

// ── extract() — both formats handle network errors ────────────────────────────

describe("ApiProvider.extract() — network errors", () => {
  it("throws on network failure (Anthropic format)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(anthropicProvider().extract("c", "note", "n-1")).rejects.toThrow();
  });

  it("throws on network failure (OpenAI format)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(openaiProvider().extract("c", "note", "n-1")).rejects.toThrow();
  });
});

// ── provider metadata ─────────────────────────────────────────────────────────

describe("ApiProvider metadata", () => {
  it("exposes provider name 'api' and version", () => {
    const p = anthropicProvider();
    expect(p.provider).toBe("api");
    expect(p.version).toBe("1.0.0");
  });
});
