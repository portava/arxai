// Truth sweep 2026-11-04 (TRUTH-2/4/5, client): stored-history bars, closed
// markets and shared / contended feeds must be named as such on every surface.
import { describe, it, expect } from "vitest";
import type { ChartFeedStatus } from "@workspace/api-client-react";
import { resolveDisplayStatus, type FeedStatus } from "./chart-display-status";
import {
  resolveScannerTruth,
  resolveChartFeedStrip,
  storedHistoryNotice,
  type ScannerTruthInputs,
} from "./scannerTruth";
import { feedConfidence, feedProvenanceChips, isServerReceiveBasis } from "./feed-confidence";

// Wednesday — a regular trading day.
const NOW = Date.parse("2026-10-28T12:00:00.000Z");

function feed(over: Partial<ChartFeedStatus> = {}): ChartFeedStatus {
  return {
    symbol: "EURUSD", displaySymbol: "EUR/USD", assetClass: "forex", source: "mt5_broker",
    isLive: true, lastTickTime: new Date(NOW).toISOString(), lastCandleTime: new Date(NOW).toISOString(),
    latencyMs: 100, missingCandleCount: 0, duplicateCount: 0, outOfOrderCount: 0, invalidOhlcCount: 0,
    trailingIntervals: 1, stale: false, quality: "clean", warning: null, aiUsable: true, message: "ok",
    ...over,
  } as ChartFeedStatus;
}

const storedFeed = (over: Partial<ChartFeedStatus> = {}) =>
  feed({ isLive: false, aiUsable: false, notLiveReason: "stored_history", message: "Showing stored EURUSD candles — no live feed.", ...over });

function inputs(over: Partial<ScannerTruthInputs> = {}): ScannerTruthInputs {
  return {
    symbolDisplay: "EURUSD", symbolInternal: "EURUSD", timeframe: "1m", feedStatus: feed(),
    candleCount: 200, requestedCount: 200,
    firstTime: new Date(NOW - 200 * 60_000).toISOString(),
    lastTime: new Date(NOW - 10_000).toISOString(),
    lastClose: 1.15, quote: null, headerOk: null,
    mode: {
      isLoading: false, isDemo: true, isLiveShared: false, isPaper: false, isLiveArmed: false, isFrozen: false,
      canManualTrade: true, canAutoTrade: false, isSharedMasterAssigned: false, ownBridgeConnected: false,
      approvalStatus: null, frozenReason: null, cleanBlockedReason: null,
    },
    nowMs: NOW,
    ...over,
  };
}

describe("TRUTH-4: stored history display status", () => {
  it("maps stored-history bars to STALE, never FALLBACK_COMPOSITE, for any source", () => {
    for (const source of ["mt5_broker", "deriv_public", "twelvedata"]) {
      const fs: FeedStatus = { ...storedFeed({ source }) } as FeedStatus;
      expect(resolveDisplayStatus(fs, true)).toBe("STALE");
      expect(resolveDisplayStatus({ ...fs, quality: "delayed" }, true)).toBe("STALE");
    }
  });
  it("keeps integrity faults as ANALYSIS_ONLY", () => {
    expect(resolveDisplayStatus(storedFeed({ quality: "partial" }) as FeedStatus, true)).toBe("ANALYSIS_ONLY");
  });
  it("is unchanged when notLiveReason is absent (older server)", () => {
    const fs = feed({ isLive: false, aiUsable: false, source: "twelvedata" }) as FeedStatus;
    expect(resolveDisplayStatus(fs, true)).toBe("FALLBACK_COMPOSITE");
  });
});

