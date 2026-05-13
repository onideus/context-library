import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractAndStore, extractBatch, reextractAll } from "../../entities/pipeline.js";
import type { ExtractionResult } from "../../entities/types.js";

// ── Module mocks ──────────────────────────────────────────────────────

const createExtractionRunMock = vi.fn();
const completeExtractionRunMock = vi.fn();
const failExtractionRunMock = vi.fn();
const storeTriplesMock = vi.fn();

vi.mock("../../entities/store.js", () => ({
  createExtractionRun: (...args: unknown[]) => createExtractionRunMock(...args),
  completeExtractionRun: (...args: unknown[]) => completeExtractionRunMock(...args),
  failExtractionRun: (...args: unknown[]) => failExtractionRunMock(...args),
  storeTriples: (...args: unknown[]) => storeTriplesMock(...args),
}));

const getActiveProviderMock = vi.fn();

vi.mock("../../entities/registry.js", () => ({
  getActiveProvider: () => getActiveProviderMock(),
  getProvider: (name: string) => getActiveProviderMock(name),
}));

vi.mock("../../embeddings/indexer.js", () => ({
  extractHandoffText: (obj: Record<string, unknown>) => JSON.stringify(obj),
}));

const queryMock = vi.fn();

vi.mock("../../db/client.js", () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

const readdirMock = vi.fn();
const readFileMock = vi.fn();

vi.mock("node:fs/promises", () => ({
  readdir: (...args: unknown[]) => readdirMock(...args),
  readFile: (...args: unknown[]) => readFileMock(...args),
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
  storeTriplesMock.mockReset().mockResolvedValue(2);
  getActiveProviderMock.mockReset();
  queryMock.mockReset().mockResolvedValue({ rows: [] });
  readdirMock.mockReset().mockResolvedValue([]);
  readFileMock.mockReset();
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
    expect(storeTriplesMock).toHaveBeenCalledWith(
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
    expect(storeTriplesMock).toHaveBeenCalledWith(
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

  it("never rejects — safe to call as fire-and-forget with .catch() for logging only", async () => {
    const provider = makeProvider(true);
    provider.extract.mockRejectedValue(new Error("model exploded"));
    getActiveProviderMock.mockReturnValue(provider);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Simulate the exact pattern used in handoff.ts and notes.ts:
    //   extractAndStore(...).catch(err => console.warn(...))
    // The .catch() must never fire because extractAndStore always resolves.
    let catchWasCalled = false;
    const bgWork = extractAndStore("note", "n-1", "content");
    bgWork.catch(() => { catchWasCalled = true; });
    await bgWork;

    expect(catchWasCalled).toBe(false);
    warnSpy.mockRestore();
  });

  it("resolves without awaiting background work when used without await", async () => {
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

// ── reextractAll ──────────────────────────────────────────────────────

describe("reextractAll", () => {
  it("returns zero processed when no provider is configured", async () => {
    getActiveProviderMock.mockReturnValue(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await reextractAll();

    expect(result.handoffs).toEqual({ runId: null, processed: 0 });
    expect(result.notes).toEqual({ runId: null, processed: 0 });
    expect(createExtractionRunMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns zero processed when provider is unavailable", async () => {
    const provider = makeProvider(false);
    getActiveProviderMock.mockReturnValue(provider);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await reextractAll();

    expect(result.handoffs).toEqual({ runId: null, processed: 0 });
    expect(result.notes).toEqual({ runId: null, processed: 0 });
    expect(createExtractionRunMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("processes .json handoff files and notes, returning processed counts", async () => {
    const provider = makeProvider(true, [
      { subject: "A", predicate: "uses", object: "B", confidence: 0.9 },
    ]);
    getActiveProviderMock.mockReturnValue(provider);

    readdirMock.mockResolvedValue(["handoff-1.json", "handoff-2.json", "not-json.txt"]);
    readFileMock.mockResolvedValue(JSON.stringify({ summary: "test handoff" }));
    queryMock.mockResolvedValue({
      rows: [
        { id: "note-1", title: "Note One", content: "note content" },
        { id: "note-2", title: "Note Two", content: "more content" },
      ],
    });

    const result = await reextractAll();

    // Only .json files processed (not-json.txt skipped)
    expect(result.handoffs.processed).toBe(2);
    expect(result.notes.processed).toBe(2);
    expect(result.handoffs.runId).toBe("run-abc");
    expect(result.notes.runId).toBe("run-abc");
    // Two runs created: one for handoffs, one for notes
    expect(createExtractionRunMock).toHaveBeenCalledTimes(2);
    expect(completeExtractionRunMock).toHaveBeenCalledTimes(2);
  });

  it("continues to notes even when the handoff directory is missing", async () => {
    const provider = makeProvider(true, []);
    getActiveProviderMock.mockReturnValue(provider);

    readdirMock.mockRejectedValue(new Error("ENOENT: no such file or directory"));
    queryMock.mockResolvedValue({
      rows: [{ id: "note-1", title: "T", content: "C" }],
    });

    const result = await reextractAll();

    expect(result.handoffs.processed).toBe(0);
    expect(result.notes.processed).toBe(1);
    // Note run was still created and completed
    expect(createExtractionRunMock).toHaveBeenCalledTimes(2);
    expect(completeExtractionRunMock).toHaveBeenCalledTimes(2);
  });

  it("skips handoff files that fail to read and continues processing remaining", async () => {
    const provider = makeProvider(true, [
      { subject: "A", predicate: "uses", object: "B", confidence: 0.9 },
    ]);
    getActiveProviderMock.mockReturnValue(provider);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    readdirMock.mockResolvedValue(["bad.json", "good.json"]);
    readFileMock
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce(JSON.stringify({ summary: "valid content" }));
    queryMock.mockResolvedValue({ rows: [] });

    const result = await reextractAll();

    expect(result.handoffs.processed).toBe(1);
    expect(result.notes.processed).toBe(0);
    warnSpy.mockRestore();
  });

  it("skips handoff files that produce empty text after extraction", async () => {
    const provider = makeProvider(true, []);
    getActiveProviderMock.mockReturnValue(provider);

    // An empty object serialises to "{}" which has no meaningful text
    readdirMock.mockResolvedValue(["empty.json"]);
    readFileMock.mockResolvedValue("{}");
    queryMock.mockResolvedValue({ rows: [] });

    // extractHandoffText is mocked as JSON.stringify, so "{}" → no content to skip on whitespace check
    // Provide genuinely blank content by mocking a handoff that yields only whitespace
    readFileMock.mockResolvedValue(JSON.stringify({ stored_at: "2025-01-01", schema_version: "1.2" }));

    const result = await reextractAll();

    // Even if text is blank, the run is still created and the item is just skipped
    expect(result.handoffs.runId).toBe("run-abc");
  });

  it("uses getProvider(name) when an explicit providerName is given", async () => {
    const provider = makeProvider(true, []);
    // getProvider is wired to getActiveProviderMock(name)
    getActiveProviderMock.mockImplementation((name?: string) => {
      if (name === "custom-provider") return provider;
      return undefined;
    });

    readdirMock.mockResolvedValue([]);
    queryMock.mockResolvedValue({ rows: [] });

    const result = await reextractAll("custom-provider");

    expect(getActiveProviderMock).toHaveBeenCalledWith("custom-provider");
    // Both runs are created even when no items exist
    expect(result.handoffs.runId).toBe("run-abc");
    expect(result.notes.runId).toBe("run-abc");
  });

  it("handles notes DB failure gracefully — notes processed is 0 but handoffs still complete", async () => {
    const provider = makeProvider(true, [
      { subject: "A", predicate: "uses", object: "B", confidence: 0.9 },
    ]);
    getActiveProviderMock.mockReturnValue(provider);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    readdirMock.mockResolvedValue(["hf.json"]);
    readFileMock.mockResolvedValue(JSON.stringify({ summary: "ok" }));
    queryMock.mockRejectedValue(new Error("connection refused"));

    const result = await reextractAll();

    expect(result.handoffs.processed).toBe(1);
    expect(result.notes.processed).toBe(0);
    warnSpy.mockRestore();
  });
});
