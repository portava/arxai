import { describe, it, expect } from "vitest";
import { formatMarketClosedLabel, frozenQuoteChip } from "@/components/charts/marketFrozenFormat";

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

// The server reports two different things: `marketFrozen` on the tick stream
// (the broker keeps repeating one quote — weekend, holiday, broker hours, or a
// stuck terminal) and a scheduled weekend close on the chart feed status. Only
// the schedule makes "Market closed" a statement; a frozen quote alone is
// described as what was observed.
describe("frozenQuoteChip", () => {
  const FRI_2054 = Date.UTC(2026, 5, 12, 20, 54, 59);

  it("says 'Market closed' only inside a scheduled close", () => {
    const chip = frozenQuoteChip(FRI_2054, true);
    expect(chip.label).toBe("Market closed — last quote Fri 20:54 UTC");
    expect(chip.title).toMatch(/scheduled weekend close/i);
    expect(chip.title).toMatch(/not updating/i);
  });

  it("describes a frozen quote outside a scheduled close as observed, not as a closed market", () => {
    const chip = frozenQuoteChip(FRI_2054, false);
    expect(chip.label).toBe("Quote not moving — last quote Fri 20:54 UTC");
    expect(chip.label).not.toMatch(/closed/i);
    expect(chip.title).toMatch(/same quote/i);
    expect(chip.title).toMatch(/not confirmed/i);
  });

  it("never fabricates a time when the broker time is unknown", () => {
    expect(frozenQuoteChip(null, true).label).toBe("Market closed");
    expect(frozenQuoteChip(Number.NaN, false).label).toBe("Quote not moving");
    expect(frozenQuoteChip(undefined, false).title).toMatch(/broker time was not reported/i);
  });
});
