// ── GOLD STRATEGY MODE (Task #657) — PURE domain unit tests ──────────────────
//
// All 25 required tests + extra safety tests for the gold strategy layer. Every
// import is from the pure "@workspace/domain/market" barrel; there is NO IO, no
// server, no DB. The contract under test is DISPLAY / DECISION-SUPPORT only and
// downgrade-only: it may explain/classify/warn/cap but can NEVER create a
// READY_NOW, bypass feed/sufficiency/Trade-Health/risk/live gates, or override a
// stale feed. Missing macro reads "unavailable", never "neutral".

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  // asset profile / activation
  isGoldMode,
  isGoldSymbol,
  getGoldAssetProfile,
  goldMinimumCandles,
  // macro
  resolveGoldMacro,
  goldMacroSupport,
  type GoldMacroVerdict,
  // session / timing
  resolveGoldTiming,
  detectLondonSweep,
  type GoldTimingInput,
  type GoldTimingVerdict,
  // tactics
  resolveGoldShootingStar,
  resolveGoldHammer,
  resolveGoldLiquiditySweep,
  resolveGoldBreakoutRetest,
  type GoldCandleVerdict,
  // risk
  resolveGoldRisk,
  goldStopDistanceStatus,
  type GoldRiskVerdict,
  // strategy templates + auto-bot precondition
  GOLD_STRATEGY_TEMPLATES,
  getGoldStrategyTemplate,
  evaluateGoldStrategy,
  goldAutoBotPrecondition,
  // reasoning + overlays + badges
  buildGoldContextBlock,
  buildGoldScannerBadges,
  buildGoldOverlaySpec,
  // reliability
  aggregateGoldReliability,
  type GoldOutcomeSample,
} from "@workspace/domain/market";

// ── Fixtures ─────────────────────────────────────────────────────────────────

interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
}

/** 5 rising candles + a clean shooting star at index 5 (detects). */
const SHOOTING_STAR_CANDLES: Bar[] = [
  { open: 99, high: 101, low: 98.5, close: 100 },
  { open: 100, high: 102, low: 99.5, close: 101 },
  { open: 101, high: 103, low: 100.5, close: 102 },
  { open: 102, high: 104, low: 101.5, close: 103 },
  { open: 103, high: 105, low: 102.5, close: 104 },
  { open: 104.2, high: 106, low: 103.9, close: 104.0 },
];

/** 5 falling candles + a clean hammer at index 5 (detects). */
const HAMMER_CANDLES: Bar[] = [
  { open: 106, high: 106.5, low: 104, close: 105 },
  { open: 105, high: 105.5, low: 103, close: 104 },
  { open: 104, high: 104.5, low: 102, close: 103 },
  { open: 103, high: 103.5, low: 101, close: 102 },
  { open: 102, high: 102.5, low: 100, close: 101 },
  { open: 101, high: 101.4, low: 99, close: 101.2 },
];

/** An Asian session range of [1990, 2010]. */
const ASIAN_CANDLES: Bar[] = [
  { open: 2000, high: 2010, low: 1990, close: 2002 },
  { open: 2002, high: 2008, low: 1992, close: 1998 },
  { open: 1998, high: 2006, low: 1994, close: 2004 },
];

/** A recent candle that sweeps the Asian HIGH (2010) then closes back inside. */
const SWEEP_HIGH_RECENT: Bar[] = [
  { open: 2005, high: 2018, low: 2004, close: 2006 },
];

const MACRO_UNAVAILABLE: GoldMacroVerdict = resolveGoldMacro({ newsConnected: false });

const fullMacroBull = (): GoldMacroVerdict =>
  resolveGoldMacro({
    dollarTrend: "weak",
    realYieldTrend: "falling",
    riskSentiment: "risk_off",
    newsConnected: true,
  });

function timingInput(over: Partial<GoldTimingInput> = {}): GoldTimingInput {
  return {
    session: "london",
    asianCandles: ASIAN_CANDLES,
    recentCandles: SWEEP_HIGH_RECENT,
    candleState: "closed_confirmed",
    volatilityState: "NORMAL",
    newsWindowActive: false,
    spreadWide: false,
    feedConfirmed: true,
    feedStale: false,
    sufficiencyAllowsSetup: true,
    ...over,
  };
}

