// Pattern / Trendline rows say what was actually assessed.
//
// Owner screenshot 2026-10-27 (V75 1m): the chart drew a detected trendline with
// a red "Break" marker while Eleanor's chart read said "No specific trendline
// named." and the Market Read card said "No specific trendline called out." —
// and the Market Read "Pattern" row showed "The buy side is favored by Higher
// highs / higher lows.", which is swing-structure evidence, not a chart pattern.
// The server's chart read already carries its detector notes (patternRead /
// trendlineRead) and the market-read engine has no pattern/trendline producer.

import { describe, it, expect } from "vitest";
import type {
  RubyMarketEdgeSignal,
  RubyMarketReadExplanation,
} from "@workspace/api-client-react";
import {
  buildReasoningFromChartRead,
  buildReasoningFromMarketRead,
} from "@/lib/rubyReasoningBlock";
import type { ChartRead } from "@/lib/rubyReadPanelState";

const BROKEN_NOTE =
  "Rising support trendline (bullish) has broken on a decisive close. Feed is not live-confirmed, so treat this trendline as context only.";

function chartRead(over: Partial<ChartRead> = {}): ChartRead {
  return {
    gated: false,
    dataQuality: "ok",
    readLayer: "FULL",
    liveSetupWithheld: false,
    canShowLiveTradeSetup: true,
    bias: "Mixed",
    confidence: "Low",
    supportZone: "33250.6 – 33273.2",
    resistanceZone: "33639.4 – 33662.0",
    cautions: [],
    ...over,
  } as ChartRead;
}

describe("chart read — Pattern/Trendline rows mirror the server's detectors", () => {
  it("STRUCTURAL_ONLY read with a detected (broken) trendline shows the server note, not 'none named'/'withheld'", () => {
    const d = buildReasoningFromChartRead({
      read: chartRead({
        readLayer: "STRUCTURAL_ONLY",
        liveSetupWithheld: true,
        canShowLiveTradeSetup: false,
        trendlineRead: {
          trendlineNote: BROKEN_NOTE,
          trendlineStatus: "broken",
          trendlineContextOnly: true,
          trendlineDetection: "detected",
        },
        patternRead: {
          patternNote: "No chart pattern detected on the 1m closed-candle window.",
          patternStatus: "none",
          patternDetection: "none",
        },
      }),
      symbol: "V75",
      timeframe: "1m",
      structuralOnly: true,
    });
    expect(d.evidence.trendline).toBe(BROKEN_NOTE);
    expect(d.evidence.trendline).not.toContain("No specific trendline named");
    expect(d.evidence.trendline).not.toContain("withheld");
    expect(d.evidence.pattern).toBe("No chart pattern detected on the 1m closed-candle window.");
  });

  it("FULL read where the detector looked and found nothing → the observation, not 'none named'", () => {
    const d = buildReasoningFromChartRead({
      read: chartRead({
        trendlineRead: {
          trendlineNote: "No trendline detected on the 1m closed-candle window.",
          trendlineStatus: "none",
          trendlineDetection: "none",
        },
      }),
      symbol: "V75",
      timeframe: "1m",
    });
    expect(d.evidence.trendline).toBe("No trendline detected on the 1m closed-candle window.");
  });

  it("missing keys (old server / detector error) → 'unavailable', never 'none'", () => {
    const d = buildReasoningFromChartRead({ read: chartRead(), symbol: "V75", timeframe: "1m" });
    expect(d.evidence.trendline).toBe("Trendline read unavailable for this read.");
    expect(d.evidence.pattern).toBe("Pattern read unavailable for this read.");
  });

  it("a gated / feed-not-confirmed read keeps the withheld rows even if notes are present", () => {
    const d = buildReasoningFromChartRead({
      read: chartRead({ gated: true, trendlineRead: { trendlineNote: BROKEN_NOTE } }),
      symbol: "V75",
      timeframe: "1m",
    });
    expect(d.evidence.trendline).toBe("Trendline read withheld until the live feed confirms.");
    const e = buildReasoningFromChartRead({
      read: chartRead({ trendlineRead: { trendlineNote: BROKEN_NOTE } }),
      symbol: "V75",
      timeframe: "1m",
      feedNotConfirmed: true,
    });
    expect(e.evidence.trendline).toBe("Trendline read withheld until the live feed confirms.");
  });
});

function ownerExplanation(): RubyMarketReadExplanation {
  const mode = {
    whatIsHappening: "V75 is range-bound and looks bullish; a setup is forming.",
    why: "V75: forming — buy bias, modest edge.",
    whyThisMarket: "This market currently shows a modest edge (4/100).",
    whyThisDirection: "The buy side is favored by Higher highs / higher lows.",
    whyNow: "Early — the setup is still forming. Liquidity is strong this session.",
    timingState: "Early — the setup is still forming.",
    entryZone: "No level to watch yet.",
    risk: "Risk level not published yet — wait for a defined stop before sizing.",
    whatConfirms: "",
    whatInvalidates: "",
    whatToDoNext: "Hold off — there isn't enough confirming evidence yet.",
  };
  return {
    headline: "V75: forming — buy bias, modest edge.",
    defaultMode: "simple",
    simple: mode,
    advanced: mode,
    levels: { entryZone: null, stopLoss: null, invalidation: null },
    bestAction: "Hold off — there isn't enough confirming evidence yet.",
    noTrade: { isNoTrade: true, confidence: 66, reason: "There isn't enough confirming evidence yet." },
    hasSufficientData: true,
    actionable: false,
    missingContext: ["enough confirming evidence"],
    disclaimer: "",
  } as unknown as RubyMarketReadExplanation;
}

const SIGNAL = { bias: "BULLISH", dataSource: "LIVE_FEED", late: { isLate: false } } as unknown as RubyMarketEdgeSignal;

describe("market read — no pattern/trendline producer, and swing structure is not a 'Pattern'", () => {
  for (const downgraded of [false, true]) {
    it(`downgraded=${downgraded}: rows say 'not assessed' and never echo the direction evidence`, () => {
      const d = buildReasoningFromMarketRead({
        explanation: ownerExplanation(),
        signal: SIGNAL,
        downgraded,
        level: downgraded ? "limited" : "full",
        newsRiskLabel: null,
      });
      expect(d.evidence.pattern).toBe("Chart patterns are not assessed by this read.");
      expect(d.evidence.trendline).toBe("Trendlines are not assessed by this read.");
      expect(d.evidence.pattern).not.toContain("Higher highs");
      expect(d.evidence.trendline).not.toContain("called out");
    });
  }

  it("the swing-structure evidence moves into the Structure row", () => {
    const d = buildReasoningFromMarketRead({
      explanation: ownerExplanation(),
      signal: SIGNAL,
      downgraded: false,
      level: "full",
      newsRiskLabel: null,
    });
    expect(d.evidence.structure).toContain("The buy side is favored by Higher highs / higher lows.");
  });
});
