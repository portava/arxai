import { describe, it, expect } from "vitest";
import type { ChartFeedStatus } from "@workspace/api-client-react";
import { resolveScannerTruth, type ScannerTruthInputs, type ScannerTruthMode } from "./scannerTruth";

// Regression: while GET account-mode is loading (or failed with no envelope)
// every mode flag is false, so the strip asserted "Approval required" (and the
// public block REVIEW_REQUIRED) with the contradicting detail "Read-only —
// trading isn't available from the scanner in this mode." Nothing about the
// account's approval had been measured.

const NOW = Date.parse("2026-06-08T12:00:00.000Z");

function feed(): ChartFeedStatus {
  return {
    symbol: "EURUSD", displaySymbol: "EUR/USD", assetClass: "forex", source: "twelvedata",
    isLive: true, lastTickTime: new Date(NOW).toISOString(), lastCandleTime: new Date(NOW).toISOString(),
    latencyMs: 100, missing: 0, duplicate: 0, outOfOrder: 0, invalidOhlc: 0, stale: false,
    quality: "clean", warning: null, aiUsable: true, feedReadinessState: "ready", message: "ok",
  } as ChartFeedStatus;
}

const UNRESOLVED_MODE: ScannerTruthMode = {
  isLoading: false, isDemo: false, isLiveShared: false, isPaper: false, isLiveArmed: false,
  isFrozen: false, canManualTrade: false, canAutoTrade: false, isSharedMasterAssigned: false,
  ownBridgeConnected: false, approvalStatus: null, frozenReason: null, cleanBlockedReason: null,
};

function inputs(mode: ScannerTruthMode): ScannerTruthInputs {
  return {
    symbolDisplay: "EURUSD", symbolInternal: "EURUSD", timeframe: "1m", feedStatus: feed(),
    candleCount: 200, requestedCount: 200,
    firstTime: new Date(NOW - 200 * 60_000).toISOString(), lastTime: new Date(NOW - 10_000).toISOString(),
    lastClose: 1.15059, quote: null, headerOk: null, mode, nowMs: NOW,
  };
}

describe("Trading verdict while the account mode is unresolved", () => {
  it("loading: says it is checking, never Approval required / Enabled / Blocked / Read-only", () => {
    const t = resolveScannerTruth(inputs({ ...UNRESOLVED_MODE, isLoading: true }));
    expect(["Approval required", "Enabled", "Blocked", "Read-only"]).not.toContain(t.strip.trading.verdict);
    expect(t.strip.trading.verdict).toBe("Checking…");
    expect(t.strip.trading.detail).not.toMatch(/read-only/i);
    expect(t.consolidated.tradingStatus).not.toBe("REVIEW_REQUIRED");
    expect(t.consolidated.tradingStatus).not.toBe("ENABLED");
  });

  it("failed with no envelope: says it could not be checked", () => {
    const t = resolveScannerTruth(inputs({ ...UNRESOLVED_MODE, isError: true }));
    expect(t.strip.trading.verdict).toBe("Couldn't check");
    expect(t.strip.trading.detail.toLowerCase()).toContain("couldn't");
    expect(t.consolidated.tradingStatus).not.toBe("REVIEW_REQUIRED");
    expect(t.consolidated.tradingStatus).not.toBe("ENABLED");
  });

  it("a resolved envelope with no demo/live mode still reads Approval required", () => {
    const t = resolveScannerTruth(inputs(UNRESOLVED_MODE));
    expect(t.strip.trading.verdict).toBe("Approval required");
    expect(t.consolidated.tradingStatus).toBe("REVIEW_REQUIRED");
  });
});
