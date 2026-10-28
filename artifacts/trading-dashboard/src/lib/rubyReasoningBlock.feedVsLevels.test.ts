// Feed wording vs. "no setup yet" wording in the reasoning builders.
//
// Owner screenshot 2026-10-27 ("Eleanor Market Read V75 · 1m"): a NO TRADE read
// whose Feed/Data line said "Live feed confirmed." also said "Key
// support/resistance levels are withheld until the live feed confirms." The feed
// was fine; the levels were withheld because no entry exists yet (setup still
// forming, ENTRY "No level to watch yet."). A read may only blame the feed when
// the feed is actually the reason.

import { describe, it, expect } from "vitest";
import type {
  RubyMarketEdgeSignal,
  RubyMarketReadExplanation,
} from "@workspace/api-client-react";
import {
  buildReasoningFromMarketRead,
  buildReasoningFromOppMap,
  buildReasoningFromChartRead,
  type RubyReasoningBlockData,
  type OppMapReasoningInput,
} from "@/lib/rubyReasoningBlock";

const FEED_BLAME = /until (the|a confirmed) live feed|unconfirmed feed|live feed confirms/i;

function ownerExplanation(over: Partial<RubyMarketReadExplanation> = {}): RubyMarketReadExplanation {
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
    ...over,
  } as unknown as RubyMarketReadExplanation;
}

function signal(dataSource: string): RubyMarketEdgeSignal {
  return { bias: "BULLISH", dataSource, late: { isLate: false } } as unknown as RubyMarketEdgeSignal;
}

function evidenceLines(d: RubyReasoningBlockData): string[] {
  return [d.evidence.supportResistance, d.evidence.pattern, d.evidence.trendline, d.riskNote];
}

describe("Market Read card — levels withheld for no setup are never blamed on a confirmed feed", () => {
  it("owner state: NO TRADE + live feed confirmed → S/R names the missing setup, not the feed", () => {
    const d = buildReasoningFromMarketRead({
      explanation: ownerExplanation(),
      signal: signal("LIVE_FEED"),
      downgraded: false,
      level: "full",
      newsRiskLabel: null,
    });
    expect(d.decision).toBe("NO TRADE");
    expect(d.evidence.feedData).toBe("Live feed confirmed.");
    expect(d.evidence.supportResistance).not.toMatch(FEED_BLAME);
    // No server levelsWithheldReason on this fixture → neutral fact + what is
    // still missing; never a number (the card hides Levels for a non-actionable read).
    expect(d.evidence.supportResistance).toMatch(/^No entry\/stop levels are bound to this read\./);
    expect(d.evidence.supportResistance).toContain("Still needed: enough confirming evidence.");
    expect(d.evidence.supportResistance).not.toMatch(/\d/);
  });

  it("downgraded gate keeps the feed wording", () => {
    const d = buildReasoningFromMarketRead({
      explanation: ownerExplanation(),
      signal: signal("LIVE_FEED"),
      downgraded: true,
      level: "limited",
      reason: "Feed is delayed.",
      newsRiskLabel: null,
    });
    expect(d.decision).toBe("WAIT — live feed not confirmed");
    expect(d.evidence.supportResistance).toMatch(/until the live feed confirms/);
  });

  it("gate full but the signal itself is delayed → data wording, delayed Feed/Data line", () => {
    const d = buildReasoningFromMarketRead({
      explanation: ownerExplanation(),
      signal: signal("LIVE_DELAYED"),
      downgraded: false,
      level: "full",
      newsRiskLabel: null,
    });
    expect(d.evidence.feedData).toBe("Live feed is delayed — treat as lower confidence.");
    expect(d.evidence.supportResistance).toBe("Levels withheld — not enough confirmed live candles/feed for this read.");
  });

  it("an extended (late) move on a confirmed feed: no feed blame and no level numbers in S/R", () => {
    const exp = ownerExplanation();
    exp.simple = { ...exp.simple, entryZone: "Already extended past 33600 — do not chase." };
    const d = buildReasoningFromMarketRead({
      explanation: exp,
      signal: { bias: "BULLISH", dataSource: "LIVE_FEED", late: { isLate: true } } as unknown as RubyMarketEdgeSignal,
      downgraded: false,
      level: "full",
      newsRiskLabel: null,
    });
    expect(d.evidence.supportResistance).not.toMatch(FEED_BLAME);
    // The late zone is the server's ENTRY copy on the same card; the S/R line of a
    // non-actionable read stays number-free (downgrade-only).
    expect(d.evidence.supportResistance).not.toMatch(/33600/);
  });
});

function oppInput(over: Partial<OppMapReasoningInput> = {}): OppMapReasoningInput {
  return {
    symbol: "V75",
    timeframe: "1m",
    bias: "WAIT",
    confidenceLabel: "Low",
    trendState: "ranging",
    volatilityLabel: "Moderate",
    entryZone: null,
    suggestedStop: null,
    suggestedTakeProfit: null,
    riskRewardRatio: 0,
    riskWarnings: [],
    explanation: { hedge: "", why: "No clean setup.", whyItMatters: "", risk: "", invalidation: "", cautions: [] },
    levelsWithheld: false,
    levelsWithheldReason: null,
    dataState: "LIVE_CONFIRMED",
    dataSourceLabel: "Deriv public data",
    newsRiskLevel: null,
    ...over,
  };
}

