import { describe, it, expect } from "vitest";
import {
  resolveLiveActionCapabilities,
  type LiveCapabilityInputs,
} from "./liveActionCapabilities";

/**
 * resolveLiveActionCapabilities — the single frontend source of the
 * open-vs-close live-risk rule. These tests lock two of the role/permission
 * audit's Class-5 frontend contracts at the logic layer:
 *
 *   (#4) A revoked live trader (canManualTrade === false) must NOT be able to
 *        OPEN or MODIFY live risk, but MUST keep the ability to CLOSE
 *        (reduce-only) their existing positions.
 *   (#5) When the kill switch is engaged (isFrozen === true), normal trading
 *        (open/modify) is blocked with honest messaging, while closing remains
 *        available so the trader can exit risk.
 *
 * The helper is display-only — it exposes capability + honest copy, never a
 * field that grants execution. The backend 18-gate pipeline stays the sole
 * authority; these assertions only pin what the UI may show.
 */

function caps(over: Partial<LiveCapabilityInputs> = {}) {
  return resolveLiveActionCapabilities({
    canManualTrade: true,
    isFrozen: false,
    bridgeBlocked: false,
    ...over,
  });
}

describe("resolveLiveActionCapabilities — approved trader", () => {
  it("an approved, unfrozen, connected trader may open, modify AND close", () => {
    const c = caps();
    expect(c.canOpen).toBe(true);
    expect(c.canModify).toBe(true);
    expect(c.canClose).toBe(true);
    expect(c.blockedReason).toBeNull();
    expect(c.blockedLabel).toBe("");
  });
});

describe("resolveLiveActionCapabilities — #4 revoked live trader", () => {
  it("blocks OPEN and MODIFY but still allows CLOSE", () => {
    const c = caps({ canManualTrade: false });
    expect(c.canOpen).toBe(false);
    expect(c.canModify).toBe(false);
    // The whole point of the rule: a revoked trader can still exit risk.
    expect(c.canClose).toBe(true);
  });

  it("surfaces an honest NOT_APPROVED reason + label (no raw token)", () => {
    const c = caps({ canManualTrade: false });
    expect(c.blockedReason).toBe("NOT_APPROVED");
    expect(c.blockedLabel).toBe("Waiting for approval");
  });

  it("canModify ALWAYS mirrors canOpen (modify can increase risk → same gate)", () => {
    for (const over of [
      { canManualTrade: false },
      { isFrozen: true },
      { bridgeBlocked: true },
      {},
    ] as Partial<LiveCapabilityInputs>[]) {
      const c = caps(over);
      expect(c.canModify).toBe(c.canOpen);
    }
  });
});

describe("resolveLiveActionCapabilities — #5 kill switch / frozen", () => {
  it("freeze blocks OPEN/MODIFY with honest 'Trading paused' copy, CLOSE survives", () => {
    const c = caps({ isFrozen: true });
    expect(c.canOpen).toBe(false);
    expect(c.canModify).toBe(false);
    expect(c.canClose).toBe(true);
    expect(c.blockedReason).toBe("FROZEN");
    expect(c.blockedLabel).toBe("Trading paused");
  });

  it("frozen takes precedence over a missing-approval cause", () => {
    // Even if approval were also absent, the kill switch is the honest headline.
    const c = caps({ canManualTrade: false, isFrozen: true });
    expect(c.blockedReason).toBe("FROZEN");
  });
});

describe("resolveLiveActionCapabilities — bridge disconnected", () => {
  it("a disconnected bridge blocks opening, keeps closing, reports BRIDGE_DISCONNECTED", () => {
    const c = caps({ bridgeBlocked: true });
    expect(c.canOpen).toBe(false);
    expect(c.canClose).toBe(true);
    expect(c.blockedReason).toBe("BRIDGE_DISCONNECTED");
    expect(c.blockedLabel).toBe("Bridge disconnected");
  });

  it("bridge disconnect outranks both freeze and missing-approval in the headline", () => {
    const c = caps({ canManualTrade: false, isFrozen: true, bridgeBlocked: true });
    expect(c.blockedReason).toBe("BRIDGE_DISCONNECTED");
  });
});

describe("resolveLiveActionCapabilities — invariants", () => {
  it("canClose is true for EVERY combination of inputs (reduce-risk is never hidden)", () => {
    for (const canManualTrade of [true, false]) {
      for (const isFrozen of [true, false]) {
        for (const bridgeBlocked of [true, false]) {
          expect(
            resolveLiveActionCapabilities({ canManualTrade, isFrozen, bridgeBlocked }).canClose,
          ).toBe(true);
        }
      }
    }
  });

  it("exposes only display/capability fields — never an execute/enabled flag", () => {
    expect(Object.keys(caps()).sort()).toEqual(
      ["blockedLabel", "blockedReason", "canClose", "canModify", "canOpen"].sort(),
    );
  });

  it("bridgeBlocked defaults to false when omitted (envelope-only callers)", () => {
    const c = resolveLiveActionCapabilities({ canManualTrade: true, isFrozen: false });
    expect(c.canOpen).toBe(true);
  });

  it("a blocked-open state ALWAYS carries a non-empty honest label", () => {
    for (const over of [
      { canManualTrade: false },
      { isFrozen: true },
      { bridgeBlocked: true },
    ] as Partial<LiveCapabilityInputs>[]) {
      const c = caps(over);
      expect(c.canOpen).toBe(false);
      expect(c.blockedLabel.length).toBeGreaterThan(0);
      expect(c.blockedReason).not.toBeNull();
    }
  });
});
