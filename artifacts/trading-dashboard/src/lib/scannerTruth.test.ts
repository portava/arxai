import { describe, it, expect } from "vitest";
import type { ChartFeedStatus } from "@workspace/api-client-react";
import {
  evaluateTradeHealthReadiness,
  requiredClosedBarsForTimeframe,
} from "@workspace/domain/market";
import {
  resolveScannerTruth,
  thresholdsFor,
  TIMEFRAME_THRESHOLDS,
  type ScannerTruthInputs,
  type ScannerTruthMode,
} from "./scannerTruth";
import { normalizeChartTimeframe } from "./chartCandlesQuery";

const NOW = Date.parse("2026-06-08T12:00:00.000Z");

function feed(over: Partial<ChartFeedStatus> = {}): ChartFeedStatus {
  return {
    symbol: "EURUSD",
    displaySymbol: "EUR/USD",
    assetClass: "forex",
    source: "twelvedata",
    isLive: true,
    lastTickTime: new Date(NOW).toISOString(),
    lastCandleTime: new Date(NOW).toISOString(),
    latencyMs: 100,
    missing: 0,
    duplicate: 0,
    outOfOrder: 0,
    invalidOhlc: 0,
    stale: false,
    quality: "clean",
    warning: null,
    aiUsable: true,
    feedReadinessState: "ready",
    message: "ok",
    ...over,
  } as ChartFeedStatus;
}

function mode(over: Partial<ScannerTruthMode> = {}): ScannerTruthMode {
  return {
    isLoading: false,
    isDemo: true,
    isLiveShared: false,
    isPaper: false,
    isLiveArmed: false,
    isFrozen: false,
    canManualTrade: true,
    canAutoTrade: false,
    isSharedMasterAssigned: false,
    ownBridgeConnected: false,
    approvalStatus: null,
    frozenReason: null,
    cleanBlockedReason: null,
    ...over,
  };
}

function inputs(over: Partial<ScannerTruthInputs> = {}): ScannerTruthInputs {
  return {
    symbolDisplay: "EURUSD",
    symbolInternal: "EURUSD",
    timeframe: "1m",
    feedStatus: feed(),
    candleCount: 200,
    requestedCount: 200,
    firstTime: new Date(NOW - 200 * 60_000).toISOString(),
    lastTime: new Date(NOW - 10_000).toISOString(),
    lastClose: 1.15059,
    quote: null,
    headerOk: null,
    mode: mode(),
    nowMs: NOW,
    ...over,
  };
}

describe("thresholds", () => {
  it("uses spec section C minimums", () => {
    expect(thresholdsFor("1m").minCandles).toBe(150);
    expect(thresholdsFor("5m").minCandles).toBe(150);
    expect(thresholdsFor("15m").minCandles).toBe(120);
    expect(thresholdsFor("1h").minCandles).toBe(100);
  });
  it("extends 30m/4h/1d", () => {
    expect(thresholdsFor("30m").minCandles).toBe(110);
    expect(thresholdsFor("4h").minCandles).toBe(80);
    expect(thresholdsFor("1d").minCandles).toBe(50);
  });
  it("extends to the full 21 MT5 set (Task #484)", () => {
    expect(thresholdsFor("2m").minCandles).toBe(150);
    expect(thresholdsFor("12m").minCandles).toBe(130);
    expect(thresholdsFor("20m").minCandles).toBe(115);
    expect(thresholdsFor("2h").minCandles).toBe(95);
    expect(thresholdsFor("12h").minCandles).toBe(65);
    expect(thresholdsFor("1w").minCandles).toBe(30);
    expect(thresholdsFor("1mo").minCandles).toBe(12);
  });
  it("covers every timeframe the chart can select (no strict-1m fallback)", () => {
    // A chart-selectable timeframe missing from the table would silently inherit
    // the 1m budget and wrongly downgrade valid coarse-timeframe data (finding #2).
    for (const tf of [
      "1m", "2m", "3m", "4m", "5m", "6m", "10m", "12m", "15m", "20m", "30m",
      "1h", "2h", "3h", "4h", "6h", "8h", "12h", "1d", "1w", "1mo",
    ]) {
      expect(TIMEFRAME_THRESHOLDS[tf], `missing threshold for ${tf}`).toBeDefined();
    }
  });
  it("defaults unknown timeframe to the strictest bucket", () => {
    expect(thresholdsFor("zzz")).toEqual(TIMEFRAME_THRESHOLDS["1m"]);
  });
});

