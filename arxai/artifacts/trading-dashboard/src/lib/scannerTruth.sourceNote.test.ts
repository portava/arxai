import { describe, it, expect } from "vitest";
import type { ChartFeedStatus } from "@workspace/api-client-react";
import { resolveScannerTruth, type ScannerTruthInputs, type ScannerTruthMode } from "./scannerTruth";

// Regression: the broker source note asserted "Live bars …" from the source id
// alone, so a stale / old / thin / mismatched broker feed read "Live bars are
// coming from your broker feed." beside a "Stale" / "Historical only" Data pill.

const NOW = Date.parse("2026-06-08T12:00:00.000Z");

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

describe("broker source note never says 'Live' unless the resolved display is LIVE", () => {
  it("live broker feed keeps the live note", () => {
    const t = resolveScannerTruth(inputs());
    expect(t.displayStatus).toBe("LIVE");
    expect(t.dataHealth.sourceNote).toContain("Live");
    expect(t.dataHealth.sourceNote.toLowerCase()).toContain("broker feed");
  });

  const notLive: Array<[string, ScannerTruthInputs]> = [
    ["stale feed", inputs({ feedStatus: feed({ stale: true, quality: "stale", isLive: false, aiUsable: false }) })],
    ["last bar older than the timeframe budget", inputs({ lastTime: new Date(NOW - 60 * 60_000).toISOString() })],
    ["fewer than the minimum candles", inputs({ timeframe: "1d", candleCount: 40, requestedCount: 200 })],
    ["symbol mismatch", inputs({ feedStatus: feed({ symbol: "GBPUSD" }) })],
    ["header not ok", inputs({ headerOk: false })],
  ];
  for (const [label, inp] of notLive) {
    it(`${label}: note and first health line do not claim live bars`, () => {
      const t = resolveScannerTruth(inp);
      expect(t.displayStatus).not.toBe("LIVE");
      expect(t.dataHealth.sourceNote).not.toMatch(/\blive\b/i);
      expect(t.dataHealth.lines[0]).not.toMatch(/\blive\b/i);
      // Still honest about WHERE the bars come from.
      expect(t.dataHealth.sourceNote.toLowerCase()).toContain("broker feed");
    });
  }
});
