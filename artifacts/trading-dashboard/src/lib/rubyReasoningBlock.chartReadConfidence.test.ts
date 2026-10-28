// Owner screenshot 2026-10-27 (V75 1m, Deriv public data), Eleanor's chart-read
// reasoning: Momentum "Read confidence Low." The chart read's Low/Medium/High is
// a STRUCTURE scale (bias × timeframe agreement × momentum strength), not a
// momentum fact, and it shared the page with the market-edge card's "Trade
// quality 42/100". The Momentum row now carries the server's measured momentum
// sentence; the structure confidence is named as its own scale on the
// Structure row.

import { describe, it, expect } from "vitest";
import { buildReasoningFromChartRead } from "@/lib/rubyReasoningBlock";
import type { ChartRead } from "@/lib/rubyReadPanelState";

const MOMENTUM =
  "Momentum cooling: the last 5 bars moved +0.4× the average bar range (14-bar); price is trading up near resistance.";

function ownerRead(over: Partial<ChartRead> = {}): ChartRead {
  return {
    bias: "Mixed",
    confidence: "Low",
    why: "On this timeframe the trend structure leans up, with momentum cooling; price is trading up near resistance.",
    supportZone: "33250.6 – 33273.2",
    resistanceZone: "33639.4 – 33662.0",
    riskNote: "Edge is weak.",
    cautions: [],
    gated: false,
    dataQuality: "ok",
    momentumNote: MOMENTUM,
    ...over,
  } as ChartRead;
}

describe("chart-read reasoning — structure confidence is not a momentum fact", () => {
  it("owner state: Momentum row is the measured momentum, never 'Read confidence'", () => {
    const block = buildReasoningFromChartRead({ read: ownerRead(), symbol: "V75", timeframe: "1m" });
    expect(block.evidence.momentum).toBe(MOMENTUM);
    expect(block.evidence.momentum).not.toMatch(/confidence/i);
  });

  it("the structure confidence is named with its scale on the Structure row", () => {
    const block = buildReasoningFromChartRead({ read: ownerRead(), symbol: "V75", timeframe: "1m" });
    expect(block.evidence.structure).toContain("Structure-read confidence: Low (structure scale: Low / Medium / High).");
    expect(block.evidence.structure).toMatch(/Mixed/);
  });

  it("an older server without a momentum sentence: 'not enough' — never the confidence word", () => {
    const block = buildReasoningFromChartRead({
      read: ownerRead({ momentumNote: undefined }),
      symbol: "V75",
      timeframe: "1m",
    });
    expect(block.evidence.momentum).not.toMatch(/confidence/i);
    expect(block.evidence.momentum.length).toBeGreaterThan(0);
  });

  it("no confidence from the server → nothing appended to Structure", () => {
    const block = buildReasoningFromChartRead({
      read: ownerRead({ confidence: undefined }),
      symbol: "V75",
      timeframe: "1m",
    });
    expect(block.evidence.structure).not.toMatch(/Structure-read confidence/);
  });
});