describe("displayStatus is capped by resolved truth (finding #3)", () => {
  // The chart renders truth.displayStatus, so it must NEVER read more live than
  // the strip/read-gate. displayStatus is derived from candleStatus+analysisLevel,
  // not raw feed display, so min-candle/age/consistency downgrades cap it too.
  it("LIVE only when candles are live AND analysis is full", () => {
    const t = resolveScannerTruth(inputs());
    expect(t.candles.status).toBe("live");
    expect(t.analysis.level).toBe("full");
    expect(t.displayStatus).toBe("LIVE");
    expect(t.isLivePrice).toBe(true);
  });

  it("insufficient candles cap displayStatus to ANALYSIS_ONLY even on a live feed", () => {
    const t = resolveScannerTruth(inputs({ candleCount: 40 }));
    expect(t.candles.status).toBe("insufficient");
    expect(t.displayStatus).toBe("ANALYSIS_ONLY");
    expect(t.isLivePrice).toBe(false);
  });

  it("consistency mismatch caps displayStatus to ANALYSIS_ONLY", () => {
    const t = resolveScannerTruth(
      inputs({ quote: { bid: 1.084, ask: 1.085, mid: 1.0845, source: "sim", timestamp: new Date(NOW).toISOString() } }),
    );
    expect(t.consistency.status).toBe("mismatch");
    expect(t.displayStatus).toBe("ANALYSIS_ONLY");
    expect(t.isLivePrice).toBe(false);
  });

  it("stale feed caps displayStatus to STALE", () => {
    const t = resolveScannerTruth(inputs({ feedStatus: feed({ quality: "stale", stale: true, isLive: false, aiUsable: false }) }));
    expect(t.displayStatus).toBe("STALE");
    expect(t.isLivePrice).toBe(false);
  });

  it("delayed feed caps displayStatus to FALLBACK_COMPOSITE", () => {
    const t = resolveScannerTruth(inputs({ feedStatus: feed({ quality: "delayed", isLive: false, aiUsable: false }) }));
    expect(t.displayStatus).toBe("FALLBACK_COMPOSITE");
    expect(t.isLivePrice).toBe(false);
  });

  it("no candles cap displayStatus to UNAVAILABLE", () => {
    const t = resolveScannerTruth(inputs({ candleCount: 0, lastClose: null, lastTime: null, feedStatus: feed({ quality: "empty", isLive: false, aiUsable: false }) }));
    expect(t.displayStatus).toBe("UNAVAILABLE");
    expect(t.isLivePrice).toBe(false);
  });
});

describe("candle status", () => {
  it("live when clean+isLive+sufficient+fresh", () => {
    const t = resolveScannerTruth(inputs());
    expect(t.candles.status).toBe("live");
    expect(t.analysis.level).toBe("full");
    expect(t.ruby.readLevel).toBe("full");
    expect(t.overlays.status).toBe("verified");
    expect(t.actionable).toBe(true);
    expect(t.strip.data.verdict).toBe("Live");
  });

  it("insufficient when below the per-timeframe minimum", () => {
    const t = resolveScannerTruth(inputs({ candleCount: 40 }));
    expect(t.candles.status).toBe("insufficient");
    expect(t.analysis.level).toBe("historical_only");
    expect(t.ruby.readLevel).toBe("historical_only");
    expect(t.actionable).toBe(false);
    expect(t.strip.data.verdict).toBe("Historical only");
  });

  it("delayed when feed quality is delayed", () => {
    const t = resolveScannerTruth(inputs({ feedStatus: feed({ quality: "delayed", isLive: false, aiUsable: false }) }));
    expect(t.candles.status).toBe("delayed");
    expect(t.analysis.level).toBe("limited");
    expect(t.ruby.readLevel).toBe("limited");
    expect(t.overlays.status).toBe("limited");
    expect(t.strip.data.verdict).toBe("Delayed");
  });

  it("stale when feed is stale", () => {
    const t = resolveScannerTruth(inputs({ feedStatus: feed({ quality: "stale", stale: true, isLive: false, aiUsable: false }) }));
    expect(t.candles.status).toBe("stale");
    expect(t.analysis.level).toBe("historical_only");
    expect(t.isLivePrice).toBe(false);
  });

  it("unavailable when no candles", () => {
    const t = resolveScannerTruth(inputs({ candleCount: 0, lastClose: null, lastTime: null, feedStatus: feed({ quality: "empty", isLive: false, aiUsable: false }) }));
    expect(t.candles.status).toBe("unavailable");
    expect(t.analysis.level).toBe("blocked");
    expect(t.ruby.readLevel).toBe("blocked");
    expect(t.ruby.chartReadAllowed).toBe(false);
    expect(t.overlays.allowed).toBe(false);
    expect(t.strip.data.verdict).toBe("Unavailable");
  });
});

