import { describe, it, expect } from "vitest";
import { computeSessionContinuity } from "../tools/handoff.js";

/**
 * Unit tests for computeSessionContinuity's elapsed-time gate.
 *
 * The spec calls for cold_start only when the previous session was closed
 * AND a significant amount of time has elapsed. These tests exercise the
 * gate directly without spinning up the server.
 */
describe("computeSessionContinuity", () => {
  it("returns 'unknown' when stored_at is missing", () => {
    expect(computeSessionContinuity({})).toBe("unknown");
  });

  it("returns 'resume' for an open session regardless of elapsed time", () => {
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(
      computeSessionContinuity({ stored_at: longAgo, session_closed: false })
    ).toBe("resume");
    expect(computeSessionContinuity({ stored_at: longAgo })).toBe("resume");
  });

  it("returns 'resume' for a closed session reopened within the threshold", () => {
    // 1 minute ago — well under the 15-minute threshold.
    const justClosed = new Date(Date.now() - 60 * 1000).toISOString();
    expect(
      computeSessionContinuity({
        stored_at: justClosed,
        session_closed: true,
      })
    ).toBe("resume");
  });

  it("returns 'cold_start' for a closed session past the threshold", () => {
    // 30 minutes ago — beyond the 15-minute threshold.
    const longClosed = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    expect(
      computeSessionContinuity({
        stored_at: longClosed,
        session_closed: true,
      })
    ).toBe("cold_start");
  });

  it("returns 'unknown' when stored_at is unparseable", () => {
    expect(
      computeSessionContinuity({
        stored_at: "not-a-timestamp",
        session_closed: true,
      })
    ).toBe("unknown");
  });
});
