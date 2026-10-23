import { describe, it, expect } from "vitest";
import { formatMarketClosedLabel } from "@/components/charts/marketFrozenFormat";

// ── Chart market-closed / frozen-quote label ────────────────────────────────
//
// Pure display helper extracted from the chart components so the closed-market
// label is locked by unit tests (mirrors scannerChartFormat.test.ts). The label
// is derived from the last tick's BROKER time and rendered in UTC; an unknown
// broker time must degrade honestly rather than fabricate a time.

describe("formatMarketClosedLabel", () => {
  it("formats a known broker time as 'Market closed — last quote <Wd HH:MM UTC>'", () => {
    // 2026-06-12 20:54 UTC is a Friday (the real frozen Friday-close case).
    const ms = Date.UTC(2026, 5, 12, 20, 54, 59, 120);
    expect(formatMarketClosedLabel(ms)).toBe("Market closed — last quote Fri 20:54 UTC");
  });

  it("zero-pads single-digit hours and minutes", () => {
    const ms = Date.UTC(2026, 5, 14, 5, 7, 0); // Sunday 05:07 UTC
    expect(formatMarketClosedLabel(ms)).toBe("Market closed — last quote Sun 05:07 UTC");
  });

  it("falls back to a bare label when the broker time is unknown (never fabricates)", () => {
    expect(formatMarketClosedLabel(null)).toBe("Market closed");
    expect(formatMarketClosedLabel(undefined)).toBe("Market closed");
    expect(formatMarketClosedLabel(Number.NaN)).toBe("Market closed");
  });
});