describe("TRUTH-4: scanner truth for stored history", () => {
  it("names stored history with the newest bar's age, never Delayed or SYNCING", () => {
    for (const source of ["mt5_broker", "deriv_public"]) {
      for (const quality of ["clean", "delayed"] as const) {
        const t = resolveScannerTruth(inputs({
          feedStatus: storedFeed({ source, quality }),
          lastTime: new Date(NOW - 3 * 60_000).toISOString(),
        }));
        expect(t.candles.reason).toBe("Stored history — no live feed; newest bar opened 3m ago. Historical context only, not a live read.");
        expect(t.dataHealth.headline).toBe("Stored history — no live feed");
        expect(t.consolidated.candleStatus).not.toBe("SYNCING");
        expect(t.consolidated.candleStatus).toBe("STALE");
        expect(t.consolidated.userMessage).toContain("Stored history");
        expect(t.displayStatus).toBe("STALE");
        expect(JSON.stringify(t)).not.toContain("Delayed market data");
      }
    }
  });
  it("a scheduled weekend close still reads Market closed", () => {
    const sat = Date.parse("2026-10-31T12:00:00.000Z");
    const t = resolveScannerTruth(inputs({
      nowMs: sat,
      feedStatus: storedFeed(),
      lastTime: "2026-10-30T20:50:00.000Z",
      firstTime: "2026-10-30T17:30:00.000Z",
    }));
    expect(t.dataHealth.headline).toBe("Market closed — last session's data");
  });
});

describe("TRUTH-4: feed strip", () => {
  it("has its own stored_history kind; market closed still wins", () => {
    expect(resolveChartFeedStrip("STALE", { marketClosed: false, hasCandles: true, storedHistory: true })).toBe("stored_history");
    expect(resolveChartFeedStrip("STALE", { marketClosed: true, hasCandles: true, storedHistory: true })).toBe("market_closed");
    expect(resolveChartFeedStrip("STALE", { marketClosed: false, hasCandles: true })).toBe("stale");
    expect(resolveChartFeedStrip("LIVE", { marketClosed: false, hasCandles: true, storedHistory: true })).toBeNull();
  });
  it("strip wording states the newest bar's age", () => {
    expect(storedHistoryNotice(new Date(NOW - 2 * 3_600_000).toISOString(), NOW))
      .toBe("Stored history — no live feed; newest bar opened 2h ago");
    expect(storedHistoryNotice(null, NOW)).toBe("Stored history — no live feed");
  });
});

describe("TRUTH-5: feed-confidence popover uses the server's specific reason", () => {
  it("stored history: server message + Stored history label", () => {
    const c = feedConfidence(storedFeed());
    expect(c.statusLabel).toBe("Stored history");
    expect(c.message).toBe("Showing stored EURUSD candles — no live feed.");
    expect(c.severity).toBe("caution");
  });
  it("market closed, clean + stale: server message + Market closed label", () => {
    const c = feedConfidence(feed({ isLive: false, stale: true, aiUsable: false, notLiveReason: "market_closed", message: "Market closed for EURUSD since Fri 21:00 UTC." }));
    expect(c.statusLabel).toBe("Market closed");
    expect(c.message).toBe("Market closed for EURUSD since Fri 21:00 UTC.");
  });
  it("falls back to generic wording without a reason", () => {
    const c = feedConfidence(feed({ isLive: false, aiUsable: false }));
    expect(c.statusLabel).toBe("Not live");
    expect(c.message).toBe("These candles are not confirmed as a live feed.");
  });
  it("an integrity fault keeps its own label", () => {
    expect(feedConfidence(storedFeed({ quality: "invalid" })).statusLabel).toBe("Invalid");
  });
});

describe("TRUTH-2: feed provenance chips", () => {
  it("labels a platform-shared feed and contention, nothing otherwise", () => {
    expect(feedProvenanceChips({ feedScope: "platform_shared", contention: true }).map((c) => c.text))
      .toEqual(["Shared feed — not your bridge", "Two bridges pushing"]);
    expect(feedProvenanceChips({ feedScope: "own_bridge", contention: false })).toEqual([]);
    expect(feedProvenanceChips({})).toEqual([]);
    expect(feedProvenanceChips(null)).toEqual([]);
  });
  it("detects a server-receive tick basis", () => {
    expect(isServerReceiveBasis("server_receive")).toBe(true);
    expect(isServerReceiveBasis("producer_tick")).toBe(false);
    expect(isServerReceiveBasis(undefined)).toBe(false);
  });
});