describe("quote↔candle consistency", () => {
  it("unknown when no independent quote", () => {
    const t = resolveScannerTruth(inputs());
    expect(t.consistency.status).toBe("unknown");
    // price falls back to the candle close, never a simulator quote
    expect(t.quote.mid).toBe(1.15059);
  });

  it("mismatch downgrades analysis to historical only", () => {
    const t = resolveScannerTruth(
      inputs({ quote: { bid: 1.084, ask: 1.085, mid: 1.0845, source: "sim", timestamp: new Date(NOW).toISOString() } }),
    );
    expect(t.consistency.status).toBe("mismatch");
    expect(t.consistency.withinTolerance).toBe(false);
    expect(t.analysis.level).toBe("historical_only");
    expect(t.actionable).toBe(false);
  });

  it("aligned when quote and candle agree", () => {
    const t = resolveScannerTruth(
      inputs({ quote: { bid: 1.1505, ask: 1.1507, mid: 1.1506, source: "broker", timestamp: new Date(NOW).toISOString() } }),
    );
    expect(t.consistency.status).toBe("aligned");
    expect(t.analysis.level).toBe("full");
  });
});

describe("permission matrix", () => {
  it("demo manual user can execute in demo", () => {
    const t = resolveScannerTruth(inputs({ mode: mode({ isDemo: true, canManualTrade: true }) }));
    expect(t.permissions.effectiveMode).toBe("demo");
    expect(t.permissions.demoManualAllowed).toBe(true);
    expect(t.execution.allowed).toBe(true);
    expect(t.strip.trading.verdict).toBe("Enabled");
  });

  it("live shared manual user can execute live", () => {
    const t = resolveScannerTruth(inputs({ mode: mode({ isDemo: false, isLiveShared: true, isSharedMasterAssigned: true, canManualTrade: true }) }));
    expect(t.permissions.effectiveMode).toBe("live");
    expect(t.permissions.liveManualAllowed).toBe(true);
    expect(t.execution.allowed).toBe(true);
  });

  it("read-only when no trading permission and not demo/live", () => {
    const t = resolveScannerTruth(inputs({ mode: mode({ isDemo: false, isLiveShared: false, isPaper: true, canManualTrade: false }) }));
    expect(t.permissions.effectiveMode).toBe("read_only");
    expect(t.execution.allowed).toBe(false);
    expect(t.strip.trading.verdict).toBe("Approval required");
  });

  it("frozen blocks trading", () => {
    const t = resolveScannerTruth(inputs({ mode: mode({ isFrozen: true, frozenReason: "Account frozen by admin." }) }));
    expect(t.execution.allowed).toBe(false);
    expect(t.strip.trading.verdict).toBe("Blocked");
    expect(t.permissions.manualTradingBlockedReason).toBe("Account frozen by admin.");
  });

  it("AI permissions track canAutoTrade", () => {
    const demoAi = resolveScannerTruth(inputs({ mode: mode({ isDemo: true, canAutoTrade: true }) }));
    expect(demoAi.permissions.demoAIAllowed).toBe(true);
    const liveAi = resolveScannerTruth(inputs({ mode: mode({ isDemo: false, isLiveShared: true, canAutoTrade: true }) }));
    expect(liveAi.permissions.liveAIAllowed).toBe(true);
  });
});

