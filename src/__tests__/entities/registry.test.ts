import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerProvider, getProvider, getActiveProvider, listProviders, clearRegistry } from "../../entities/registry.js";
import type { EntityExtractor, ExtractionResult } from "../../entities/types.js";

// ── Config mock ───────────────────────────────────────────────────────

vi.mock("../../config.js", () => ({
  config: {
    entityExtractionProvider: "mock-provider",
    entityExtractionEnabled: true,
    entityExtractionAsync: true,
    ollamaBaseUrl: "http://localhost:11434",
    ollamaExtractionModel: "sciphi/triplex",
    entityMinConfidence: 0.5,
    entityExtractionTimeoutMs: 30000,
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────

function makeMockExtractor(name: string, available = true): EntityExtractor {
  return {
    provider: name,
    version: "1.0.0",
    available: vi.fn().mockResolvedValue(available),
    extract: vi.fn().mockResolvedValue({
      triples: [],
      provider: name,
      providerVersion: "1.0.0",
      contentType: "note" as const,
      contentId: "test-id",
      durationMs: 0,
    } satisfies ExtractionResult),
  };
}

beforeEach(() => {
  clearRegistry();
});

// ── registerProvider / getProvider ───────────────────────────────────

describe("registerProvider / getProvider", () => {
  it("registers and retrieves a provider by name", () => {
    const extractor = makeMockExtractor("test-reg-a");
    registerProvider(extractor);
    expect(getProvider("test-reg-a")).toBe(extractor);
  });

  it("returns undefined for an unregistered provider name", () => {
    expect(getProvider("not-registered-xyz")).toBeUndefined();
  });

  it("overwrites a previously registered provider with the same name", () => {
    const first = makeMockExtractor("overwrite-me");
    const second = makeMockExtractor("overwrite-me");
    registerProvider(first);
    registerProvider(second);
    expect(getProvider("overwrite-me")).toBe(second);
  });
});

// ── getActiveProvider ─────────────────────────────────────────────────

describe("getActiveProvider", () => {
  it("returns the provider matching the config entityExtractionProvider", () => {
    const extractor = makeMockExtractor("mock-provider");
    registerProvider(extractor);
    expect(getActiveProvider()).toBe(extractor);
  });

  it("returns undefined if the active provider name is not registered", () => {
    // Registry was cleared by beforeEach — no provider is registered yet.
    expect(getActiveProvider()).toBeUndefined();
  });
});

// ── listProviders ─────────────────────────────────────────────────────

describe("listProviders", () => {
  it("lists all registered providers with availability status", async () => {
    const avail = makeMockExtractor("list-test-avail", true);
    const unavail = makeMockExtractor("list-test-unavail", false);
    registerProvider(avail);
    registerProvider(unavail);

    const list = await listProviders();

    const availEntry = list.find((p) => p.name === "list-test-avail");
    const unavailEntry = list.find((p) => p.name === "list-test-unavail");

    expect(availEntry).toBeDefined();
    expect(availEntry!.available).toBe(true);
    expect(availEntry!.version).toBe("1.0.0");

    expect(unavailEntry).toBeDefined();
    expect(unavailEntry!.available).toBe(false);
  });

  it("returns available: false if the provider's available() rejects", async () => {
    const broken = {
      ...makeMockExtractor("broken-avail"),
      available: vi.fn().mockRejectedValue(new Error("kaboom")),
    };
    registerProvider(broken);

    const list = await listProviders();
    const entry = list.find((p) => p.name === "broken-avail");
    expect(entry).toBeDefined();
    expect(entry!.available).toBe(false);
  });

  it("returns an array (may include other registered providers from other tests)", async () => {
    const list = await listProviders();
    expect(Array.isArray(list)).toBe(true);
    for (const entry of list) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.version).toBe("string");
      expect(typeof entry.available).toBe("boolean");
    }
  });
});
