import { describe, it, expect } from "vitest";
import { mergeEntities } from "./merge-entities.js";

// ── mergeEntities: idempotent merge logic ─────────────────────────

describe("mergeEntities", () => {
  it("adds new entities to an empty existing list", () => {
    const fresh = [
      { canonical_name: "MyProject", scope: "work" as const, aliases: ["proj"], constraints: ["Confidential"] },
      { canonical_name: "team-lead", scope: "work" as const, aliases: [], constraints: [] },
    ];
    const { merged, added, updated, aliasesAdded } = mergeEntities([], fresh);
    expect(added).toBe(2);
    expect(updated).toBe(0);
    expect(aliasesAdded).toBe(0);
    expect(merged.map((e) => e.canonical_name)).toEqual(["MyProject", "team-lead"]);
    expect(merged[0].constraints).toEqual(["Confidential"]);
  });

  it("is idempotent: merging the same fresh set twice yields the same output", () => {
    const fresh = [
      { canonical_name: "MyProject", scope: "work" as const, aliases: ["proj"], constraints: ["Confidential"] },
      { canonical_name: "staging-server", scope: "shared" as const, aliases: ["stage"], constraints: [] },
    ];
    const first = mergeEntities([], fresh).merged;
    const second = mergeEntities(first, fresh);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.aliasesAdded).toBe(0);
    expect(second.merged).toEqual(first);
  });

  it("preserves human-edited constraints on existing entities", () => {
    const existing = [
      {
        canonical_name: "MyProject",
        scope: "work" as const,
        aliases: ["proj"],
        constraints: ["Human-added: confidential until launch"],
      },
    ];
    const fresh = [
      {
        canonical_name: "MyProject",
        scope: "work" as const,
        aliases: ["proj"],
        constraints: ["LLM-suggested constraint that should NOT replace the human edit"],
      },
    ];
    const { merged } = mergeEntities(existing, fresh);
    expect(merged).toHaveLength(1);
    expect(merged[0].constraints).toEqual(["Human-added: confidential until launch"]);
  });

  it("union-merges aliases case-insensitively, preserving existing casing", () => {
    const existing = [
      { canonical_name: "MyProject", scope: "work" as const, aliases: ["Proj"], constraints: [] },
    ];
    const fresh = [
      {
        canonical_name: "MyProject",
        scope: "work" as const,
        aliases: ["proj", "MP", "my-project"],
        constraints: [],
      },
    ];
    const { merged, added, updated, aliasesAdded } = mergeEntities(existing, fresh);
    expect(added).toBe(0);
    expect(updated).toBe(1);
    expect(aliasesAdded).toBe(2); // "proj" dedupes against "Proj"; MP + my-project add
    expect(merged[0].aliases).toEqual(["Proj", "MP", "my-project"]);
  });

  it("never deletes existing entries that do not appear in fresh", () => {
    const existing = [
      { canonical_name: "LegacyEntity", scope: "personal" as const, aliases: [], constraints: ["Do not delete"] },
    ];
    const fresh = [
      { canonical_name: "MyProject", scope: "work" as const, aliases: [], constraints: [] },
    ];
    const { merged } = mergeEntities(existing, fresh);
    expect(merged).toHaveLength(2);
    expect(merged.find((e) => e.canonical_name === "LegacyEntity")).toBeDefined();
  });

  it("treats canonical_name matching as case-insensitive and preserves existing casing", () => {
    const existing = [
      { canonical_name: "MyProject", scope: "work" as const, aliases: ["proj"], constraints: [] },
    ];
    const fresh = [
      { canonical_name: "myproject", scope: "work" as const, aliases: ["MP"], constraints: [] },
    ];
    const { merged, added, aliasesAdded } = mergeEntities(existing, fresh);
    expect(added).toBe(0);
    expect(aliasesAdded).toBe(1);
    expect(merged[0].canonical_name).toBe("MyProject");
    expect(merged[0].aliases).toContain("MP");
  });
});