describe("source labels are user-safe", () => {
  it("never leaks the precise provider token in the generic label", () => {
    const t = resolveScannerTruth(inputs({ feedStatus: feed({ source: "polygon" }) }));
    expect(t.candles.sourceLabel).toBe("Market data feed");
    expect(t.candles.sourceLabel.toLowerCase()).not.toContain("polygon");
    // precise name retained for admin-only surfaces
    expect(t.candles.sourceTechnical.length).toBeGreaterThan(0);
  });

  it("labels broker-native feed as your broker", () => {
    const t = resolveScannerTruth(inputs({ feedStatus: feed({ source: "mt5_broker" }) }));
    expect(t.candles.sourceLabel).toBe("Your broker feed");
    expect(t.candles.tier).toBe("broker");
  });
});

describe("cross-surface consistency (one truth, every surface agrees)", () => {
  // The whole point of Task #391 is that the header strip, the chart panel, and
  // the advisory read-gate (Ruby Market Read / Timing Intelligence) can never
  // disagree about whether the market is live. They each read DIFFERENT fields of
  // the SAME resolved truth, so these tests assert those fields stay in lockstep:
  //   • header strip   → strip.data.verdict
  //   • chart panel    → displayStatus / isLivePrice
  //   • read-gate      → analysis.level + downgraded (level !== "full")
  // A regression that moved one surface without the others would break here.

  // Mirror useScannerReadGate's derivation for a RESOLVED truth (level !== "full").
  // The hook itself is fail-closed on top of this: a null truth (fetch failure /
  // unresolved) is also downgraded — covered in useScannerReadGate.test.ts.
  const readGate = (t: ReturnType<typeof resolveScannerTruth>) => ({
    level: t.analysis.level,
    downgraded: t.analysis.level !== "full",
  });

  it("LIVE: strip Live, chart LIVE+livePrice, read-gate full+not-downgraded", () => {
    const t = resolveScannerTruth(inputs());
    expect(t.strip.data.verdict).toBe("Live");
    expect(t.displayStatus).toBe("LIVE");
    expect(t.isLivePrice).toBe(true);
    expect(readGate(t)).toEqual({ level: "full", downgraded: false });
  });

  it("DELAYED: strip Delayed, chart FALLBACK_COMPOSITE+notLive, read-gate limited+downgraded", () => {
    const t = resolveScannerTruth(
      inputs({ feedStatus: feed({ quality: "delayed", isLive: false, aiUsable: false }) }),
    );
    expect(t.strip.data.verdict).toBe("Delayed");
    expect(t.displayStatus).toBe("FALLBACK_COMPOSITE");
    expect(t.isLivePrice).toBe(false);
    expect(readGate(t)).toEqual({ level: "limited", downgraded: true });
  });

  it("STALE: strip Stale, chart STALE+notLive, read-gate historical_only+downgraded", () => {
    const t = resolveScannerTruth(
      inputs({ feedStatus: feed({ quality: "stale", stale: true, isLive: false, aiUsable: false }) }),
    );
    expect(t.strip.data.verdict).toBe("Stale");
    expect(t.displayStatus).toBe("STALE");
    expect(t.isLivePrice).toBe(false);
    expect(readGate(t)).toEqual({ level: "historical_only", downgraded: true });
  });

  it("INSUFFICIENT: strip Historical only, chart ANALYSIS_ONLY+notLive, read-gate historical_only+downgraded", () => {
    const t = resolveScannerTruth(inputs({ candleCount: 40 }));
    expect(t.strip.data.verdict).toBe("Historical only");
    expect(t.displayStatus).toBe("ANALYSIS_ONLY");
    expect(t.isLivePrice).toBe(false);
    expect(readGate(t)).toEqual({ level: "historical_only", downgraded: true });
  });

  it("UNAVAILABLE/blocked: strip Unavailable, chart UNAVAILABLE+notLive, read-gate blocked+downgraded", () => {
    const t = resolveScannerTruth(
      inputs({ candleCount: 0, lastClose: null, lastTime: null, feedStatus: feed({ quality: "empty", isLive: false, aiUsable: false }) }),
    );
    expect(t.strip.data.verdict).toBe("Unavailable");
    expect(t.displayStatus).toBe("UNAVAILABLE");
    expect(t.isLivePrice).toBe(false);
    expect(readGate(t)).toEqual({ level: "blocked", downgraded: true });
  });

  it("only a fully-live read is ever non-downgraded (isLivePrice ⇔ not downgraded)", () => {
    // The actionable affordance (chart live tick) and the read-gate's
    // not-downgraded state must be the SAME condition across every feed shape.
    const cases: ScannerTruthInputs[] = [
      inputs(),
      inputs({ feedStatus: feed({ quality: "delayed", isLive: false, aiUsable: false }) }),
      inputs({ feedStatus: feed({ quality: "stale", stale: true, isLive: false, aiUsable: false }) }),
      inputs({ candleCount: 40 }),
      inputs({ candleCount: 0, lastClose: null, lastTime: null, feedStatus: feed({ quality: "empty", isLive: false, aiUsable: false }) }),
    ];
    for (const c of cases) {
      const t = resolveScannerTruth(c);
      expect(t.isLivePrice).toBe(!readGate(t).downgraded);
    }
  });
});

