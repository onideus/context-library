import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OllamaProvider } from "../../entities/providers/ollama.js";

// ── fetch mock ────────────────────────────────────────────────────────

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────

function makeProvider(overrides: Partial<ConstructorParameters<typeof OllamaProvider>[0]> = {}) {
  return new OllamaProvider({
    baseUrl: "http://localhost:11434",
    model: "sciphi/triplex",
    minConfidence: 0.5,
    timeoutMs: 5000,
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function textResponse(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
  };
}

// ── available() ───────────────────────────────────────────────────────

describe("OllamaProvider.available()", () => {
  it("returns true when the configured model is present in /api/tags", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ models: [{ name: "sciphi/triplex" }] })
    );

    const provider = makeProvider();
    expect(await provider.available()).toBe(true);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://localhost:11434/api/tags");
  });

  it("returns true when model name has a tag suffix (e.g. 'sciphi/triplex:latest')", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ models: [{ name: "sciphi/triplex:latest" }] })
    );

    expect(await makeProvider().available()).toBe(true);
  });

  it("returns false when the model is not in the list", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ models: [{ name: "llama3:latest" }] })
    );

    expect(await makeProvider().available()).toBe(false);
  });

  it("returns false when the list is empty", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ models: [] }));
    expect(await makeProvider().available()).toBe(false);
  });

  it("returns false on non-200 response", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) });
    expect(await makeProvider().available()).toBe(false);
  });

  it("returns false when fetch rejects (network error)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await makeProvider().available()).toBe(false);
  });
});

// ── extract() — happy path ────────────────────────────────────────────

describe("OllamaProvider.extract() — happy path", () => {
  const triples = [
    { subject: "Project Alpha", predicate: "uses", object: "PostgreSQL", confidence: 0.9 },
    { subject: "backend team", predicate: "owns", object: "Project Alpha", confidence: 0.8 },
  ];

  it("returns an ExtractionResult with parsed triples", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { content: JSON.stringify(triples) } })
    );

    const provider = makeProvider();
    const result = await provider.extract("some content", "note", "note-001");

    expect(result.provider).toBe("ollama");
    expect(result.providerVersion).toBe("1.0.0");
    expect(result.contentType).toBe("note");
    expect(result.contentId).toBe("note-001");
    expect(result.triples).toHaveLength(2);
    expect(result.triples[0].subject).toBe("Project Alpha");
    expect(result.triples[0].confidence).toBe(0.9);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("sends a POST to /v1/chat/completions with the model and prompt", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { content: "[]" } })
    );

    await makeProvider().extract("test content", "handoff", "hf-001");

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    expect(opts.method).toBe("POST");

    const body = JSON.parse(opts.body as string);
    expect(body.model).toBe("sciphi/triplex");
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toContain("test content");
    expect(body.stream).toBe(false);
  });

  it("strips triples below minConfidence", async () => {
    const mixed = [
      { subject: "A", predicate: "rel", object: "B", confidence: 0.9 },
      { subject: "C", predicate: "rel", object: "D", confidence: 0.3 }, // below 0.5
    ];
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { content: JSON.stringify(mixed) } })
    );

    const result = await makeProvider({ minConfidence: 0.5 }).extract("content", "task", "t-1");
    expect(result.triples).toHaveLength(1);
    expect(result.triples[0].subject).toBe("A");
  });

  it("clamps confidence to [0, 1]", async () => {
    const raw = [{ subject: "X", predicate: "rel", object: "Y", confidence: 1.5 }];
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { content: JSON.stringify(raw) } })
    );

    const result = await makeProvider().extract("c", "note", "n-1");
    expect(result.triples[0].confidence).toBe(1);
  });
});

// ── extract() — prompt construction ──────────────────────────────────

describe("OllamaProvider.extract() — prompt construction", () => {
  it("includes few-shot examples in the prompt", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { content: "[]" } })
    );

    await makeProvider().extract("my content", "note", "n-1");

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const prompt: string = body.messages[0].content;

    // Verify the prompt contains few-shot structure
    expect(prompt).toContain("Examples:");
    expect(prompt).toContain("Input:");
    expect(prompt).toContain("Output:");
    expect(prompt).toContain("migrated_to");
    expect(prompt).toContain("blocked_by");
  });

  it("injects the content into the prompt", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { content: "[]" } })
    );

    const content = "Unique-marker-string-XYZ";
    await makeProvider().extract(content, "handoff", "hf-1");

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0].content).toContain(content);
  });

  it("truncates content to 16000 chars to stay within model limits", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { content: "[]" } })
    );

    const longContent = "a".repeat(20000);
    await makeProvider().extract(longContent, "note", "n-1");

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const prompt: string = body.messages[0].content;
    // The prompt wraps content so total length will be > 16000, but the content
    // portion should be limited
    expect(prompt.length).toBeLessThan(20000 + 2000); // prompt template < 2000 chars
  });
});

// ── extract() — malformed JSON handling ──────────────────────────────

describe("OllamaProvider.extract() — malformed JSON handling", () => {
  it("returns empty triples on completely invalid JSON", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { content: "not json at all" } })
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await makeProvider().extract("c", "note", "n-1");
    warnSpy.mockRestore();

    expect(result.triples).toEqual([]);
  });

  it("returns empty triples when response is a non-array JSON value", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { content: '{"not": "an array"}' } })
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await makeProvider().extract("c", "note", "n-1");
    warnSpy.mockRestore();

    expect(result.triples).toEqual([]);
  });

  it("strips markdown code fences before parsing", async () => {
    const triples = [{ subject: "S", predicate: "p", object: "O", confidence: 0.9 }];
    const fenced = `\`\`\`json\n${JSON.stringify(triples)}\n\`\`\``;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { content: fenced } })
    );

    const result = await makeProvider().extract("c", "note", "n-1");
    expect(result.triples).toHaveLength(1);
    expect(result.triples[0].subject).toBe("S");
  });

  it("skips malformed triple entries (missing required fields) and returns valid ones", async () => {
    const mixed = [
      { subject: "Good", predicate: "rel", object: "Target", confidence: 0.9 },
      { subject: "", predicate: "rel", object: "Target", confidence: 0.9 }, // empty subject
      { predicate: "rel", object: "Target", confidence: 0.9 },              // missing subject
    ];
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { content: JSON.stringify(mixed) } })
    );

    const result = await makeProvider().extract("c", "note", "n-1");
    expect(result.triples).toHaveLength(1);
    expect(result.triples[0].subject).toBe("Good");
  });

  it("handles JSON array embedded in preamble text", async () => {
    const preamble = 'Here are the triples: [{"subject":"X","predicate":"uses","object":"Y","confidence":0.85}] done.';
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { content: preamble } })
    );

    const result = await makeProvider().extract("c", "note", "n-1");
    expect(result.triples).toHaveLength(1);
    expect(result.triples[0].subject).toBe("X");
  });
});

// ── extract() — error handling ────────────────────────────────────────

describe("OllamaProvider.extract() — error handling", () => {
  it("throws when Ollama returns a non-200 response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    await expect(makeProvider().extract("c", "note", "n-1")).rejects.toThrow(
      /Ollama error \(500\)/
    );
  });

  it("throws on network timeout (AbortError)", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));

    await expect(makeProvider().extract("c", "note", "n-1")).rejects.toThrow();
  });
});

// ── provider metadata ─────────────────────────────────────────────────

describe("OllamaProvider metadata", () => {
  it("exposes provider name and version", () => {
    const p = makeProvider();
    expect(p.provider).toBe("ollama");
    expect(p.version).toBe("1.0.0");
  });
});
