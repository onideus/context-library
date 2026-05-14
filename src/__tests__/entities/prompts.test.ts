import { describe, it, expect } from "vitest";
import {
  EXTRACTION_PROMPT_TEMPLATE,
  buildExtractionPrompt,
  parseTriples,
} from "../../entities/prompts.js";

// ── EXTRACTION_PROMPT_TEMPLATE ────────────────────────────────────────────────

describe("EXTRACTION_PROMPT_TEMPLATE", () => {
  it("contains the {content} placeholder", () => {
    expect(EXTRACTION_PROMPT_TEMPLATE).toContain("{content}");
  });

  it("includes few-shot examples section", () => {
    expect(EXTRACTION_PROMPT_TEMPLATE).toContain("Examples:");
    expect(EXTRACTION_PROMPT_TEMPLATE).toContain("Input:");
    expect(EXTRACTION_PROMPT_TEMPLATE).toContain("Output:");
  });

  it("includes all three canonical few-shot examples", () => {
    expect(EXTRACTION_PROMPT_TEMPLATE).toContain("migrated_to");
    expect(EXTRACTION_PROMPT_TEMPLATE).toContain("blocked_by");
    expect(EXTRACTION_PROMPT_TEMPLATE).toContain("implemented_with");
  });

  it("instructs model to return only a JSON array", () => {
    expect(EXTRACTION_PROMPT_TEMPLATE).toContain("JSON array");
    expect(EXTRACTION_PROMPT_TEMPLATE).toContain("confidence");
  });
});

// ── buildExtractionPrompt ────────────────────────────────────────────────────

describe("buildExtractionPrompt()", () => {
  it("injects content into the template", () => {
    const prompt = buildExtractionPrompt("my-unique-content-XYZ");
    expect(prompt).toContain("my-unique-content-XYZ");
    expect(prompt).not.toContain("{content}");
  });

  it("truncates content to 16000 chars", () => {
    const longContent = "a".repeat(20000);
    const prompt = buildExtractionPrompt(longContent);
    // The content portion should be truncated; total prompt length will exceed 16000 due to template
    expect(prompt).not.toContain("a".repeat(16001));
  });

  it("preserves short content without truncation", () => {
    const short = "short content here";
    const prompt = buildExtractionPrompt(short);
    expect(prompt).toContain(short);
  });

  it("returns a non-empty string for empty content", () => {
    const prompt = buildExtractionPrompt("");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("Examples:");
  });
});

// ── parseTriples ─────────────────────────────────────────────────────────────

describe("parseTriples()", () => {
  it("parses a valid JSON array of triples", () => {
    const raw = JSON.stringify([
      { subject: "PostgreSQL", predicate: "used_by", object: "backend", confidence: 0.9 },
    ]);
    const triples = parseTriples(raw, 0.5);
    expect(triples).toHaveLength(1);
    expect(triples[0].subject).toBe("PostgreSQL");
    expect(triples[0].predicate).toBe("used_by");
    expect(triples[0].object).toBe("backend");
    expect(triples[0].confidence).toBe(0.9);
  });

  it("strips markdown code fences before parsing", () => {
    const fenced = "```json\n[{\"subject\":\"A\",\"predicate\":\"rel\",\"object\":\"B\",\"confidence\":0.8}]\n```";
    const triples = parseTriples(fenced, 0.5);
    expect(triples).toHaveLength(1);
    expect(triples[0].subject).toBe("A");
  });

  it("handles JSON array embedded in preamble text", () => {
    const preamble = 'Here are triples: [{"subject":"X","predicate":"uses","object":"Y","confidence":0.85}] done.';
    const triples = parseTriples(preamble, 0.5);
    expect(triples).toHaveLength(1);
    expect(triples[0].subject).toBe("X");
  });

  it("filters out triples below minConfidence", () => {
    const raw = JSON.stringify([
      { subject: "A", predicate: "rel", object: "B", confidence: 0.9 },
      { subject: "C", predicate: "rel", object: "D", confidence: 0.3 },
    ]);
    const triples = parseTriples(raw, 0.5);
    expect(triples).toHaveLength(1);
    expect(triples[0].subject).toBe("A");
  });

  it("clamps confidence to [0, 1]", () => {
    const raw = JSON.stringify([{ subject: "X", predicate: "rel", object: "Y", confidence: 1.5 }]);
    const triples = parseTriples(raw, 0);
    expect(triples[0].confidence).toBe(1);
  });

  it("skips triples with missing required fields", () => {
    const raw = JSON.stringify([
      { subject: "Good", predicate: "rel", object: "Target", confidence: 0.9 },
      { predicate: "rel", object: "Target", confidence: 0.9 },
      { subject: "X", object: "Y", confidence: 0.9 },
      { subject: "", predicate: "rel", object: "Z", confidence: 0.9 },
    ]);
    const triples = parseTriples(raw, 0.5);
    expect(triples).toHaveLength(1);
    expect(triples[0].subject).toBe("Good");
  });

  it("returns empty array for invalid JSON", () => {
    const triples = parseTriples("not json at all", 0.5);
    expect(triples).toEqual([]);
  });

  it("returns empty array when no JSON array found", () => {
    const triples = parseTriples('{"not": "an array"}', 0.5);
    expect(triples).toEqual([]);
  });

  it("trims whitespace from triple fields", () => {
    const raw = JSON.stringify([
      { subject: "  spaced  ", predicate: "  rel  ", object: "  val  ", confidence: 0.9 },
    ]);
    const triples = parseTriples(raw, 0.5);
    expect(triples[0].subject).toBe("spaced");
    expect(triples[0].predicate).toBe("rel");
    expect(triples[0].object).toBe("val");
  });

  it("handles confidence as a parseable string", () => {
    const raw = JSON.stringify([
      { subject: "A", predicate: "rel", object: "B", confidence: "0.75" },
    ]);
    const triples = parseTriples(raw, 0.5);
    expect(triples).toHaveLength(1);
    expect(triples[0].confidence).toBeCloseTo(0.75);
  });
});