describe("brokerFeedActive — execution bridge never implies broker chart bars (Task #464)", () => {
  // The core honesty rule: a connected MT5 EXECUTION bridge does NOT make the
  // CHART feed broker-native. brokerFeedActive is driven ONLY by the candle
  // source tier, so a third-party-live read (the GBPUSD case) is honest about
  // NOT being broker bars even while the data is genuinely live.
  it("true ONLY when candles come from the broker feed (tier broker)", () => {
    const t = resolveScannerTruth(inputs({ feedStatus: feed({ source: "mt5_broker" }) }));
    expect(t.candles.tier).toBe("broker");
    expect(t.brokerFeedActive).toBe(true);
    expect(t.dataHealth.sourceNote.toLowerCase()).toContain("broker feed");
  });

  it("GBPUSD: live via third-party feed → actionable but brokerFeedActive false, honest source note", () => {
    const t = resolveScannerTruth(inputs({ symbolDisplay: "GBPUSD", symbolInternal: "GBPUSD", feedStatus: feed({ source: "twelvedata" }) }));
    expect(t.actionable).toBe(true);
    expect(t.isLivePrice).toBe(true);
    expect(t.brokerFeedActive).toBe(false);
    expect(t.dataHealth.headline).toBe("Live market data");
    // Honest: live, but NOT the broker chart feed.
    expect(t.dataHealth.sourceNote.toLowerCase()).toContain("broker chart feed isn't active");
  });

  it("synthetic feed is labelled as synthetic, never broker", () => {
    const t = resolveScannerTruth(inputs({ feedStatus: feed({ source: "deriv" }) }));
    expect(t.brokerFeedActive).toBe(false);
    expect(t.dataHealth.sourceNote.toLowerCase()).toContain("synthetic");
  });
});

describe("dataHealth is plain-English and never leaks internal labels (Task #464)", () => {
  // Admins keep the precise provider name in candles.sourceTechnical; the
  // user-facing dataHealth strings must never carry a provider ID or internal
  // flag token.
  const FORBIDDEN = [
    "assistant_real", "twelvedata", "twelve_data", "polygon", "alpha_vantage",
    "alphavantage", "aiusable", "feedstatus", "mt5provider", "mt5_provider",
    "sourcetechnical",
  ];

  it("headline + sourceNote + lines stay free of provider tokens across feed shapes", () => {
    const shapes: Partial<ChartFeedStatus>[] = [
      { source: "twelvedata" },
      { source: "polygon", quality: "delayed", isLive: false, aiUsable: false },
      { source: "alphavantage", stale: true, isLive: false, aiUsable: false },
      { source: "mt5_broker" },
      { source: "deriv" },
    ];
    for (const s of shapes) {
      const t = resolveScannerTruth(inputs({ feedStatus: feed(s) }));
      const blob = [t.dataHealth.headline, t.dataHealth.sourceNote, ...t.dataHealth.lines].join(" ").toLowerCase();
      for (const tok of FORBIDDEN) {
        expect(blob.includes(tok), `dataHealth leaked "${tok}" for source ${s.source}`).toBe(false);
      }
    }
  });

  it("lines carry the source note, the exact candle reason, and an actionability line", () => {
    const t = resolveScannerTruth(inputs({ candleCount: 40 }));
    expect(t.dataHealth.lines[0]).toBe(t.dataHealth.sourceNote);
    expect(t.dataHealth.lines[1]).toBe(t.candles.reason);
    expect(t.dataHealth.lines[2]!.toLowerCase()).toContain("context");
  });
});

