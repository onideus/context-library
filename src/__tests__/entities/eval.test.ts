import { describe, it, expect } from "vitest";
import { __testOnly } from "../../entities/eval.js";

const { precisionAtK, recallAtK, reciprocalRank, mean } = __testOnly;

describe("eval — retrieval metrics", () => {
  it("precisionAtK: half of top-k are relevant", () => {
    const retrieved = ["a", "b", "c", "d"];
    const relevant = new Set(["b", "d"]);
    expect(precisionAtK(retrieved, relevant, 4)).toBe(0.5);
  });

  it("precisionAtK: zero when no overlap", () => {
    expect(precisionAtK(["a", "b"], new Set(["x", "y"]), 2)).toBe(0);
  });

  it("precisionAtK: handles empty retrieval", () => {
    expect(precisionAtK([], new Set(["a"]), 5)).toBe(0);
  });

  it("recallAtK: fraction of relevant items retrieved within top-k", () => {
    const retrieved = ["a", "b", "c"];
    const relevant = new Set(["a", "b", "d", "e"]);
    expect(recallAtK(retrieved, relevant, 3)).toBe(0.5);
  });

  it("recallAtK: zero when ground truth is empty", () => {
    expect(recallAtK(["a"], new Set(), 5)).toBe(0);
  });

  it("reciprocalRank: 1 when first result is relevant", () => {
    expect(reciprocalRank(["a", "b"], new Set(["a"]))).toBe(1);
  });

  it("reciprocalRank: 1/3 when third result is relevant", () => {
    expect(reciprocalRank(["a", "b", "c"], new Set(["c"]))).toBeCloseTo(1 / 3, 6);
  });

  it("reciprocalRank: 0 when none are relevant", () => {
    expect(reciprocalRank(["a", "b", "c"], new Set(["d"]))).toBe(0);
  });

  it("mean: arithmetic mean of array", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  it("mean: 0 for empty input", () => {
    expect(mean([])).toBe(0);
  });
});
