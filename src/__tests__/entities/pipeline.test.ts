import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractAndStore, extractBatch } from "../../entities/pipeline.js";
import type { ExtractionResult } from "../../entities/types.js";

// ── Module mocks ──────────────────────────────────────────────────────

const createExtractionRunMock = vi.fn();
const completeExtractionRunMock = vi.fn();
const failExtractionRunMock = vi.fn();
const storeTripplesMock = vi.fn();

vi.mock("../../entities/store.js", () => ({
  createExtractionRun: (...args: unknown[]) => createExtractionRunMock(...args),
  completeExtractionRun: (...args: unknown[]) => completeExtractionRunMock(...args),
  failExtractionRun: (...args: unknown[]) => failExtractionRunMock(...args),
  storeTriples: (...args: unknown[]) => storeTripplesMock(...args),
}));

const getActiveProviderMock = vi.fn();

vi.mock("../../entities/registry.js", () => ({
  getActiveProvider: () => getActiveProviderMock(),
  getProvider: (name: string) => getActiveProviderMock(name),
}));

vi.mock("../../embeddings/indexer.js", () => ({
  extractHandoffText: (obj: Record<string, unknown>) => JSON.stringify(obj),
}));

vi.mock("../../db/client.js", () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
}));

// ── Config mock: enabled by default ──────────────────────────────────

