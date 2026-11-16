import { describe, it, expect } from "vitest";
import {
  SCANNER_DEGRADED_MESSAGE,
  RECENT_TRADES_DEGRADED_MESSAGE,
  OVERLAY_DEGRADED_TITLE,
  overlayBadgeLabel,
  overlayPartialTitle,
  unavailableOverlayChecks,
} from "./scannerResilience";
import { buildOverlayHandshake } from "@workspace/domain/smart-chart";

// Tokens that must NEVER reach a user-facing degraded string. These are the raw
// failure leaks the whole resilience task exists to prevent.
const FORBIDDEN = [
  "SyntaxError",
  "Unexpected end of JSON input",
  "Unexpected token",
  "[object Object]",
  "undefined",
  "NaN",
];

describe("scanner degraded copy is honest (no raw failure leaks)", () => {
  for (const msg of [
    SCANNER_DEGRADED_MESSAGE,
    RECENT_TRADES_DEGRADED_MESSAGE,
    OVERLAY_DEGRADED_TITLE,
  ]) {
    it(`"${msg}" leaks no raw failure token`, () => {
      for (const token of FORBIDDEN) {
        expect(msg).not.toContain(token);
      }
      // Never a bare "HTTP <status>" code.
      expect(/HTTP\s*\d/i.test(msg)).toBe(false);
      expect(msg.length).toBeGreaterThan(0);
    });
  }
});

describe("overlayBadgeLabel — defers away from 'verified' when degraded", () => {
  it("shows 'verified' only on a healthy PASS handshake", () => {
    expect(overlayBadgeLabel("PASS", false)).toBe("verified");
  });

  it("NEVER shows 'verified' while the smart-layer feed is degraded", () => {
    expect(overlayBadgeLabel("PASS", true)).toBe("unavailable");
    expect(overlayBadgeLabel("WARN", true)).toBe("unavailable");
    expect(overlayBadgeLabel("BLOCK", true)).toBe("unavailable");
  });

  it("maps WARN/BLOCK to honest non-verified labels when healthy", () => {
    expect(overlayBadgeLabel("WARN", false)).toBe("check");
    expect(overlayBadgeLabel("BLOCK", false)).toBe("not ready");
  });

  it("NEVER shows 'verified' on a PASS handshake while the price feed is not live", () => {
    // A structurally-passing handshake drawn on historical-only / delayed / stale
    // candles must read as feed-limited, not live-verified.
    expect(overlayBadgeLabel("PASS", false, false)).toBe("limited");
    // The live-feed case (explicit and defaulted) still verifies.
    expect(overlayBadgeLabel("PASS", false, true)).toBe("verified");
    expect(overlayBadgeLabel("PASS", false)).toBe("verified");
    // A degraded feed still wins over the live-price flag.
    expect(overlayBadgeLabel("PASS", true, true)).toBe("unavailable");
    // The non-live flag does not alter WARN/BLOCK wording.
    expect(overlayBadgeLabel("WARN", false, false)).toBe("check");
    expect(overlayBadgeLabel("BLOCK", false, false)).toBe("not ready");
  });

  it("treats a missing handshake as unavailable, an unknown status as unknown", () => {
    expect(overlayBadgeLabel(null, false)).toBe("unavailable");
    expect(overlayBadgeLabel("SOMETHING_ELSE", false)).toBe("unknown");
  });
});

// Owner screenshot 2026-10-27 (V75 1m synthetic, calendar not configured): the
// chart badge read "Overlays: verified" beside an "Economic events" layer chip
// although the handshake never checked news mapping (NOT_AVAILABLE) — the domain
// roll-up ignores NOT_AVAILABLE, so the overall status was still PASS.
describe("overlayBadgeLabel — a PASS with unchecked items is only 'partially checked'", () => {
  it("precedence: degraded > not-live > partially checked > verified", () => {
    expect(overlayBadgeLabel("PASS", false, true, true)).toBe("partially checked");
    expect(overlayBadgeLabel("PASS", false, true, false)).toBe("verified");
    expect(overlayBadgeLabel("PASS", true, true, true)).toBe("unavailable");
    expect(overlayBadgeLabel("PASS", false, false, true)).toBe("limited");
    expect(overlayBadgeLabel("WARN", false, true, true)).toBe("check");
  });

  const base = {
    chartLoaded: true,
    chartSymbol: "V75",
    signalSymbol: "V75",
    signalExists: true,
    hasSufficientData: true,
    levelCount: 3,
  };

  it("screenshot state: news not mapped → PASS roll-up, one NOT_AVAILABLE check, badge not 'verified'", () => {
    const h = buildOverlayHandshake({ ...base, newsMapped: false, overlayAgeMs: 1000 });
    expect(h.overallStatus).toBe("PASS");
    const unchecked = unavailableOverlayChecks(h.checks);
    expect(unchecked.map((c) => c.key)).toEqual(["newsMapped"]);
    const label = overlayBadgeLabel(h.overallStatus, false, true, unchecked.length > 0);
    expect(label).toBe("partially checked");
    expect(label).not.toBe("verified");
    const title = overlayPartialTitle(unchecked);
    expect(title).toContain("News mapping is not available right now.");
    expect(title).not.toContain("safe to use");
  });

  it("news not mapped AND overlay age unknown → two NOT_AVAILABLE checks", () => {
    const h = buildOverlayHandshake({ ...base, newsMapped: false, overlayAgeMs: null });
    expect(h.overallStatus).toBe("PASS");
    const unchecked = unavailableOverlayChecks(h.checks);
    expect(unchecked.map((c) => c.key).sort()).toEqual(["freshness", "newsMapped"]);
    expect(overlayPartialTitle(unchecked)).toContain("Overlay age is unknown.");
  });

  it("every check run and passing → 'verified' (no over-downgrade)", () => {
    const h = buildOverlayHandshake({ ...base, newsMapped: true, overlayAgeMs: 1000 });
    expect(unavailableOverlayChecks(h.checks)).toHaveLength(0);
    expect(overlayBadgeLabel(h.overallStatus, false, true, false)).toBe("verified");
  });
});
