// Truth regression: the scanner's data-source tag on the chart's entry line
// must read in the same plain English as the overlay panel's chip. A raw token
// such as "SIMULATOR" must never reach the drawn label, and a signal whose
// source was not reported must not read like an untagged live one.
import { describe, it, expect } from "vitest";
import { buildSignalOverlays, scannerDataSourceLabel } from "./useAiChartOverlays";

function sig(dataSource: string) {
  return {
    symbol: "EURUSD",
    timeframe: "H1",
    timeframeMatchesChart: true,
    side: "BUY" as const,
    bias: "Bullish",
    confidence: 0.7,
    confidenceScore: 70,
    statusBadge: "HOT_SETUP",
    dataSource,
    entry: 1.1,
    stopLoss: 1.09,
    takeProfit: 1.12,
    finalReadHeadline: null,
    freshUntilMs: Date.now() + 30_000,
  };
}

function entryLabel(dataSource: string): string {
  const out = buildSignalOverlays(sig(dataSource), "EURUSD");
  return out.find((o) => o.id === "sig-EURUSD-entry")!.label ?? "";
}

describe("buildSignalOverlays data-source tag", () => {
  const cases: Array<[string, string]> = [
    ["SIMULATOR", "Simulated data"],
    ["LIVE_DELAYED", "Scanned on delayed feed"],
    ["STALE_FEED", "Scanned on stale feed"],
    ["AWAITING_FEED", "No market data yet"],
    ["HISTORY_READY_AWAITING_LIVE_TICK", "History only, no live tick yet"],
  ];
  for (const [token, words] of cases) {
    it(`tags a ${token} signal in plain English, never the raw token`, () => {
      const label = entryLabel(token);
      expect(label).toBe(`Scanner H1 BUY ▲ Entry · ${words}`);
      expect(label).not.toContain(token);
    });
  }

  it("says the source was not reported instead of leaving the line untagged", () => {
    expect(entryLabel("")).toBe("Scanner H1 BUY ▲ Entry · Source not reported");
  });

  it("does not leak an unrecognised token", () => {
    const label = entryLabel("NEW_INTERNAL_FEED");
    expect(label).toBe("Scanner H1 BUY ▲ Entry · Unrecognised source");
    expect(label).not.toMatch(/live/i);
  });

  it("leaves a live-feed signal's line untagged, as before", () => {
    expect(entryLabel("LIVE_FEED")).toBe("Scanner H1 BUY ▲ Entry");
  });

  it("keeps the raw token in metadata for machines", () => {
    const out = buildSignalOverlays(sig("SIMULATOR"), "EURUSD");
    for (const o of out) expect((o.metadata as Record<string, unknown>).dataSource).toBe("SIMULATOR");
  });

  it("shares one mapping with the overlay panel's chip", () => {
    expect(scannerDataSourceLabel("SIMULATOR")).toBe("Simulated data");
    expect(scannerDataSourceLabel("LIVE_FEED")).toBe("Scanned on live feed");
    expect(scannerDataSourceLabel(null)).toBe("Source not reported");
    expect(scannerDataSourceLabel("X")).toBe("Unrecognised source");
  });
});