describe("timeframe normalization feeds the correct threshold (Task #464 cross-surface honesty)", () => {
  // Scanner signals carry backend-format timeframes (M1/M5/M15/H1/H4). If those
  // reach thresholdsFor() un-normalized they miss the lowercase keys and collapse
  // to the strict 1m budget, flagging genuinely-live coarse bars as "stale" — the
  // exact header-says-Live / modal-says-stale disagreement the task forbids.
  it("maps backend enums and canonical ids to the same canonical lowercase id", () => {
    const pairs: Array<[string, string]> = [
      // Backend enums for the full 21 MT5 set → canonical lowercase chart id.
      ["M1", "1m"], ["M2", "2m"], ["M3", "3m"], ["M4", "4m"], ["M5", "5m"],
      ["M6", "6m"], ["M10", "10m"], ["M12", "12m"], ["M15", "15m"],
      ["M20", "20m"], ["M30", "30m"],
      ["H1", "1h"], ["H2", "2h"], ["H3", "3h"], ["H4", "4h"], ["H6", "6h"],
      ["H8", "8h"], ["H12", "12h"],
      ["D1", "1d"], ["W1", "1w"], ["MN1", "1mo"],
      // Canonical lowercase ids pass through unchanged.
      ["1m", "1m"], ["12h", "12h"], ["1w", "1w"], ["1mo", "1mo"],
      // The month label "1M" must NOT collapse to one-minute "1m".
      ["1M", "1mo"],
    ];
    for (const [input, expected] of pairs) {
      expect(normalizeChartTimeframe(input), `normalize(${input})`).toBe(expected);
    }
  });

  it("unknown / null timeframes degrade to 5m, never the strict 1m bucket by accident", () => {
    expect(normalizeChartTimeframe(null)).toBe("5m");
    expect(normalizeChartTimeframe(undefined)).toBe("5m");
    expect(normalizeChartTimeframe("")).toBe("5m");
    expect(normalizeChartTimeframe("zzz")).toBe("5m");
  });

  it("normalized backend M15 resolves to the 15m threshold, not the strict 1m fallback", () => {
    const m15 = thresholdsFor(normalizeChartTimeframe("M15"));
    expect(m15).toEqual(TIMEFRAME_THRESHOLDS["15m"]);
    expect(m15).not.toEqual(TIMEFRAME_THRESHOLDS["1m"]);
    // And the raw, un-normalized backend token is exactly the failure mode we fix:
    // it wrongly falls back to the strict 1m budget.
    expect(thresholdsFor("M15")).toEqual(TIMEFRAME_THRESHOLDS["1m"]);
  });
});