function cleanRisk(over: Parameters<typeof resolveGoldRisk>[0] | object = {}): GoldRiskVerdict {
  return resolveGoldRisk({
    atrState: "normal",
    spreadState: "normal",
    newsRisk: "low",
    proposedStopDistance: 5,
    atr: 4,
    style: "intraday",
    ...(over as object),
  } as Parameters<typeof resolveGoldRisk>[0]);
}

// ── 1–2: Asset profile / activation ──────────────────────────────────────────

describe("gold asset profile", () => {
  it("1. XAUUSD activates Gold Mode", () => {
    assert.equal(isGoldMode("XAUUSD"), true);
    assert.equal(isGoldSymbol("XAUUSD"), true);
    for (const s of ["GOLD", "GC", "MGC", "xauusd", "gc"]) {
      assert.equal(isGoldMode(s), true, `${s} should activate gold mode`);
    }
    const profile = getGoldAssetProfile();
    assert.ok(profile, "gold profile must resolve for a gold symbol");
    assert.equal(profile.assetClass, "gold");
    assert.ok(profile.symbols.includes("XAUUSD"));
  });

  it("2. Non-gold symbols do not activate Gold Mode", () => {
    for (const s of ["EURUSD", "US30", "V75", "BTCUSD", "GBPJPY"]) {
      assert.equal(isGoldMode(s), false, `${s} must NOT activate gold mode`);
    }
  });

  it("3. Gold Mode uses ATR-aware stop checks", () => {
    // Per-style minimum candle counts exist and are positive.
    assert.ok(goldMinimumCandles("scalp") > 0);
    assert.ok(goldMinimumCandles("swing") > 0);
    // The ATR-aware minimum widens with the ATR regime.
    const normal = goldStopDistanceStatus(3, 4, "normal");
    const extreme = goldStopDistanceStatus(3, 4, "extreme");
    assert.ok(normal.minAcceptable != null && extreme.minAcceptable != null);
    assert.ok(
      extreme.minAcceptable! > normal.minAcceptable!,
      "extreme-ATR minimum stop must exceed the normal-ATR minimum",
    );
    // A stop too tight for extreme ATR is flagged, not silently accepted.
    assert.equal(extreme.status, "too_tight");
    // Unknown ATR never fabricates an "acceptable".
    assert.equal(goldStopDistanceStatus(3, null, "normal").status, "unknown");
  });
});

// ── 4–6: Candlestick emphasis ────────────────────────────────────────────────

describe("shooting star gold tests", () => {
  it("4. Shooting star at resistance is conditional, not automatic sell", () => {
    const v = resolveGoldShootingStar({
      candles: SHOOTING_STAR_CANDLES,
      feedConfirmed: true,
      feedStale: false,
      atKeyResistance: true,
      midRange: false,
    });
    assert.equal(v.decision, "conditional_sell");
    assert.equal(v.conditional, true);
    assert.equal(v.atKeyLevel, true);
    assert.ok(v.confidence <= 70, "even confirmed, gold shooting star is capped");
  });

  it("5. Shooting star mid-range scores weak", () => {
    const v = resolveGoldShootingStar({
      candles: SHOOTING_STAR_CANDLES,
      feedConfirmed: true,
      feedStale: false,
      atKeyResistance: false,
      midRange: true,
    });
    assert.equal(v.strength, "weak");
    assert.notEqual(v.decision, "conditional_sell");
    assert.ok(v.confidence <= 30, "mid-range wick is weak/low confidence");
  });

  it("6. Hammer at support is conditional, not automatic buy", () => {
    const v = resolveGoldHammer({
      candles: HAMMER_CANDLES,
      feedConfirmed: true,
      feedStale: false,
      atKeySupport: true,
      midRange: false,
    });
    assert.equal(v.decision, "conditional_buy");
    assert.equal(v.conditional, true);
    assert.equal(v.atKeyLevel, true);
  });
});

// ── 7–8: Session / timing ────────────────────────────────────────────────────

describe("gold timing/session tests", () => {
  it("7. Asian range high/low is detected", () => {
    const v = resolveGoldTiming(timingInput());
    assert.ok(v.asianRange, "Asian range must be detected from Asian candles");
    assert.equal(v.asianRange!.high, 2010);
    assert.equal(v.asianRange!.low, 1990);
    // No Asian candles ⇒ honest null, never fabricated.
    const empty = resolveGoldTiming(timingInput({ asianCandles: [] }));
    assert.equal(empty.asianRange, null);
  });

  it("8. London sweep is detected after Asian range break/reclaim", () => {
    const range = { high: 2010, low: 1990, midpoint: 2000 };
    const sweep = detectLondonSweep(range, SWEEP_HIGH_RECENT);
    assert.equal(sweep.detected, true);
    assert.equal(sweep.direction, "bearish");
    assert.equal(sweep.level, 2010);
    assert.equal(sweep.reclaimed, true);
    // No reclaim ⇒ not detected.
    const none = detectLondonSweep(range, [{ open: 2005, high: 2007, low: 2003, close: 2006 }]);
    assert.equal(none.detected, false);
  });
});

