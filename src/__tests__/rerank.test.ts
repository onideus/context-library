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
    delete process.env.RERANKER_TIMEOUT_MS;
    vi.restoreAllMocks();
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
  // ── Timeout configuration ─────────────────────────────

  it("uses RERANKER_TIMEOUT_MS for the abort signal", async () => {
    process.env.RERANKER_URL = "http://reranker:80";
    process.env.RERANKER_TIMEOUT_MS = "1500";
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ index: 0, score: 0.5 }],
    }) as unknown as typeof fetch;

    const { rerankResults } = await import("../embeddings/client.js");
    await rerankResults("q", ["a"]);
    expect(timeoutSpy).toHaveBeenCalledWith(1500);
  });

  it("defaults the abort signal to 3000ms when RERANKER_TIMEOUT_MS is unset", async () => {
    process.env.RERANKER_URL = "http://reranker:80";
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ index: 0, score: 0.5 }],
    }) as unknown as typeof fetch;

    const { rerankResults } = await import("../embeddings/client.js");
    await rerankResults("q", ["a"]);
    expect(timeoutSpy).toHaveBeenCalledWith(3000);
  });

  it.each(["abc", "0", "-50", ""])(
    "falls back to 3000ms when RERANKER_TIMEOUT_MS is invalid (%j)",
    async (raw) => {
      process.env.RERANKER_URL = "http://reranker:80";
      process.env.RERANKER_TIMEOUT_MS = raw;
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ index: 0, score: 0.5 }],
      }) as unknown as typeof fetch;

      const { rerankResults } = await import("../embeddings/client.js");
      await rerankResults("q", ["a"]);
      expect(timeoutSpy).toHaveBeenCalledWith(3000);
    }
  );

  // ── Failure logging ───────────────────────────────────
  // A configured reranker that silently never fires is indistinguishable
  // from one that was never set up. Every failure path must log.

  it("does not warn when the reranker is simply not configured", async () => {
    delete process.env.RERANKER_URL;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { rerankResults } = await import("../embeddings/client.js");
    await rerankResults("q", ["a", "b"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn on success", async () => {
    process.env.RERANKER_URL = "http://reranker:80";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ index: 0, score: 0.5 }],
    }) as unknown as typeof fetch;

    const { rerankResults } = await import("../embeddings/client.js");
    await rerankResults("q", ["a"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns with host, HTTP status, and elapsed time on a non-ok response", async () => {
    process.env.RERANKER_URL = "http://reranker.internal:8091";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 424,
      text: async () => "model is not a re-ranker model",
    }) as unknown as typeof fetch;

    const { rerankResults } = await import("../embeddings/client.js");
    await rerankResults("q", ["a", "b"]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toMatch(/^\[rerank\]/);
    expect(msg).toContain("reranker.internal:8091");
    expect(msg).toContain("HTTP 424");
    expect(msg).toMatch(/after \d+ms/);
    expect(msg).toContain("2 candidates");
  });

  it("warns with host, elapsed time, and the error name when fetch throws", async () => {
    process.env.RERANKER_URL = "http://reranker:8091";
    process.env.RERANKER_TIMEOUT_MS = "250";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";
    globalThis.fetch = vi.fn().mockRejectedValue(timeoutErr) as unknown as typeof fetch;

    const { rerankResults } = await import("../embeddings/client.js");
    await rerankResults("q", ["a", "b", "c"]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toContain("reranker:8091");
    expect(msg).toContain("TimeoutError");
    expect(msg).toContain("timeout 250ms");
    expect(msg).toContain("3 candidates");
    expect(msg).toMatch(/after \d+ms/);
  });

  it("warns when the response body is not an array", async () => {
    process.env.RERANKER_URL = "http://reranker:80";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ unexpected: "shape" }),
    }) as unknown as typeof fetch;

    const { rerankResults } = await import("../embeddings/client.js");
    await rerankResults("q", ["a"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("non-array");
  });

  it("warns when the array contains no usable {index, score} pairs", async () => {
    process.env.RERANKER_URL = "http://reranker:80";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ idx: 0, relevance: 0.5 }],
    }) as unknown as typeof fetch;

    const { rerankResults } = await import("../embeddings/client.js");
    const result = await rerankResults("q", ["a"]);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("no usable");
  });
});
