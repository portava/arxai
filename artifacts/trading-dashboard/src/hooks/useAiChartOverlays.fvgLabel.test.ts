// Truth regression: FVG overlays are computed on M5 bars but drawn on whatever
// timeframe the chart shows. Each drawn level must say its timeframe and age.
import { describe, it, expect } from "vitest";
import { buildFvgOverlays } from "./useAiChartOverlays";

const base = {
  direction: "BUY" as const,
  stage: "INSIDE_FVG",
  htfAligned: true,
  activeFvg: { high: 1.0916, low: 1.0856, midpoint: 1.0886, direction: "bullish" as const, isMitigated: false },
  canSignal: true,
  overlays: [
    { id: "fvg-zone", kind: "zone" as const, label: "FVG entry zone", color: "#0f0", priceMin: 1.0856, priceMax: 1.0916, style: "solid" as const },
    { id: "fvg-sl", kind: "line" as const, label: "FVG stop", color: "#f00", price: 1.085, style: "dashed" as const },
  ],
};

describe("buildFvgOverlays labels", () => {
  it("labels every level with the M5 timeframe and the read's as-of time", () => {
    const out = buildFvgOverlays({
      symbol: "EURUSD",
      fvgRead: { ...base, entryTimeframe: "M5", asOf: "2026-10-28T09:35:00.000Z" },
    });
    expect(out).toHaveLength(2);
    for (const o of out) {
      expect(o.label).toContain("M5 FVG read");
      expect(o.label).toContain("as of 09:35 UTC");
    }
  });

  it("still names the M5 timeframe when the server sent no as-of time", () => {
    const out = buildFvgOverlays({ symbol: "EURUSD", fvgRead: base });
    for (const o of out) expect(o.label).toContain("M5 FVG read");
  });

  it("draws nothing when the server says canSignal is false", () => {
    expect(buildFvgOverlays({ symbol: "EURUSD", fvgRead: { ...base, canSignal: false } })).toEqual([]);
  });
});