// ── 9–11: Risk model ─────────────────────────────────────────────────────────

describe("gold risk tests", () => {
  it("9. NY news window blocks normal gold scalp", () => {
    const v = resolveGoldRisk({
      atrState: "normal",
      spreadState: "normal",
      newsRisk: "high",
      style: "scalp",
    });
    assert.equal(v.scalpBlocked, true);
    assert.ok(v.blockReasons.length > 0);
    // Timing-level news window blocks too.
    const t = resolveGoldTiming(timingInput({ newsWindowActive: true }));
    assert.equal(t.timingStatus, "news_blocked");
    assert.equal(t.timingApproved, false);
  });

  it("10. Wide spread blocks gold scalp", () => {
    const v = resolveGoldRisk({
      atrState: "normal",
      spreadState: "wide",
      newsRisk: "low",
      style: "scalp",
    });
    assert.equal(v.scalpBlocked, true);
    assert.ok(v.blockReasons.some((r) => /spread/i.test(r)));
  });

  it("11. ATR extreme marks tight stop unsafe", () => {
    const v = resolveGoldRisk({
      atrState: "extreme",
      spreadState: "normal",
      newsRisk: "low",
      proposedStopDistance: 1,
      atr: 4,
      style: "scalp",
    });
    assert.equal(v.atrState, "extreme");
    assert.equal(v.stopDistanceStatus, "too_tight");
    assert.ok(v.confidenceCap <= 45, "extreme ATR caps confidence");
    assert.equal(v.scalpBlocked, true, "extreme ATR + tight stop blocks the scalp");
    assert.ok(v.positionSizeMultiplier <= 0.5);
  });
});

// ── 12–14: Liquidity sweep + breakout/retest ─────────────────────────────────

describe("liquidity sweep tests", () => {
  it("12. Liquidity sweep + reclaim creates conditional setup", () => {
    const v = resolveGoldLiquiditySweep({
      level: 2000,
      side: "low",
      recentCandles: [{ open: 2002, high: 2004, low: 1995, close: 2003 }],
      feedConfirmed: true,
      feedStale: false,
      targetRoom: true,
    });
    assert.equal(v.decision, "conditional_buy");
    assert.equal(v.conditional, true);
    // No target room ⇒ blocked despite the sweep.
    const blocked = resolveGoldLiquiditySweep({
      level: 2000,
      side: "low",
      recentCandles: [{ open: 2002, high: 2004, low: 1995, close: 2003 }],
      feedConfirmed: true,
      feedStale: false,
      targetRoom: false,
    });
    assert.equal(blocked.decision, "no_trade");
  });

  it("13. Breakout without retest remains lower confidence", () => {
    const v = resolveGoldBreakoutRetest({
      closedBeyond: true,
      retestHeld: false,
      momentumSupports: false,
      spreadAcceptable: true,
      intoOpposingLevel: false,
      direction: "buy",
      feedConfirmed: true,
      feedStale: false,
    });
    assert.equal(v.conditional, true);
    assert.ok(v.confidence <= 45, "bare breakout stays lower confidence");
  });

  it("14. Breakout retest hold increases confidence", () => {
    const bare = resolveGoldBreakoutRetest({
      closedBeyond: true,
      retestHeld: false,
      momentumSupports: false,
      spreadAcceptable: true,
      intoOpposingLevel: false,
      direction: "buy",
      feedConfirmed: true,
      feedStale: false,
    });
    const held = resolveGoldBreakoutRetest({
      closedBeyond: true,
      retestHeld: true,
      momentumSupports: false,
      spreadAcceptable: true,
      intoOpposingLevel: false,
      direction: "buy",
      feedConfirmed: true,
      feedStale: false,
    });
    assert.ok(held.confidence > bare.confidence, "a held retest raises confidence");
  });
});

// ── 15–16: Macro ─────────────────────────────────────────────────────────────