describe("trade-health readiness DISPLAY contract — scanner adapter (HARD RULE: display may only downgrade, never grant)", () => {
  // The scanner maps its resolved truth into the ONE shared Trade Health
  // readiness verdict (resolveScannerTruth().readiness). Ruby's chart read
  // composes the SAME pure contract (evaluateTradeHealthReadiness) and surfaces
  // its displayLabel / userFacingTrustLine / dataFreshness VERBATIM, so the two
  // surfaces agree by construction:
  //   1. the pure contract is deterministic (identical inputs ⇒ identical
  //      verdict — locked by tradeHealthReadinessContract.test.ts), and
  //   2. each surface feeds the contract faithfully (these tests lock the
  //      scanner side; the Ruby side is a verbatim passthrough).
  // The affordance flags are DISPLAY CEILINGS only — they may hide a button,
  // never reveal one the execution stack forbids. None of these inputs carries
  // any privilege/role, so nothing here can upgrade an affordance.

  const AFFORDANCES = [
    "mayDescribeSetup",
    "mayShowTradeButton",
    "mayShowOneClickButton",
    "mayOfferLiveExecutionRequest",
  ] as const;

  it("clean live read → every affordance ceiling open, LIVE_CONFIRMED, no block reason", () => {
    const t = resolveScannerTruth(inputs());
    const r = t.readiness;
    expect(t.candles.status).toBe("live");
    expect(r.readLayer).toBe("FULL");
    expect(r.dataFreshness).toBe("LIVE_CONFIRMED");
    expect(r.executionBlockedReason).toBeNull();
    expect(r.displayLabel).toBe("Live-confirmed");
    for (const flag of AFFORDANCES) {
      expect(r[flag], `${flag} should be open on a clean live read`).toBe(true);
    }
  });

  // Every non-live feed/candle shape must collapse ALL affordance ceilings to
  // false and refuse LIVE_CONFIRMED — display downgrades, never grants.
  const NON_LIVE_SHAPES: Array<{ name: string; over: Partial<ScannerTruthInputs> }> = [
    { name: "insufficient bars", over: { candleCount: 40 } },
    {
      name: "delayed feed",
      over: { feedStatus: feed({ quality: "delayed", isLive: false, aiUsable: false }) },
    },
    {
      name: "stale feed",
      over: { feedStatus: feed({ quality: "stale", stale: true, isLive: false, aiUsable: false }) },
    },
    {
      name: "no candles / unavailable",
      over: {
        candleCount: 0,
        lastClose: null,
        lastTime: null,
        feedStatus: feed({ quality: "empty", isLive: false, aiUsable: false }),
      },
    },
  ];

  for (const shape of NON_LIVE_SHAPES) {
    it(`${shape.name} → no affordance, never LIVE_CONFIRMED`, () => {
      const r = resolveScannerTruth(inputs(shape.over)).readiness;
      expect(r.dataFreshness).not.toBe("LIVE_CONFIRMED");
      expect(r.readLayer).not.toBe("FULL");
      for (const flag of AFFORDANCES) {
        expect(r[flag], `${flag} must be withheld for ${shape.name}`).toBe(false);
      }
    });
  }

  it("HARD-RULE invariant across every feed shape: an open affordance ALWAYS implies a full live-confirmed read", () => {
    const cases: ScannerTruthInputs[] = [
      inputs(),
      ...NON_LIVE_SHAPES.map((s) => inputs(s.over)),
    ];
    for (const c of cases) {
      const r = resolveScannerTruth(c).readiness;
      for (const flag of AFFORDANCES) {
        if (r[flag]) {
          expect(r.dataFreshness).toBe("LIVE_CONFIRMED");
          expect(r.readLayer).toBe("FULL");
          expect(r.executionBlockedReason).toBeNull();
        }
      }
    }
  });

  it("readiness IS a faithful contract evaluation of the scanner's RAW facts (independent reconstruction, no echo)", () => {
    // Rebuild the contract inputs INDEPENDENTLY from the scanner's published RAW
    // facts (candle status, analysis + ruby read levels, bar counts, the
    // per-timeframe floor) — NOT from the verdict's own feedVerdict/readLayer,
    // which the pure contract echoes back verbatim (echoing them would prove
    // nothing about the scanner's raw-facts → contract-inputs MAPPING — the bug a
    // prior version of this test masked). Mirror the adapter exactly: the
    // structure/setup bands are NOT passed (they default inside the contract).
    // Exact equality proves the scanner fed the SAME shared contract Ruby feeds,
    // so the two surfaces cannot drift.
    const cases: ScannerTruthInputs[] = [
      inputs(),
      ...NON_LIVE_SHAPES.map((s) => inputs(s.over)),
    ];
    for (const c of cases) {
      const t = resolveScannerTruth(c);
      const count = t.candles.count;
      const minRequired = thresholdsFor(t.timeframe).minCandles;
      const recomputed = evaluateTradeHealthReadiness({
        symbol: t.symbolInternal,
        timeframe: t.timeframe,
        freshnessVerdict:
          t.candles.status === "live"
            ? "LIVE"
            : t.candles.status === "delayed"
              ? "LIVE_DELAYED"
              : "AWAITING",
        availableClosedCandles: count,
        minimumRequiredCandles: minRequired,
        readLayer:
          t.analysis.level === "blocked" ||
          t.candles.status === "insufficient" ||
          count < minRequired
            ? "INSUFFICIENT"
            : t.ruby.readLevel === "full" && t.analysis.level === "full"
              ? "FULL"
              : "STRUCTURAL_ONLY",
      });
      expect(recomputed).toEqual(t.readiness);
    }
  });
});

