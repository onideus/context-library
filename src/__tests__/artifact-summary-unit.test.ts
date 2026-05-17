import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeDynamicArtifactSummary } from "../tools/artifact-summary.js";

const queryMock = vi.fn();
vi.mock("../db/client.js", () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

beforeEach(() => {
  queryMock.mockReset();
});

describe("computeDynamicArtifactSummary degradation", () => {
  it("returns null (not an error) when the database query throws", async () => {
    queryMock.mockRejectedValue(new Error("connection refused"));
    const result = await computeDynamicArtifactSummary("2026-05-17T00:00:00Z");
    expect(result).toBeNull();
  });

  it("returns null when any of the parallel queries rejects", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("relation does not exist"));
    const result = await computeDynamicArtifactSummary();
    expect(result).toBeNull();
  });
});