describe("gold macro verdict tests", () => {
  it("15. Gold macro conflict caps confidence", () => {
    const conflict = resolveGoldMacro({
      dollarTrend: "weak", // bullish for gold
      realYieldTrend: "rising", // bearish for gold
      newsConnected: true,
    });
    assert.equal(conflict.macroBias, "mixed");
    assert.ok(conflict.confidenceCap <= 45, "conflicting drivers cap confidence");
  });

  it("16. Missing macro data is labeled unavailable, not neutral", () => {
    assert.equal(MACRO_UNAVAILABLE.macroBias, "unavailable");
    assert.notEqual(MACRO_UNAVAILABLE.macroBias, "neutral");
    assert.equal(MACRO_UNAVAILABLE.leansDirection, "none");
    // Support check honestly reports "unavailable", never "supports".
    assert.equal(goldMacroSupport(MACRO_UNAVAILABLE, "buy"), "unavailable");
  });
});

// ── 17–19: Overlays / scanner badges / Eleanor reasoning ─────────────────────

function reasoningInputs() {
  const timing = resolveGoldTiming(timingInput());
  const tactic: GoldCandleVerdict = resolveGoldShootingStar({
    candles: SHOOTING_STAR_CANDLES,
    feedConfirmed: true,
    feedStale: false,
    atKeyResistance: true,
    midRange: false,
  });
  const risk = cleanRisk();
  const macro = MACRO_UNAVAILABLE;
  const strategy = evaluateGoldStrategy({
    template: GOLD_STRATEGY_TEMPLATES[0],
    direction: "sell",
    macro,
    timing,
    tactic,
    risk,
    feedConfirmed: true,
    feedStale: false,
    sufficiencyAllowsSetup: true,
  });
  return { symbol: "XAUUSD", direction: "sell" as const, macro, timing, tactic, risk, strategy };
}

describe("Eleanor reasoning tests", () => {
  it("17. Gold chart shows gold-specific overlays", () => {
    const timing = resolveGoldTiming(timingInput());
    const spec = buildGoldOverlaySpec({
      asianRange: timing.asianRange,
      nyOpenRange: timing.nyOpenRange,
      timing,
      keyLevels: [{ label: "R1", price: 2015 }],
    });
    assert.equal(spec.displayOnly, true);
    assert.equal(spec.tradeButtons, false);
    assert.ok(spec.elements.length > 0, "overlay must include at least the Asian range");
    assert.ok(spec.elements.some((e) => e.kind === "range_box" && e.label === "Asian Range"));
  });

  it("18. Gold scanner row shows Gold Mode badges", () => {
    const badges = buildGoldScannerBadges(reasoningInputs());
    assert.ok(badges.length > 0);
    assert.ok(badges.some((b) => b.label === "Gold Mode"));
    // Unavailable macro reads neutral, never positive.
    const macroBadge = badges.find((b) => b.title === "Macro");
    assert.ok(macroBadge);
    assert.equal(macroBadge!.tone, "neutral");
  });

  it("19. Eleanor Gold reasoning uses Gold Context section", () => {
    const block = buildGoldContextBlock(reasoningInputs());
    assert.equal(block.title, "Gold Context");
    assert.ok(block.lines.some((l) => /Macro: unavailable/i.test(l)), "macro line is honest");
    assert.ok(block.decision.length > 0);
    // Never an automatic ready/buy/sell — conditional language only.
    assert.ok(!/ready[_ ]?now/i.test(block.decision));
  });
});

// ── 20–21: Testing lab (backtest / forward test) ─────────────────────────────

