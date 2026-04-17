import { describe, it, expect } from "vitest";
import {
  validatePayloadSize,
  validateStringLength,
  PayloadTooLargeError,
  LIMITS,
} from "../tools/validation.js";

describe("validatePayloadSize", () => {
  it("passes for payloads under the limit", () => {
    expect(() => validatePayloadSize({ foo: "bar" }, 1000)).not.toThrow();
  });

  it("passes for payloads exactly at the limit", () => {
    // JSON.stringify of a string of length N adds 2 (quotes) = N+2
    const inner = "x".repeat(98); // stringified -> 100 chars
    expect(() => validatePayloadSize(inner, 100)).not.toThrow();
  });

  it("rejects payloads over the limit", () => {
    const tooBig = "x".repeat(200);
    expect(() => validatePayloadSize(tooBig, 100, "test_field")).toThrow(
      PayloadTooLargeError
    );
  });

  it("includes field name, actual and max in the error", () => {
    const tooBig = "x".repeat(200);
    try {
      validatePayloadSize(tooBig, 100, "store_handoff payload");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PayloadTooLargeError);
      const e = err as PayloadTooLargeError;
      expect(e.field).toBe("store_handoff payload");
      expect(e.actual).toBe(202); // "x".repeat(200) stringified = 202
      expect(e.max).toBe(100);
      expect(e.message).toContain("store_handoff payload");
      expect(e.message).toContain("202");
      expect(e.message).toContain("100");
    }
  });

  it("uses default label when none provided", () => {
    const tooBig = "x".repeat(200);
    try {
      validatePayloadSize(tooBig, 100);
      expect.fail("expected throw");
    } catch (err) {
      expect((err as PayloadTooLargeError).field).toBe("payload");
    }
  });
});

describe("validateStringLength", () => {
  it("passes for strings under the limit", () => {
    expect(() => validateStringLength("hello", 10, "title")).not.toThrow();
  });

  it("passes for strings exactly at the limit", () => {
    expect(() => validateStringLength("x".repeat(10), 10, "title")).not.toThrow();
  });

  it("rejects strings over the limit", () => {
    expect(() => validateStringLength("x".repeat(11), 10, "title")).toThrow(
      PayloadTooLargeError
    );
  });

  it("passes for undefined and null values", () => {
    expect(() => validateStringLength(undefined, 10, "title")).not.toThrow();
    expect(() => validateStringLength(null, 10, "title")).not.toThrow();
  });

  it("passes for empty string", () => {
    expect(() => validateStringLength("", 10, "title")).not.toThrow();
  });

  it("reports the correct field name and sizes", () => {
    try {
      validateStringLength("x".repeat(600), 500, "title");
      expect.fail("expected throw");
    } catch (err) {
      const e = err as PayloadTooLargeError;
      expect(e.field).toBe("title");
      expect(e.actual).toBe(600);
      expect(e.max).toBe(500);
    }
  });
});

describe("LIMITS", () => {
  it("exposes the documented size limits", () => {
    expect(LIMITS.STORE_HANDOFF_BYTES).toBe(100_000);
    expect(LIMITS.PATCH_HANDOFF_BYTES).toBe(100_000);
    expect(LIMITS.TASK_TITLE_CHARS).toBe(500);
    expect(LIMITS.TASK_CONTEXT_CHARS).toBe(20_000);
    expect(LIMITS.TASK_BLOCKED_REASON_CHARS).toBe(1000);
  });
});
