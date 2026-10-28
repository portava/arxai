// Structure rows name the classifier and window they came from.
//
// Owner screenshot 2026-10-27 (V75 1m, Deriv public data): on one screen the
// Market Read card said "V75 is range-bound and looks bullish; a setup is
// forming." (regime word RANGING from a 20-bar slope + swing structure HH/HL),
// and Eleanor's chart read said "…; Mixed on 1m." (a moving-average trend /
// location read over a different window). Nothing said which window or
// classifier each came from, so they read as competing facts about one market.
//
// This drives the REAL domain engine (buildRubyMarketEdge → explainMarketRead)
// into the Market Read reasoning block, and the chart-read block with the
// server's structureWindow.

import { describe, it, expect } from "vitest";
import {
  buildRubyMarketEdge,
  explainMarketRead,
  type SignalCandle,
} from "@workspace/domain/signal-intelligence";
import type {
  RubyMarketEdgeSignal,
  RubyMarketReadExplanation,
} from "@workspace/api-client-react";
import {
  buildReasoningFromChartRead,
  buildReasoningFromMarketRead,
} from "@/lib/rubyReasoningBlock";
import type { ChartRead } from "@/lib/rubyReadPanelState";

function ownerLikeSeries(n = 118): SignalCandle[] {
  const out: SignalCandle[] = [];
  let prev = 33_200;
  for (let i = 0; i < n; i++) {
    const close = 33_200 * (1 + 0.0003 * i) + 60 * Math.sin((2 * Math.PI * i) / 12);
    const open = (prev + close) / 2;
    out.push({ open, close, high: Math.max(open, close) + 6, low: Math.min(open, close) - 6, volume: null });
    prev = close;
  }
  return out;
}

describe("Market Read Structure row — swing structure with its window, no regime contradiction", () => {
  it("owner state: no 'range-bound … bullish'; names higher highs/higher lows and the closed-bar window", () => {
    const signal = buildRubyMarketEdge({
      symbol: "R_75", displayName: "V75", timeframe: "M1", assetClass: "synthetic",
      candles: ownerLikeSeries(), currentPrice: null, dataSource: "LIVE_FEED",
      scanner: null, scalp: null, execution: null, newsRiskLevel: null, previous: null,
      now: Date.parse("2026-10-27T16:02:00.000Z"),
    });
    expect(signal.regime).toBe("RANGING");
    expect(signal.earlyTrend.structure).toBe("HH_HL");
    const explanation = explainMarketRead(signal);
    const d = buildReasoningFromMarketRead({
      explanation: explanation as unknown as RubyMarketReadExplanation,
      signal: signal as unknown as RubyMarketEdgeSignal,
      downgraded: false,
      level: "full",
      newsRiskLabel: null,
    });
    expect(d.evidence.structure).not.toMatch(/range-bound/);
    expect(d.evidence.structure).toContain("higher highs and higher lows");
    expect(d.evidence.structure).toContain("in the last 118 closed 1m bars (bullish structure)");
  });
});

describe("Chart read Structure row — names its moving-average read and window", () => {
  const read = (over: Partial<ChartRead> = {}): ChartRead => ({
    gated: false, dataQuality: "ok", readLayer: "FULL", liveSetupWithheld: false,
    canShowLiveTradeSetup: true, bias: "Mixed", confidence: "Low",
    supportZone: "33250.6 – 33273.2", resistanceZone: "33639.4 – 33662.0", cautions: [],
    htfBias: null, htfTimeframe: "M15",
    ...over,
  } as ChartRead);

  it("with the server's structureWindow the row says which read and how many bars", () => {
    const d = buildReasoningFromChartRead({ read: read({ structureWindow: 200 }), symbol: "V75", timeframe: "1m" });
    expect(d.evidence.structure).toBe(
      "Higher-timeframe (15m) bias not read; Mixed on 1m (moving-average trend read over the last 200 1m bars). Structure-read confidence: Low (structure scale: Low / Medium / High).",
    );
  });

  it("without it (older payload) no window is invented", () => {
    const d = buildReasoningFromChartRead({ read: read(), symbol: "V75", timeframe: "1m" });
    expect(d.evidence.structure).toBe("Higher-timeframe (15m) bias not read; Mixed on 1m. Structure-read confidence: Low (structure scale: Low / Medium / High).");
    const z = buildReasoningFromChartRead({ read: read({ structureWindow: 0 }), symbol: "V75", timeframe: "1m" });
    expect(z.evidence.structure).not.toMatch(/over the last/);
  });
});
