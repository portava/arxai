// Truth regressions: every scanner label must describe what was actually
// observed, from which source, as of when — never a source, freshness or
// market state that the inputs do not support.
import { describe, it, expect } from "vitest";
import type { ChartFeedStatus } from "@workspace/api-client-react";
import {
  resolveScannerTruth,
  resolveChartFeedStrip,
  scheduledWeekendClosureFor,
  nextWeekendClosureBoundaryMs,
  type ScannerTruthInputs,
  type ScannerTruthMode,
} from "./scannerTruth";
import { actionabilityDisplayUi } from "./scannerActionability";

// Wednesday — a regular trading day for every asset class.
const NOW = Date.parse("2026-10-28T12:00:00.000Z");

function feed(over: Partial<ChartFeedStatus> = {}): ChartFeedStatus {
  return {
    symbol: "EURUSD",
    displaySymbol: "EUR/USD",
    assetClass: "forex",
    source: "mt5_broker",
    isLive: true,
    lastTickTime: new Date(NOW).toISOString(),
    lastCandleTime: new Date(NOW).toISOString(),
    latencyMs: 100,
    missingCandleCount: 0,
    duplicateCount: 0,
    outOfOrderCount: 0,
    invalidOhlcCount: 0,
    trailingIntervals: 1,
    stale: false,
    quality: "clean",
    warning: null,
    aiUsable: true,
    message: "ok",
    ...over,
  } as ChartFeedStatus;
}

function mode(): ScannerTruthMode {
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
  };
}

function inputs(over: Partial<ScannerTruthInputs> = {}): ScannerTruthInputs {
  const nowMs = over.nowMs ?? NOW;
  return {
    symbolDisplay: "EURUSD",
    symbolInternal: "EURUSD",
    timeframe: "1m",
    feedStatus: feed(),
    candleCount: 200,
    requestedCount: 200,
    firstTime: new Date(nowMs - 200 * 60_000).toISOString(),
    lastTime: new Date(nowMs - 10_000).toISOString(),
    lastClose: 1.15059,
    quote: null,
    headerOk: null,
    mode: mode(),
    nowMs,
    ...over,
  };
}

describe("quote source label", () => {
  it("does not attribute a provider to a quote that was never observed", () => {
    const t = resolveScannerTruth(inputs({ quote: null }));
    expect(t.quote.source).toBeNull();
    expect(t.quote.sourceLabel).toBe("No feed");
    expect(t.quote.sourceLabel).not.toBe(t.candles.sourceLabel);
    // The candle provenance is unchanged.
    expect(t.candles.sourceLabel).toBe("MT5 broker feed");
  });

  it("labels a supplied quote with its own provider, not the candle provider", () => {
    const t = resolveScannerTruth(inputs({
      quote: {
        bid: 1.1505, ask: 1.1507, mid: 1.1506,
        source: "assistant_real:polygon",
        timestamp: new Date(NOW - 1_000).toISOString(),
      },
    }));
    expect(t.candles.sourceLabel).toBe("MT5 broker feed");
    expect(t.quote.sourceLabel).toBe("Market data feed");
  });
});