describe("testing lab integration tests", () => {
  it("20. Backtest can isolate Gold Mode strategy performance", () => {
    const samples: GoldOutcomeSample[] = [
      { symbol: "XAUUSD", timeframe: "M15", session: "london", setupType: "breakout_retest", outcome: "WIN", realizedR: 1.5 },
      { symbol: "XAUUSD", timeframe: "M15", session: "london", setupType: "breakout_retest", outcome: "LOSS", realizedR: -1 },
      { symbol: "XAUUSD", timeframe: "M15", session: "new_york", setupType: "liquidity_sweep_reclaim", outcome: "SWEEP_SUCCESS", realizedR: 2 },
      { symbol: "XAUUSD", timeframe: "M15", session: "new_york", setupType: "breakout_retest", outcome: "BREAKOUT_RETEST_HELD", realizedR: 1.2 },
      { symbol: "XAUUSD", timeframe: "M15", session: "london", setupType: "breakout_retest", outcome: "FALSE_BREAK", realizedR: -0.8 },
    ];
    const report = aggregateGoldReliability(samples);
    assert.equal(report.totalSamples, 5);
    assert.ok(report.bySession.length >= 2, "performance is isolated per session");
    assert.ok(report.bySetupType.length >= 2, "performance is isolated per setup type");
    assert.ok(report.overall.winRate != null);
  });

  it("21. Forward test tracks gold-specific fakeout/wick stats", () => {
    const samples: GoldOutcomeSample[] = [
      { symbol: "XAUUSD", timeframe: "M5", session: "new_york", setupType: "breakout_retest", outcome: "FALSE_BREAK", realizedR: -1 },
      { symbol: "XAUUSD", timeframe: "M5", session: "new_york", setupType: "wick_rejection", outcome: "WICK_FAILURE", realizedR: -0.5 },
      { symbol: "XAUUSD", timeframe: "M5", session: "new_york", setupType: "liquidity_sweep_reclaim", outcome: "SWEEP_SUCCESS", realizedR: 1.5 },
      { symbol: "XAUUSD", timeframe: "M5", session: "new_york", setupType: "breakout_retest", outcome: "BREAKOUT_RETEST_HELD", realizedR: 1 },
      { symbol: "XAUUSD", timeframe: "M5", session: "new_york", setupType: "trend_pullback", outcome: "WIN", realizedR: 1 },
      // Defensive observations — never counted as losses.
      { symbol: "XAUUSD", timeframe: "M5", session: "new_york", setupType: "news_impulse", outcome: "NEWS_WINDOW_BLOCKED", realizedR: null },
      { symbol: "XAUUSD", timeframe: "M5", session: "new_york", setupType: "exhaustion_fade", outcome: "TOO_LATE_AVOIDED", realizedR: null },
    ];
    const report = aggregateGoldReliability(samples);
    assert.equal(report.newsWindowBlocked, 1, "news-window-blocked tracked separately");
    assert.equal(report.tooLateAvoided, 1, "too-late-avoided tracked separately");
    assert.ok(report.overall.falseBreakRate != null && report.overall.falseBreakRate! > 0);
    assert.ok(report.overall.wickFailureRate != null && report.overall.wickFailureRate! > 0);
    assert.ok(report.overall.sweepSuccessRate != null && report.overall.sweepSuccessRate! > 0);
    assert.ok(report.overall.breakoutRetestRate != null && report.overall.breakoutRetestRate! > 0);
  });
});

// ── 22–25: Auto-bot safety + core safety invariants ──────────────────────────

