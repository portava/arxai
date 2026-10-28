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