describe("Opportunity Map detail — no setup on a confirmed feed is not a feed problem", () => {
  it("LIVE_CONFIRMED + no entry zone → no feed blame anywhere", () => {
    const d = buildReasoningFromOppMap(oppInput());
    expect(d.evidence.feedData).toBe("Live feed confirmed (Deriv public data).");
    for (const line of evidenceLines(d)) expect(line).not.toMatch(FEED_BLAME);
    expect(d.evidence.supportResistance).toContain("No entry, stop or target published yet");
  });

  it("server levelsWithheldReason still wins on a confirmed feed", () => {
    const d = buildReasoningFromOppMap(oppInput({ levelsWithheld: true, levelsWithheldReason: "Levels are stale — re-checking." }));
    expect(d.evidence.supportResistance).toBe("Levels are stale — re-checking.");
  });

  it("STALE feed keeps the feed wording", () => {
    const d = buildReasoningFromOppMap(oppInput({ dataState: "STALE" }));
    expect(d.evidence.supportResistance).toMatch(/until a confirmed live feed/);
    expect(d.riskNote).toMatch(/unconfirmed feed/);
  });
});

describe("cross-builder invariant — a confirmed-feed line never pairs with feed-blaming withholding copy", () => {
  const cases: Array<[string, RubyReasoningBlockData]> = [
    ["market read / NO TRADE", buildReasoningFromMarketRead({ explanation: ownerExplanation(), signal: signal("LIVE_FEED"), downgraded: false, level: "full", newsRiskLabel: null })],
    ["market read / not actionable, not no-trade", buildReasoningFromMarketRead({ explanation: ownerExplanation({ noTrade: { isNoTrade: false, confidence: 0, reason: null } } as Partial<RubyMarketReadExplanation>), signal: signal("LIVE_FEED"), downgraded: false, level: "full", newsRiskLabel: null })],
    ["opp map / LIVE_CONFIRMED no setup", buildReasoningFromOppMap(oppInput())],
    ["opp map / LIVE_CONFIRMED buy without levels", buildReasoningFromOppMap(oppInput({ bias: "BUY" }))],
    ["chart read / FULL", buildReasoningFromChartRead({ read: { gated: false, readLayer: "FULL", bias: "Bullish", cautions: [] }, symbol: "V75", timeframe: "1m" })],
  ];
  for (const [name, d] of cases) {
    it(name, () => {
      const confirmed = /^(Live feed confirmed|Live read on|Live (\d+-minute )?candles read)/.test(d.evidence.feedData);
      expect(confirmed, `${name}: fixture must be a confirmed-feed read`).toBe(true);
      for (const line of evidenceLines(d)) expect(line, `${name}: ${line}`).not.toMatch(FEED_BLAME);
    });
  }
});

describe("Opportunity Map detail — a syncing feed withholds levels like the Highlights box", () => {
  it("SYNCING with levels does not print entry/stop/target as numbers", () => {
    const d = buildReasoningFromOppMap(oppInput({
      dataState: "SYNCING", bias: "BUY", confidenceLabel: "High",
      entryZone: { low: 1.1, high: 1.2 }, suggestedStop: 1.05, suggestedTakeProfit: 1.3, riskRewardRatio: 2,
    }));
    expect(d.decision).toBe("Conditional BUY — levels pending");
    expect(d.evidence.supportResistance).toMatch(/until a confirmed live feed/);
    expect(d.evidence.supportResistance).not.toMatch(/1\.05|1\.3/);
    expect(d.traderTest).not.toMatch(/1\.05/);
  });
});

// Truth audit 2026-10-28 (round 3) — the opp-map S/R row used a fixed
// magnitude rounding (4 dp under 100, 2 dp at 100+) while the Highlights box
// beside it printed the level itself, so 1.08523 read as 1.0852 and
// 33588.0069 as 33588.01. It now uses the shared instrument formatter at the
// precision the panel passes.
describe("opp-map levels print at the panel's instrument precision", () => {
  const live = (over: Partial<OppMapReasoningInput>) =>
    buildReasoningFromOppMap(oppInput({ bias: "BUY", confidenceLabel: "High", ...over }));

  it("EURUSD 5-digit levels keep their 5 digits", () => {
    const d = live({ entryZone: { low: 1.08523, high: 1.08561 }, suggestedStop: 1.08401, suggestedTakeProfit: 1.08811, pricePrecision: 5 });
    expect(d.evidence.supportResistance).toContain("Entry 1.08523 – 1.08561, stop 1.08401, target 1.08811");
    expect(d.evidence.supportResistance).not.toContain("1.0852 ");
    expect(d.confirmation).toContain("1.08811");
    expect(d.traderTest).toContain("1.08401");
  });

  it("V75 at 4 digits is not rounded to 2", () => {
    const d = live({ entryZone: { low: 33588.0069, high: 33590.5 }, suggestedStop: 33570.25, suggestedTakeProfit: 33620.125, pricePrecision: 4 });
    expect(d.evidence.supportResistance).toContain("Entry 33588.0069 – 33590.5000");
    expect(d.evidence.supportResistance).not.toContain("33588.01");
  });
});