describe("trade-health readiness — shared floor + direct Ruby↔Scanner parity (one truth, no drift)", () => {
  const AFFORDANCES = [
    "mayDescribeSetup",
    "mayShowTradeButton",
    "mayShowOneClickButton",
    "mayOfferLiveExecutionRequest",
  ] as const;

  it("shared domain floor matches the scanner threshold table for EVERY timeframe (drift-lock)", () => {
    // requiredClosedBarsForTimeframe (domain, fed to Ruby) and the scanner's
    // TIMEFRAME_THRESHOLDS.minCandles MUST stay identical or the two surfaces
    // would label the same symbol+tf differently in the thin-history window.
    for (const key of Object.keys(TIMEFRAME_THRESHOLDS)) {
      expect(requiredClosedBarsForTimeframe(key), `floor drift for ${key}`).toBe(
        thresholdsFor(key).minCandles,
      );
    }
  });

  it("canonical MT5 codes resolve to the SAME floor as their scanner UI alias", () => {
    const pairs: Array<[string, string]> = [
      ["M1", "1m"],
      ["M5", "5m"],
      ["M15", "15m"],
      ["M30", "30m"],
      ["H1", "1h"],
      ["H4", "4h"],
      ["H12", "12h"],
      ["D1", "1d"],
      ["W1", "1w"],
      ["MN1", "1mo"],
    ];
    for (const [canonical, alias] of pairs) {
      expect(requiredClosedBarsForTimeframe(canonical), `${canonical} vs ${alias}`).toBe(
        thresholdsFor(alias).minCandles,
      );
    }
  });

  it("live 200-bar read: scanner(1m + thr floor) and ruby(M1 + shared floor) compose a byte-identical verdict", () => {
    const facts = {
      symbol: "EURUSD",
      freshnessVerdict: "LIVE" as const,
      availableClosedCandles: 200,
    };
    const scanner = evaluateTradeHealthReadiness({
      ...facts,
      timeframe: "1m",
      minimumRequiredCandles: thresholdsFor("1m").minCandles,
      readLayer: "FULL",
    });
    const ruby = evaluateTradeHealthReadiness({
      ...facts,
      timeframe: "M1",
      minimumRequiredCandles: requiredClosedBarsForTimeframe("M1"),
      readLayer: "FULL",
    });
    expect(ruby).toEqual(scanner);
    expect(scanner.displayLabel).toBe("Live-confirmed");
  });

  it("100-bar 1m edge: the shared floor forces Ruby to the SAME 'Building history' label as Scanner", () => {
    // The EXACT pre-fix divergence. At 100 closed 1m bars (< the 150 floor) Ruby
    // used to fall back to a floor of 5 and read "Live-confirmed" while the
    // Scanner read "Building history". Ruby is now fed the SAME per-timeframe
    // floor, so it downgrades identically — EVEN though Ruby's own read layer is
    // still FULL: the floor (not the read layer) drives the label here.
    const facts = {
      symbol: "EURUSD",
      freshnessVerdict: "LIVE" as const,
      availableClosedCandles: 100,
    };
    const scanner = evaluateTradeHealthReadiness({
      ...facts,
      timeframe: "1m",
      minimumRequiredCandles: thresholdsFor("1m").minCandles,
      readLayer: "INSUFFICIENT", // scanner maps count<minCandles → INSUFFICIENT
    });
    const ruby = evaluateTradeHealthReadiness({
      ...facts,
      timeframe: "M1",
      minimumRequiredCandles: requiredClosedBarsForTimeframe("M1"),
      readLayer: "FULL", // Ruby's own read-layer gating still says FULL at 100 bars
    });
    expect(ruby.displayLabel).toBe("Building history");
    expect(scanner.displayLabel).toBe("Building history");
    expect(ruby.dataFreshness).toBe("AWAITING");
    expect(scanner.dataFreshness).toBe("AWAITING");
    // tf token normalized (M1 ≡ 1m) ⇒ identical trust line despite the spelling.
    expect(ruby.userFacingTrustLine).toBe(scanner.userFacingTrustLine);
    for (const flag of AFFORDANCES) {
      expect(ruby[flag], `ruby ${flag}`).toBe(false);
      expect(scanner[flag], `scanner ${flag}`).toBe(false);
    }
  });
});
