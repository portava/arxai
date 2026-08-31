// An absent number must render as "—", never as a confident zero.
// formatPnl(null) used to return "$0.00" (and formatPrice/"0.00",
// formatPercent/"0.00%") — which turned a failed account read into a
// fully-populated all-zero real-money card.

import { describe, it, expect } from "vitest";
import { formatPnl, formatPrice, formatPercent } from "./format";

describe("format helpers — null is unknown, not zero", () => {
  it("formatPnl renders '—' for null/undefined, real values otherwise", () => {
    expect(formatPnl(null)).toBe("—");
    expect(formatPnl(undefined)).toBe("—");
    expect(formatPnl(12.5)).toBe("+$12.50");
    expect(formatPnl(-3)).toBe("$-3.00");
    expect(formatPnl(0)).toBe("$0.00"); // a REAL zero still renders as $0.00
  });

  it("formatPrice renders '—' for null/undefined", () => {
    expect(formatPrice(null)).toBe("—");
    expect(formatPrice(undefined)).toBe("—");
    expect(formatPrice(1.2345)).toBe("1.23");
  });

  it("formatPercent renders '—' for null/undefined", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(undefined)).toBe("—");
    expect(formatPercent(42.1)).toBe("42.10%");
  });
});