describe("auto-bot safety tests", () => {
  it("22. Auto Bot cannot trade gold from Gold Mode alone", () => {
    // Everything gold-favourable, but the EXTERNAL gates are all false.
    const macro = fullMacroBull();
    const timing = resolveGoldTiming(timingInput());
    const tactic = resolveGoldHammer({
      candles: HAMMER_CANDLES,
      feedConfirmed: true,
      feedStale: false,
      atKeySupport: true,
      midRange: false,
    });
    const risk = cleanRisk();
    const pre = goldAutoBotPrecondition({
      symbol: "XAUUSD",
      direction: "buy",
      macro,
      timing,
      tactic,
      risk,
      feedLiveConfirmed: false,
      feedStale: false,
      candleSufficiencyMet: false,
      tradeHealthReady: false,
      liveExecutionGatesPass: false,
    });
    assert.equal(pre.eligible, false, "gold context alone can never make auto-bot eligible");
    assert.ok(pre.blockReasons.length > 0);
  });

  it("23. Gold Mode cannot bypass live gates", () => {
    const macro = fullMacroBull();
    const timing = resolveGoldTiming(timingInput());
    const tactic = resolveGoldHammer({
      candles: HAMMER_CANDLES,
      feedConfirmed: true,
      feedStale: false,
      atKeySupport: true,
      midRange: false,
    });
    const risk = cleanRisk();
    // Every gold + feed + trade-health prerequisite satisfied, ONLY the live
    // execution gates fail ⇒ still ineligible.
    const pre = goldAutoBotPrecondition({
      symbol: "XAUUSD",
      direction: "buy",
      macro,
      timing,
      tactic,
      risk,
      feedLiveConfirmed: true,
      feedStale: false,
      candleSufficiencyMet: true,
      tradeHealthReady: true,
      liveExecutionGatesPass: false,
    });
    assert.equal(pre.eligible, false, "failing live gates must block eligibility");
    assert.ok(pre.blockReasons.some((r) => /live[- ]execution gates/i.test(r)));
  });

  it("24. Gold Mode cannot override stale feed state", () => {
    // A stale feed forces the strategy to context-only (watch), never conditional/ready.
    const timing = resolveGoldTiming(timingInput({ feedStale: true, feedConfirmed: false }));
    const tactic = resolveGoldShootingStar({
      candles: SHOOTING_STAR_CANDLES,
      feedConfirmed: false,
      feedStale: true,
      atKeyResistance: true,
      midRange: false,
    });
    const verdict = evaluateGoldStrategy({
      template: GOLD_STRATEGY_TEMPLATES[0],
      direction: "sell",
      macro: fullMacroBull(),
      timing,
      tactic,
      risk: cleanRisk(),
      feedConfirmed: false,
      feedStale: true,
      sufficiencyAllowsSetup: true,
    });
    assert.equal(verdict.readyNow, false);
    assert.equal(verdict.decision, "watch", "stale feed forces context-only watch");
    assert.ok(verdict.confidence <= 35, "stale feed caps confidence to context-only");
    // Timing itself never approves on a stale feed.
    assert.equal(timing.timingApproved, false);
  });

  it("25. Gold Mode cannot create READY_NOW from macro alone", () => {
    // Strongest possible macro, but a no-trade tactic ⇒ blocked, never ready.
    const noTactic = resolveGoldShootingStar({
      candles: [{ open: 1, high: 1, low: 1, close: 1 }],
      feedConfirmed: true,
      feedStale: false,
      atKeyResistance: true,
      midRange: false,
    });
    const verdict = evaluateGoldStrategy({
      template: GOLD_STRATEGY_TEMPLATES[0],
      direction: "buy",
      macro: fullMacroBull(),
      timing: resolveGoldTiming(timingInput()),
      tactic: noTactic,
      risk: cleanRisk(),
      feedConfirmed: true,
      feedStale: false,
      sufficiencyAllowsSetup: true,
    });
    // The type guarantees readyNow: false; assert it at runtime too.
    assert.equal(verdict.readyNow, false);
    assert.equal(verdict.decision, "blocked");
    // No reachable gold strategy verdict is ever "ready".
    for (const t of GOLD_STRATEGY_TEMPLATES) {
      const v = evaluateGoldStrategy({
        template: t,
        direction: "buy",
        macro: fullMacroBull(),
        timing: resolveGoldTiming(timingInput()),
        tactic: resolveGoldHammer({
          candles: HAMMER_CANDLES,
          feedConfirmed: true,
          feedStale: false,
          atKeySupport: true,
          midRange: false,
        }),
        risk: cleanRisk(),
        feedConfirmed: true,
        feedStale: false,
        sufficiencyAllowsSetup: true,
      });
      assert.equal(v.readyNow, false, `${t.id} must never be READY_NOW`);
      assert.notEqual(v.decision, "blocked");
      assert.ok(["watch", "conditional"].includes(v.decision));
    }
  });
});

// ── Extra safety: template registry + downgrade-only confidence ──────────────

describe("gold strategy template safety", () => {
  it("registry exposes the advisory templates and lookups", () => {
    assert.ok(GOLD_STRATEGY_TEMPLATES.length >= 6);
    const t = getGoldStrategyTemplate(GOLD_STRATEGY_TEMPLATES[0].id);
    assert.ok(t);
    assert.equal(getGoldStrategyTemplate("does_not_exist"), undefined);
  });

  it("a hard risk block dominates a favourable tactic (downgrade-only)", () => {
    const verdict = evaluateGoldStrategy({
      template: getGoldStrategyTemplate("gold_wick_rejection_level")!,
      direction: "buy",
      macro: fullMacroBull(),
      timing: resolveGoldTiming(timingInput({ spreadWide: true })),
      tactic: resolveGoldHammer({
        candles: HAMMER_CANDLES,
        feedConfirmed: true,
        feedStale: false,
        atKeySupport: true,
        midRange: false,
      }),
      risk: resolveGoldRisk({ atrState: "normal", spreadState: "wide", newsRisk: "low", style: "scalp" }),
      feedConfirmed: true,
      feedStale: false,
      sufficiencyAllowsSetup: true,
    });
    assert.equal(verdict.decision, "blocked");
    assert.equal(verdict.readyNow, false);
    assert.ok(verdict.blockingFactors.length > 0);
  });
});