vi.mock("../../config.js", () => ({
  config: {
    entityExtractionEnabled: true,
    entityExtractionProvider: "ollama",
    entityExtractionAsync: true,
    ollamaBaseUrl: "http://localhost:11434",
    ollamaExtractionModel: "sciphi/triplex",
    entityMinConfidence: 0.5,
    entityExtractionTimeoutMs: 30000,
    dataDir: "/tmp/test-data",
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────

function makeProvider(available = true, triples: ExtractionResult["triples"] = []) {
  return {
    provider: "ollama",
    version: "1.0.0",
    available: vi.fn().mockResolvedValue(available),
    extract: vi.fn().mockResolvedValue({
      triples,
      provider: "ollama",
      providerVersion: "1.0.0",
      contentType: "note" as const,
      contentId: "test-id",
      durationMs: 10,
    } satisfies ExtractionResult),
  };
}

beforeEach(() => {
  createExtractionRunMock.mockReset().mockResolvedValue("run-abc");
  completeExtractionRunMock.mockReset().mockResolvedValue(undefined);
  failExtractionRunMock.mockReset().mockResolvedValue(undefined);
  storeTripplesMock.mockReset().mockResolvedValue(2);
  getActiveProviderMock.mockReset();
});

// ── extractAndStore ───────────────────────────────────────────────────

describe("extractAndStore", () => {
  it("creates a run, calls extract, stores triples, and completes the run", async () => {
    const provider = makeProvider(true, [
      { subject: "A", predicate: "uses", object: "B", confidence: 0.9 },
    ]);
    getActiveProviderMock.mockReturnValue(provider);

    await extractAndStore("note", "note-001", "some content");

    expect(createExtractionRunMock).toHaveBeenCalledOnce();
    expect(provider.extract).toHaveBeenCalledWith("some content", "note", "note-001");
    expect(storeTripplesMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "ollama" }),
      "run-abc"
    );
    expect(completeExtractionRunMock).toHaveBeenCalledWith("run-abc", 2);
    expect(failExtractionRunMock).not.toHaveBeenCalled();
  });

  it("skips silently when no active provider is configured", async () => {
    getActiveProviderMock.mockReturnValue(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await extractAndStore("note", "n-1", "content");

    expect(createExtractionRunMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("skips gracefully when provider reports unavailable", async () => {
    const provider = makeProvider(false);
    getActiveProviderMock.mockReturnValue(provider);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await extractAndStore("handoff", "hf-1", "content");

    expect(provider.extract).not.toHaveBeenCalled();
    expect(createExtractionRunMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unavailable")
    );
    warnSpy.mockRestore();
  });

  it("marks the run as failed and logs when extract() throws", async () => {
    const provider = makeProvider(true);
    provider.extract.mockRejectedValue(new Error("model crashed"));
    getActiveProviderMock.mockReturnValue(provider);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await extractAndStore("note", "n-1", "content");

    expect(failExtractionRunMock).toHaveBeenCalledWith("run-abc", "model crashed");
    expect(completeExtractionRunMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("uses a caller-supplied runId when provided (no new run is created)", async () => {
    const provider = makeProvider(true, []);
    getActiveProviderMock.mockReturnValue(provider);

    await extractAndStore("task", "t-1", "content", "existing-run-id");

    expect(createExtractionRunMock).not.toHaveBeenCalled();
    expect(storeTripplesMock).toHaveBeenCalledWith(
      expect.any(Object),
      "existing-run-id"
    );
    // complete is not called when run was owned by caller
    expect(completeExtractionRunMock).not.toHaveBeenCalled();
  });

  it("resolves even if provider.available() rejects (availability check is best-effort)", async () => {
    const provider = makeProvider(true);
    provider.available.mockRejectedValue(new Error("network error"));
    getActiveProviderMock.mockReturnValue(provider);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Should not throw
    await expect(extractAndStore("note", "n-1", "content")).resolves.toBeUndefined();
    warnSpy.mockRestore();
  });

  it("does not block the caller (resolves without awaiting background work)", async () => {
    const provider = makeProvider(true, []);
    let extractResolve: () => void;
    provider.extract.mockReturnValue(
      new Promise<ExtractionResult>((resolve) => {
        extractResolve = () =>
          resolve({
            triples: [],
            provider: "ollama",
            providerVersion: "1.0.0",
            contentType: "note",
            contentId: "n-1",
            durationMs: 0,
          });
      })
    );
    getActiveProviderMock.mockReturnValue(provider);

    // When called fire-and-forget from tools, the caller doesn't await.
    // Verify extractAndStore itself resolves in the scenario where it is awaited
    // and the extract promise is pending (due to availability check completing fast).
    const pending = extractAndStore("note", "n-1", "content");
    extractResolve!();
    await pending; // should not hang
  });
});

// ── extractBatch ──────────────────────────────────────────────────────

describe("extractBatch", () => {
  it("processes items sequentially and completes the run", async () => {
    const extractOrder: string[] = [];
    const provider = makeProvider(true, [
      { subject: "S", predicate: "p", object: "O", confidence: 0.9 },
    ]);
    provider.extract.mockImplementation(async (_content: string, _type: string, id: string) => {
      extractOrder.push(id);
      return {
        triples: [{ subject: "S", predicate: "p", object: "O", confidence: 0.9 }],
        provider: "ollama",
        providerVersion: "1.0.0",
        contentType: "note" as const,
        contentId: id,
        durationMs: 1,
      };
    });
    getActiveProviderMock.mockReturnValue(provider);

    const items = [
      { id: "n-1", content: "content 1" },
      { id: "n-2", content: "content 2" },
      { id: "n-3", content: "content 3" },
    ];

    const result = await extractBatch("note", items);

    expect(result.processed).toBe(3);
    expect(result.runId).toBe("run-abc");
    // Verify sequential (not concurrent) by checking order
    expect(extractOrder).toEqual(["n-1", "n-2", "n-3"]);
    expect(completeExtractionRunMock).toHaveBeenCalledOnce();
  });

  it("continues after individual item failure (partial results)", async () => {
    const provider = makeProvider(true);
    provider.extract
      .mockRejectedValueOnce(new Error("item 1 failed"))
      .mockResolvedValueOnce({
        triples: [{ subject: "S", predicate: "p", object: "O", confidence: 0.9 }],
        provider: "ollama",
        providerVersion: "1.0.0",
        contentType: "note" as const,
        contentId: "n-2",
        durationMs: 1,
      });
    getActiveProviderMock.mockReturnValue(provider);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await extractBatch("note", [
      { id: "n-1", content: "bad content" },
      { id: "n-2", content: "good content" },
    ]);

    expect(result.processed).toBe(1);
    expect(completeExtractionRunMock).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("returns runId null and 0 processed when no provider is available", async () => {
    getActiveProviderMock.mockReturnValue(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await extractBatch("note", [{ id: "n-1", content: "c" }]);

    expect(result.runId).toBeNull();
    expect(result.processed).toBe(0);
    expect(createExtractionRunMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns runId null and 0 processed when provider is unavailable", async () => {
    const provider = makeProvider(false);
    getActiveProviderMock.mockReturnValue(provider);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await extractBatch("note", [{ id: "n-1", content: "c" }]);

    expect(result.runId).toBeNull();
    expect(result.processed).toBe(0);
    warnSpy.mockRestore();
  });
});
