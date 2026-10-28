// Truth regressions: every scanner label must describe what was actually
// observed, from which source, as of when — never a source, freshness or
// market state that the inputs do not support.
import { describe, it, expect } from "vitest";
import type { ChartFeedStatus } from "@workspace/api-client-react";
import {
  resolveScannerTruth,
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
