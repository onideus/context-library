import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Cross-encoder reranker client tests.
 *
 * The reranker URL is loaded from config at import time, so each test
 * sets process.env.RERANKER_URL + vi.resetModules() before re-importing
 * the client. Fetch is globally stubbed per-test.
 */

describe("rerankResults", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.RERANKER_URL;
  });

  it("returns null when reranker is not configured", async () => {
    delete process.env.RERANKER_URL;
    const { rerankResults } = await import("../embeddings/client.js");
    const result = await rerankResults("query", ["a", "b", "c"]);
    expect(result).toBeNull();
  });

  it("returns null when texts array is empty", async () => {
    process.env.RERANKER_URL = "http://reranker:80";
    const { rerankResults } = await import("../embeddings/client.js");
    const result = await rerankResults("query", []);
    expect(result).toBeNull();
  });

  it("returns scores sorted by score descending on success", async () => {
    process.env.RERANKER_URL = "http://reranker:80";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { index: 0, score: 0.2 },
        { index: 1, score: 0.9 },
        { index: 2, score: 0.5 },
      ],
    }) as unknown as typeof fetch;

    const { rerankResults } = await import("../embeddings/client.js");
    const result = await rerankResults("q", ["a", "b", "c"]);
    expect(result).not.toBeNull();
    expect(result!.map((r) => r.index)).toEqual([1, 2, 0]);
    expect(result![0].score).toBe(0.9);
  });

  it("returns null when the reranker responds non-ok (graceful degradation)", async () => {
    process.env.RERANKER_URL = "http://reranker:80";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "service unavailable",
    }) as unknown as typeof fetch;

    const { rerankResults } = await import("../embeddings/client.js");
    const result = await rerankResults("q", ["a", "b"]);
    expect(result).toBeNull();
  });

  it("returns null when fetch throws (timeout, connection refused, etc.)", async () => {
    process.env.RERANKER_URL = "http://reranker:80";
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("connection refused")) as unknown as typeof fetch;

    const { rerankResults } = await import("../embeddings/client.js");
    const result = await rerankResults("q", ["a", "b"]);
    expect(result).toBeNull();
  });

  it("returns null when response is malformed (not an array)", async () => {
    process.env.RERANKER_URL = "http://reranker:80";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ unexpected: "shape" }),
    }) as unknown as typeof fetch;

    const { rerankResults } = await import("../embeddings/client.js");
    const result = await rerankResults("q", ["a"]);
    expect(result).toBeNull();
  });

  it("posts { query, texts } as JSON to /rerank", async () => {
    process.env.RERANKER_URL = "http://reranker:80";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ index: 0, score: 0.5 }],
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { rerankResults } = await import("../embeddings/client.js");
    await rerankResults("the query", ["candidate text"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://reranker:80/rerank");
    expect(options.method).toBe("POST");
    const body = JSON.parse(options.body as string);
    expect(body.query).toBe("the query");
    expect(body.texts).toEqual(["candidate text"]);
  });
});
