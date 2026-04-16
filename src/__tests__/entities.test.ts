import { describe, it, expect } from "vitest";
import {
  computeEnvelope,
  emptyEnvelope,
  generateBoundaryNotice,
  type EntityInfo,
} from "../tools/entities.js";

// ── Test fixtures (generic names only — no personal data) ─────────

const workLaptop: EntityInfo = {
  canonical_name: "Work Laptop",
  scope: "work",
  aliases: ["company laptop", "dev machine"],
  constraints: ["Company-owned device", "No unapproved software"],
};

const homeServer: EntityInfo = {
  canonical_name: "Home Server",
  scope: "personal",
  aliases: ["NAS", "media server"],
  constraints: [],
};

const devDesktop: EntityInfo = {
  canonical_name: "Dev Desktop",
  scope: "shared",
  aliases: ["workstation"],
  constraints: ["Shared device — check scope before recommending changes"],
};

const projectAlpha: EntityInfo = {
  canonical_name: "Project Alpha",
  scope: "work",
  aliases: ["alpha"],
  constraints: ["Confidential — do not reference in personal contexts"],
};

// ── emptyEnvelope ─────────────────────────────────────────────────

describe("emptyEnvelope", () => {
  it("returns default empty structure", () => {
    const env = emptyEnvelope();
    expect(env.scope_flags).toEqual([]);
    expect(env.boundary_detected).toBe(false);
    expect(env.constraint_alerts).toEqual([]);
    expect(env.entity_map).toEqual({});
    expect(env.active_constraints).toEqual([]);
  });
});

// ── computeEnvelope ───────────────────────────────────────────────

describe("computeEnvelope", () => {
  it("returns empty envelope when no entities match", () => {
    const env = computeEnvelope([]);
    expect(env).toEqual(emptyEnvelope());
  });

  it("sets correct scope for work-only entities", () => {
    const env = computeEnvelope([workLaptop]);
    expect(env.scope_flags).toEqual(["work"]);
    expect(env.boundary_detected).toBe(false);
    expect(env.entity_map["Work Laptop"]).toBeDefined();
    expect(env.constraint_alerts).toContain("Work Laptop: Company-owned device");
    expect(env.constraint_alerts).toContain("Work Laptop: No unapproved software");
    expect(env.active_constraints).toHaveLength(2);
  });

  it("sets correct scope for personal-only entities", () => {
    const env = computeEnvelope([homeServer]);
    expect(env.scope_flags).toEqual(["personal"]);
    expect(env.boundary_detected).toBe(false);
    expect(env.constraint_alerts).toEqual([]);
    expect(env.active_constraints).toEqual([]);
  });

  it("detects boundary when results span work and personal scopes", () => {
    const env = computeEnvelope([workLaptop, homeServer]);
    expect(env.scope_flags).toContain("work");
    expect(env.scope_flags).toContain("personal");
    expect(env.boundary_detected).toBe(true);
  });

  it("detects boundary with shared + work scopes", () => {
    const env = computeEnvelope([workLaptop, devDesktop]);
    expect(env.scope_flags).toContain("work");
    expect(env.scope_flags).toContain("shared");
    expect(env.boundary_detected).toBe(true);
  });

  it("does not false-positive on multiple entities in same scope", () => {
    const env = computeEnvelope([workLaptop, projectAlpha]);
    expect(env.scope_flags).toEqual(["work"]);
    expect(env.boundary_detected).toBe(false);
    expect(env.entity_map["Work Laptop"]).toBeDefined();
    expect(env.entity_map["Project Alpha"]).toBeDefined();
  });

  it("collects all constraints from multiple entities", () => {
    const env = computeEnvelope([workLaptop, projectAlpha]);
    expect(env.active_constraints).toHaveLength(3);
    expect(env.constraint_alerts).toHaveLength(3);
  });

  it("scope_flags are sorted alphabetically", () => {
    const env = computeEnvelope([homeServer, workLaptop, devDesktop]);
    expect(env.scope_flags).toEqual(["personal", "shared", "work"]);
  });
});

// ── generateBoundaryNotice ────────────────────────────────────────

describe("generateBoundaryNotice", () => {
  it("returns null when no boundary detected", () => {
    const env = computeEnvelope([workLaptop]);
    expect(generateBoundaryNotice(env)).toBeNull();
  });

  it("returns null for empty envelope", () => {
    expect(generateBoundaryNotice(emptyEnvelope())).toBeNull();
  });

  it("generates notice when boundary is detected", () => {
    const env = computeEnvelope([workLaptop, homeServer]);
    const notice = generateBoundaryNotice(env);
    expect(notice).not.toBeNull();
    expect(notice).toContain("BOUNDARY NOTICE");
    expect(notice).toContain("personal");
    expect(notice).toContain("work");
    expect(notice).toContain("DO NOT blend recommendations across scopes");
  });

  it("includes constraints grouped by scope", () => {
    const env = computeEnvelope([workLaptop, homeServer]);
    const notice = generateBoundaryNotice(env)!;
    expect(notice).toContain("work scope");
    expect(notice).toContain("Company-owned device");
  });

  it("handles scopes with no constraints gracefully", () => {
    // homeServer has no constraints, should not crash or show empty constraint line
    const env = computeEnvelope([workLaptop, homeServer]);
    const notice = generateBoundaryNotice(env)!;
    // personal scope has no constraints — should not appear as "Constraints from personal scope:"
    expect(notice).not.toContain("Constraints from personal scope:");
  });
});