describe("check-failed action copy", () => {
  it("does not vouch for the feed it never checked", () => {
    const ui = actionabilityDisplayUi("CHECK_FAILED");
    expect(ui.copy).not.toMatch(/live data is unaffected/i);
    expect(ui.copy).not.toMatch(/\blive data\b/i);
    expect(ui.copy).toMatch(/couldn't complete/);
  });
});

describe("delayed feed copy states the real lag", () => {
  const H = 3_600_000;
  it("an H4 feed two intervals behind is not 'slightly behind live' or SYNCING", () => {
    const t = resolveScannerTruth(inputs({
      timeframe: "4h",
      candleCount: 120,
      requestedCount: 120,
      lastTime: new Date(NOW - 9 * H).toISOString(),
      feedStatus: feed({ quality: "delayed", isLive: false, aiUsable: false, trailingIntervals: 2 }),
    }));
    expect(t.candles.status).toBe("delayed");
    expect(t.candles.reason).not.toMatch(/slightly behind/i);
    expect(t.candles.reason).toMatch(/9h ago/);
    expect(t.candles.reason).toMatch(/2 bars behind/);
    expect(t.strip.data.detail).toBe(t.candles.reason);
    expect(t.consolidated.candleStatus).not.toBe("SYNCING");
    expect(t.consolidated.candleStatus).toBe("STALE");
    expect(t.consolidated.scannerActionability).toBe("FEED_LIMITED");
  });

  it("an M1 feed a couple of minutes behind still reads as catching up, with its lag", () => {
    const t = resolveScannerTruth(inputs({
      timeframe: "1m",
      lastTime: new Date(NOW - 150_000).toISOString(),
      feedStatus: feed({ quality: "delayed", isLive: false, aiUsable: false, trailingIntervals: 2 }),
    }));
    expect(t.candles.reason).not.toMatch(/slightly behind/i);
    expect(t.candles.reason).toMatch(/2m ago/);
    expect(t.consolidated.candleStatus).toBe("SYNCING");
  });
});

describe("closed market is described as closed, not as a feed fault", () => {
  // 2026-10-30 is a Friday; 2026-10-31 a Saturday; 2026-11-01 a Sunday.
  const FRI_LAST_M1 = "2026-10-30T21:59:00.000Z";
  const SAT_NOON = Date.parse("2026-10-31T12:00:00.000Z");

  function weekendStale(over: Partial<ScannerTruthInputs> = {}, feedOver: Partial<ChartFeedStatus> = {}) {
    return resolveScannerTruth(inputs({
      nowMs: SAT_NOON,
      lastTime: FRI_LAST_M1,
      feedStatus: feed({
        quality: "stale", stale: true, isLive: false, aiUsable: false, trailingIntervals: 841,
        warning: "Feed is stale — newest bar trails the current bar by 841 intervals.",
        ...feedOver,
      }),
      ...over,
    }));
  }

  it("weekend forex M1: the Data pill, reason, health and action say market closed", () => {
    const t = weekendStale();
    expect(t.strip.data.verdict).toBe("Market closed");
    expect(t.candles.reason).toMatch(/^Market closed/);
    expect(t.candles.reason).toContain("Fri 22:00 UTC");
    expect(t.candles.reason).toContain("Fri 21:59 UTC");
    expect(t.candles.reason).not.toMatch(/frozen|older than expected/i);
    expect(t.dataHealth.headline).not.toMatch(/stale/i);
    expect(t.dataHealth.lines.join(" ")).not.toMatch(/frozen/i);
    expect(t.consolidated.quoteStatus).toBe("MARKET_CLOSED");
    expect(t.consolidated.scannerActionability).toBe("MARKET_CLOSED");
    expect(t.consolidated.internalReasonCode).toBe("MARKET_CLOSED");
    expect(t.marketClosure?.closedAt).toBe("2026-10-30T22:00:00.000Z");
    // Never more live than before.
    expect(t.isLivePrice).toBe(false);
    expect(t.actionable).toBe(false);
    expect(resolveChartFeedStrip(t.displayStatus, { marketClosed: t.marketClosure != null, hasCandles: true }))
      .toBe("market_closed");
  });

  it("a 24/7 market on the same weekend keeps the stale-feed wording", () => {
    const t = weekendStale({}, { assetClass: "crypto" });
    expect(t.strip.data.verdict).toBe("Stale");
    expect(t.consolidated.quoteStatus).not.toBe("MARKET_CLOSED");
    expect(t.marketClosure ?? null).toBeNull();
  });

  it("a bar that opened after the scheduled close is observed trading, not a closed market", () => {
    const t = weekendStale({ lastTime: "2026-10-31T11:00:00.000Z" });
    expect(t.strip.data.verdict).toBe("Stale");
    expect(t.marketClosure ?? null).toBeNull();
  });

  it("a weekend display tip does not hide a closed market when the newest closed bar predates the close", () => {
    const t = weekendStale({ lastTime: "2026-10-31T11:59:00.000Z", lastClosedTime: FRI_LAST_M1 });
    expect(t.strip.data.verdict).toBe("Market closed");
  });

  it("after the window ends (Sunday 21:00 UTC) nothing claims closed", () => {
    const t = weekendStale({ nowMs: Date.parse("2026-11-01T21:30:00.000Z") });
    expect(t.strip.data.verdict).toBe("Stale");
    expect(t.marketClosure ?? null).toBeNull();
  });

  it("a failed header read keeps its own reason instead of a closed-market claim", () => {
    const t = weekendStale({ headerOk: false });
    expect(t.strip.data.verdict).not.toBe("Market closed");
  });

  it("the chart strip follows the server's closed-market stream signal too", () => {
    expect(resolveChartFeedStrip("STALE", { marketClosed: true, hasCandles: true })).toBe("market_closed");
    expect(resolveChartFeedStrip("STALE", { marketClosed: false, hasCandles: true })).toBe("stale");
    expect(resolveChartFeedStrip("FALLBACK_COMPOSITE", { marketClosed: false, hasCandles: true })).toBe("delayed");
    expect(resolveChartFeedStrip("LIVE", { marketClosed: false, hasCandles: true })).toBeNull();
  });
});

describe("no live-entry promise inside the freshness budget after the close", () => {
  it("1h feed, bar opened Fri 21:00, now Fri 22:05, server still live/clean", () => {
    const now = Date.parse("2026-10-30T22:05:00.000Z");
    const t = resolveScannerTruth(inputs({
      timeframe: "1h",
      nowMs: now,
      candleCount: 150,
      requestedCount: 150,
      lastTime: "2026-10-30T21:00:00.000Z",
      feedStatus: feed({ quality: "clean", isLive: true, aiUsable: true, trailingIntervals: 1 }),
    }));
    expect(t.strip.data.verdict).not.toBe("Live");
    expect(t.dataHealth.lines.join(" ")).not.toMatch(/fresh enough for a live entry/i);
    expect(t.candles.reason).not.toMatch(/confirmed/i);
    expect(t.consolidated.candleStatus).not.toBe("CONFIRMED");
    expect(t.consolidated.scannerActionability).toBe("MARKET_CLOSED");
    expect(actionabilityDisplayUi(t.consolidated.scannerActionability).copy).not.toMatch(/live data is confirmed/i);
    expect(t.isLivePrice).toBe(false);
  });

  it("the same feed an hour earlier (market open) is still live", () => {
    const now = Date.parse("2026-10-30T21:05:00.000Z");
    const t = resolveScannerTruth(inputs({
      timeframe: "1h",
      nowMs: now,
      candleCount: 150,
      requestedCount: 150,
      lastTime: "2026-10-30T20:00:00.000Z",
      feedStatus: feed({ quality: "clean", isLive: true, aiUsable: true, trailingIntervals: 1 }),
    }));
    expect(t.strip.data.verdict).toBe("Live");
    expect(t.marketClosure ?? null).toBeNull();
  });
});

describe("weekend closure boundaries", () => {
  it("re-resolves exactly when the closure starts and ends", () => {
    expect(nextWeekendClosureBoundaryMs("forex", Date.parse("2026-10-28T12:00:00.000Z")))
      .toBe(Date.parse("2026-10-30T22:00:00.000Z"));
    expect(nextWeekendClosureBoundaryMs("forex", Date.parse("2026-10-31T12:00:00.000Z")))
      .toBe(Date.parse("2026-11-01T21:00:00.000Z"));
    expect(nextWeekendClosureBoundaryMs("crypto", Date.parse("2026-10-31T12:00:00.000Z"))).toBeNull();
    expect(scheduledWeekendClosureFor("forex", Date.parse("2026-10-30T21:59:59.000Z"))).toBeNull();
  });
});
