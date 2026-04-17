import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeEnvelope,
  emptyEnvelope,
  generateBoundaryNotice,
  lookupEntities,
  matchesWordBoundary,
  type EntityInfo,
} from "../tools/entities.js";

// Mock the DB client to avoid real Postgres for unit tests.
const queryMock = vi.fn();
vi.mock("../db/client.js", () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

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

// ── matchesWordBoundary (v0.6) ────────────────────────────────────

describe("matchesWordBoundary", () => {
  it("does NOT match an entity name inside a larger word", () => {
    // Classic false positive: short name "Ian" appearing inside unrelated words
    expect(matchesWordBoundary("Kubernetes deployment failed", "Ian")).toBe(false);
    expect(matchesWordBoundary("The median latency was 200ms", "Ian")).toBe(false);
    // Two-letter alias inside another token
    expect(matchesWordBoundary("SCBRS alert fired", "CB")).toBe(false);
    expect(matchesWordBoundary("subcategory check", "CB")).toBe(false);
  });

  it("DOES match an entity name as a standalone word", () => {
    expect(matchesWordBoundary("Ian is available today", "Ian")).toBe(true);
    expect(matchesWordBoundary("talked to Ian about this", "Ian")).toBe(true);
    expect(matchesWordBoundary("CB deployment is ready", "CB")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(matchesWordBoundary("talked to IAN today", "ian")).toBe(true);
    expect(matchesWordBoundary("Project ALPHA review", "project alpha")).toBe(true);
  });

  it("handles hyphenated names on word boundaries", () => {
    expect(matchesWordBoundary("working on project-alpha today", "project-alpha")).toBe(true);
    // "alpha" should not match the tail of "project-alpha" because
    // the hyphen is not a word character — it IS a boundary.
    expect(matchesWordBoundary("working on project-alpha today", "alpha")).toBe(true);
  });

  it("escapes regex metacharacters in domain-style names", () => {
    // Generic domain-style example (no personal data).
    expect(matchesWordBoundary("please ssh into box.example.com for logs", "box.example.com")).toBe(true);
    // The dots must be literal — "boxXexampleXcom" should NOT match "box.example.com"
    expect(matchesWordBoundary("boxXexampleXcom is a fake", "box.example.com")).toBe(false);
  });

  it("handles names with regex metacharacters without throwing", () => {
    // Exotic keys that would blow up a naive new RegExp(name). The precise
    // match behavior for keys surrounded by regex metacharacters is
    // undefined — we only guarantee that escaping keeps us safe from
    // crashes and from "C++" being interpreted as "Ccc".
    expect(() => matchesWordBoundary("some text", "a+b")).not.toThrow();
    expect(() => matchesWordBoundary("some text", "$weird^")).not.toThrow();
    // A plain "a+b" key should NOT match "aaab" (the plus must be literal).
    expect(matchesWordBoundary("aaab in text", "a+b")).toBe(false);
  });
});

// ── lookupEntities: word-boundary behavior (v0.6) ─────────────────

describe("lookupEntities — word boundary matching", () => {
  const queryMock2 = vi.fn();
  // The mock for "../db/client.js" is defined at the top of the file;
  // we reuse `queryMock` — re-bind it here for local clarity.
  beforeEach(() => {
    queryMock2.mockReset();
  });

  it("does not match when entity name appears only as a substring inside another word", async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.startsWith("SELECT")) {
        return Promise.resolve({
          rows: [
            {
              canonical_name: "Ian",
              scope: "personal",
              aliases: [],
              constraints: [],
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    // "Ian" is a substring of "Kubernetes" (letters i-a-n in sequence? no —
    // but it IS a substring of "median" and "guardian"). Ensure no match.
    const matched = await lookupEntities(["Investigating Kubernetes and guardian RBAC"]);
    expect(matched).toEqual([]);
  });

  it("matches when entity name appears as a standalone word", async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.startsWith("SELECT")) {
        return Promise.resolve({
          rows: [
            {
              canonical_name: "Ian",
              scope: "personal",
              aliases: [],
              constraints: [],
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const matched = await lookupEntities(["talked to Ian about the release"]);
    expect(matched.map((e) => e.canonical_name)).toEqual(["Ian"]);
  });

  it("skips single-character aliases (too ambiguous)", async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.startsWith("SELECT")) {
        return Promise.resolve({
          rows: [
            {
              canonical_name: "Project A",
              scope: "work",
              aliases: ["A"],
              constraints: [],
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    // A single letter "A" appears all over normal English — ensure we don't
    // false-positive on it. The canonical_name "Project A" should still
    // work if it appears as a phrase, but a bare "A" alias should not.
    const matched = await lookupEntities(["A quick test of the system"]);
    expect(matched).toEqual([]);
  });
});

// ── lookupEntities: last_referenced bookkeeping ───────────────────

describe("lookupEntities — last_referenced update", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("issues a batched UPDATE on entities.last_referenced when matches are found", async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.startsWith("SELECT")) {
        return Promise.resolve({
          rows: [
            {
              canonical_name: "Project Alpha",
              scope: "work",
              aliases: ["alpha"],
              constraints: [],
            },
            {
              canonical_name: "Home Server",
              scope: "personal",
              aliases: ["NAS"],
              constraints: [],
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const matched = await lookupEntities(["Working on Project Alpha today"]);
    expect(matched.map((e) => e.canonical_name)).toEqual(["Project Alpha"]);

    const updateCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE entities")
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![0]).toContain("last_referenced = NOW()");
    expect(updateCall![0]).toContain("canonical_name = ANY($1)");
    expect(updateCall![1]).toEqual([["Project Alpha"]]);
  });

  it("does not issue an UPDATE when no entities match", async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.startsWith("SELECT")) {
        return Promise.resolve({
          rows: [
            {
              canonical_name: "Project Alpha",
              scope: "work",
              aliases: ["alpha"],
              constraints: [],
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const matched = await lookupEntities(["Totally unrelated text about cats"]);
    expect(matched).toEqual([]);

    const updateCall = queryMock.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("UPDATE entities")
    );
    expect(updateCall).toBeUndefined();
  });

  it("swallows UPDATE failures (bookkeeping must not break search)", async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.startsWith("SELECT")) {
        return Promise.resolve({
          rows: [
            {
              canonical_name: "Project Alpha",
              scope: "work",
              aliases: [],
              constraints: [],
            },
          ],
        });
      }
      // UPDATE fails
      return Promise.reject(new Error("db offline"));
    });

    const matched = await lookupEntities(["Project Alpha notes"]);
    expect(matched.map((e) => e.canonical_name)).toEqual(["Project Alpha"]);
  });
});
