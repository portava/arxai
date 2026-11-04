import { describe, it, expect } from "vitest";
import type { RubyMarketEdgeSignal, RubyMarketReadExplanation } from "@workspace/api-client-react";
import { buildReasoningFromMarketRead } from "./rubyReasoningBlock";

// levels-withheld-vs-shown (owner's [H], "Eleanor Market Read V75 · 1m"):
// the card printed Support/Resistance "Key support/resistance levels are
// withheld until the live feed confirms." while Feed/Data on the SAME card said
// "Live feed confirmed.". The S/R line fired on `!actionable` alone — the read
// was live and sufficient, just a forming setup with no scanner geometry bound.
// The feed wording now appears only when the shared truth downgraded the read;
// a non-actionable live read cites the server's own reason (or a neutral fact).

const MODE = {
  whatIsHappening: "V75 is range-bound and looks bullish; a setup is forming.",
  why: "Higher highs / higher lows support the read.",
  whyThisMarket: "This market currently shows a modest edge (4/100).",
  whyThisDirection: "The buy side is favored by Higher highs / higher lows.",
  whyNow: "Early — the setup is still forming. Liquidity is strong this session.",
  timingState: "Early — the setup is still forming.",
  entryZone: "No level to watch yet.",
  risk: "Risk level not published yet — wait for a defined stop before sizing.",
  whatConfirms: "A hold of the level with Higher highs / higher lows confirms it.",
  whatInvalidates: "A break of the opposing structure invalidates it.",
  whatToDoNext: "Hold off — there isn't enough confirming evidence yet.",
};

function exp(over: Partial<RubyMarketReadExplanation> = {}): RubyMarketReadExplanation {
  return {
    headline: "V75: forming — buy bias, modest edge.",
    defaultMode: "SIMPLE",
    simple: MODE,
    advanced: MODE,
    levels: { entryZone: null, watchZone: null, lateZone: null, invalidation: null, takeProfits: [], stopLoss: null },
    bestAction: "Hold off — there isn't enough confirming evidence yet.",
    noTrade: { isNoTrade: true, confidence: 66, reason: "There isn't enough confirming evidence yet to justify the risk." },
    hasSufficientData: true,
    actionable: false,
    missingContext: ["enough confirming evidence"],
    disclaimer: "Decision support only.",
    ...over,
  } as RubyMarketReadExplanation;
}

function sig(over: Record<string, unknown> = {}): RubyMarketEdgeSignal {
  return {
    symbol: "R_75",
    displayName: "V75",
    timeframe: "M1",
    dataSource: "LIVE_FEED",
    hasSufficientData: true,
    bias: "BULLISH",
    direction: "BUY",
    lifecycleStage: "SETUP_FORMING",
    late: { isLate: false, doNotChase: false, reason: null },
    ...over,
  } as unknown as RubyMarketEdgeSignal;
}

const FEED_PHRASE = /until the live feed confirms/;

describe("buildReasoningFromMarketRead — S/R never blames a confirmed feed", () => {
  it("owner's [H]: live, sufficient, non-actionable → S/R cites the server reason, not the feed", () => {
    const r = buildReasoningFromMarketRead({
      explanation: exp({ levelsWithheldReason: "No scanner entry or stop is attached to this read yet." }),
      signal: sig(),
      downgraded: false,
      level: "full",
    });
    expect(r.evidence.feedData).toBe("Live feed confirmed.");
    expect(r.evidence.supportResistance).not.toMatch(FEED_PHRASE);
    expect(r.evidence.supportResistance).toContain("No scanner entry or stop is attached to this read yet.");
    expect(r.evidence.supportResistance).toContain("Still needed: enough confirming evidence.");
  });

  it("no server reason (older server) → neutral fallback, no cause attributed", () => {
    const r = buildReasoningFromMarketRead({ explanation: exp(), signal: sig(), downgraded: false });
    expect(r.evidence.supportResistance).toMatch(/^No entry\/stop levels are bound to this read\./);
    expect(r.evidence.supportResistance).not.toMatch(FEED_PHRASE);
    expect(r.evidence.supportResistance).not.toMatch(/not a feed problem/);
  });

  it("non-actionable never prints level numbers, even when the server populated them", () => {
    const r = buildReasoningFromMarketRead({
      explanation: exp({
        levels: { entryZone: { from: 33500.12, to: 33510.5 }, watchZone: null, lateZone: null, invalidation: 33400.25, takeProfits: [], stopLoss: 33400.25 },
      }),
      signal: sig({ lifecycleStage: "ENTRY_APPROACHING" }),
      downgraded: false,
    });
    expect(r.evidence.supportResistance).not.toMatch(/33500|33400/);
  });

  it("insufficient data on the signal → says so, without 'not a feed problem' or any other cause", () => {
    const r = buildReasoningFromMarketRead({
      explanation: exp({ hasSufficientData: false }),
      signal: sig({ hasSufficientData: false }),
      downgraded: false,
    });
    expect(r.evidence.supportResistance).toBe("Levels withheld — not enough confirmed live candles/feed for this read.");
  });

  it("non-live data source → same honest data line", () => {
    const r = buildReasoningFromMarketRead({ explanation: exp(), signal: sig({ dataSource: "LIVE_DELAYED" }), downgraded: false });
    expect(r.evidence.supportResistance).toBe("Levels withheld — not enough confirmed live candles/feed for this read.");
    expect(r.evidence.feedData).toMatch(/delayed/);
  });

  it("downgraded by the shared truth → the feed wording is kept (it IS the cause)", () => {
    const r = buildReasoningFromMarketRead({ explanation: exp(), signal: sig(), downgraded: true, level: "limited", reason: "Delayed market data." });
    expect(r.evidence.supportResistance).toMatch(FEED_PHRASE);
  });

  it("actionable live read still speaks in levels", () => {
    const r = buildReasoningFromMarketRead({
      explanation: exp({
        actionable: true,
        levels: { entryZone: { from: 1.085, to: 1.0855 }, watchZone: null, lateZone: null, invalidation: 1.0825, takeProfits: [], stopLoss: 1.083 },
      }),
      signal: sig({ lifecycleStage: "ENTRY_WINDOW_OPEN" }),
      downgraded: false,
    });
    expect(r.evidence.supportResistance).toMatch(/^Watch nearby levels — entry/);
  });
});

describe("buildReasoningFromMarketRead — quote-binding reason (Deriv last-price ticks)", () => {
  it("Feed/Data and S/R both state the spread-less quote, never a delayed feed", () => {
    const reason = "No scanner entry or stop is attached to this read because the live quote is last-price only — no bid/ask spread is bound to these candles.";
    const r = buildReasoningFromMarketRead({
      explanation: exp({ levelsWithheldReason: reason }),
      signal: sig({ scannerBinding: { bound: false, reasonCode: "quote_last_only", reason: "the live quote is last-price only — no bid/ask spread is bound to these candles" } }),
      downgraded: false,
    });
    expect(r.evidence.feedData).toBe("Live feed confirmed · no bid/ask quote is bound to these candles.");
    expect(r.evidence.supportResistance).toContain(reason);
    expect(r.evidence.supportResistance).not.toMatch(/delayed|until the live feed/i);
  });
});
