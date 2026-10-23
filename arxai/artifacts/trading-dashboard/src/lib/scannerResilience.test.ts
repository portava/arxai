import { describe, it, expect } from "vitest";
import {
  SCANNER_DEGRADED_MESSAGE,
  RECENT_TRADES_DEGRADED_MESSAGE,
  OVERLAY_DEGRADED_TITLE,
  overlayBadgeLabel,
} from "./scannerResilience";

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
