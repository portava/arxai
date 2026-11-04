// Truth banners (2026-11-04): the cockpit's "why no signal" line is worded from
// the SAME shared scanner-truth data verdict the scanner badge and the chart
// strip render, so the two can never disagree on the same page.
import { describe, it, expect } from "vitest";
import { rubyWaitingReason } from "./CockpitCards";
import type { ScannerTruth } from "@/lib/scannerTruth";

function truthWith(verdict: ScannerTruth["strip"]["data"]["verdict"], detail: string): ScannerTruth {
  return { strip: { data: { verdict, detail } } } as unknown as ScannerTruth;
}

describe("rubyWaitingReason", () => {
  it("says the feed is live only when the shared data verdict is Live", () => {
    expect(rubyWaitingReason("EURUSD", truthWith("Live", "Live broker candles."))).toBe(
      "Candle feed live for EURUSD — waiting for a signal.",
    );
  });
  it("repeats the shared verdict and its detail for every other state", () => {
    expect(rubyWaitingReason("EURUSD", truthWith("Delayed", "Last candle is 7 minutes old."))).toBe(
      "EURUSD chart data: delayed — Last candle is 7 minutes old.",
    );
    expect(rubyWaitingReason("V75", truthWith("Historical only", ""))).toBe("V75 chart data: historical only.");
    expect(rubyWaitingReason("XAUUSD", truthWith("Market closed", "Reopens Sun 22:00 UTC"))).toBe(
      "XAUUSD chart data: market closed — Reopens Sun 22:00 UTC",
    );
  });
  it("never invents a verdict with no truth", () => {
    expect(rubyWaitingReason("EURUSD", null)).toBe("Waiting for fresh EURUSD chart data.");
  });
});
