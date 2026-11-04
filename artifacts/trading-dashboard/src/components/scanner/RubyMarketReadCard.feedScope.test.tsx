// Truth sweep 2026-11-04 (TRUTH-2 / TRUTH-3 client): the Market Read feed row
// names a shared feed, bridge contention, a receive-time tick stamp and a
// closed market instead of a generic "not confirmed".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const mockUseGetMeMarketEdge = vi.fn();
const mockUseSymbolTruth = vi.fn();
vi.mock("@workspace/api-client-react", () => ({
  useGetMeMarketEdge: (...args: unknown[]) => mockUseGetMeMarketEdge(...args),
  getGetMeMarketEdgeQueryKey: () => ["get-me-market-edge"],
}));
vi.mock("@/components/scanner/ScannerReadGate", () => ({ ScannerReadGate: () => null }));
vi.mock("@/hooks/useScannerReadGate", () => ({
  useScannerReadGate: () => ({ truth: null, level: "full", isFull: true, downgraded: false, reason: null }),
}));
vi.mock("@/hooks/useSymbolTruth", () => ({
  useSymbolTruth: (...args: unknown[]) => mockUseSymbolTruth(...args),
}));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));

import { RubyMarketReadCard } from "./RubyMarketReadCard";

const NOW = Date.parse("2026-10-28T10:01:00.000Z");
const mode = {
  whatIsHappening: "Price is pressing higher", why: "Trend and momentum agree", whyThisMarket: "Cleanest pair",
  whyThisDirection: "Structure favours buyers", whyNow: "Pullback completed", timingState: "Entry window open",
  entryZone: "Buy into the zone", risk: "Stop below the swing", whatConfirms: "Higher low holds",
  whatInvalidates: "Close below the zone", whatToDoNext: "Manage to the stop",
};
function response() {
  return {
    signal: {
      symbol: "EURUSD", displayName: "EURUSD", timeframe: "M15", assetClass: "forex", generatedAt: new Date(NOW - 5_000).toISOString(),
      dataSource: "LIVE_FEED", hasSufficientData: true, bias: "BULLISH", direction: "BUY", regime: "TRENDING",
      lifecycleStage: "ENTRY_WINDOW_OPEN", lifecycleReasons: [], confidenceBand: "STRONG", edgeScore: 72,
      scores: { overall: 73 }, evidence: { for: [], against: [], conflicts: [], meetsMinimum: true, netScore: 1 },
      freshness: "FRESH", validForSeconds: 3600, expiresAt: new Date(NOW + 3_600_000).toISOString(),
      late: { isLate: false, doNotChase: false, reason: null },
    },
    explanation: {
      headline: "Buyers are in control on EURUSD", defaultMode: "SIMPLE", simple: mode, advanced: mode,
      levels: { entryZone: { from: 1.085, to: 1.0855 }, watchZone: null, lateZone: null, stopLoss: 1.083, invalidation: 1.0825, takeProfits: [] },
      bestAction: "Consider a buy into the marked zone.",
      noTrade: { isNoTrade: false, confidence: 0, reason: null }, hasSufficientData: true, actionable: true, missingContext: [],
      disclaimer: "Read-only market intelligence.",
    },
  };
}
function truth(data: Record<string, unknown>) {
  return {
    news: { providerConnected: true, events: [], riskLabel: "No scheduled events affect this symbol.", highImpactWindowActive: false, disclaimer: null },
    newsState: "available",
    data: { state: "LIVE_CONFIRMED", ...data },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  mockUseGetMeMarketEdge.mockReset();
  mockUseSymbolTruth.mockReset();
  mockUseGetMeMarketEdge.mockReturnValue({ data: response(), isLoading: false, isFetching: false, isError: false, refetch: vi.fn() });
  window.localStorage.clear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const freshness = () => screen.getByTestId("ruby-market-read-freshness").textContent ?? "";

describe("Market Read feed provenance", () => {
  it("shows the shared-feed and contention chips", () => {
    mockUseSymbolTruth.mockReturnValue(truth({
      lastTickAt: new Date(NOW - 60_000).toISOString(), lastCandleAt: null,
      feedScope: "platform_shared", contention: true,
    }));
    render(<RubyMarketReadCard symbol="EURUSD" timeframe="15m" />);
    expect(screen.getByTestId("ruby-market-read-feed-scope-platform_shared").textContent).toBe("Shared feed — not your bridge");
    expect(screen.getByTestId("ruby-market-read-feed-scope-contention")).toBeTruthy();
  });
  it("shows no chip for the trader's own bridge", () => {
    mockUseSymbolTruth.mockReturnValue(truth({
      lastTickAt: new Date(NOW - 60_000).toISOString(), lastCandleAt: null, feedScope: "own_bridge",
    }));
    render(<RubyMarketReadCard symbol="EURUSD" timeframe="15m" />);
    expect(screen.queryByTestId("ruby-market-read-feed-scope-platform_shared")).toBeNull();
  });
  it("says (received) when the age is anchored on a server-receive tick stamp", () => {
    mockUseSymbolTruth.mockReturnValue(truth({
      lastTickAt: new Date(NOW - 60_000).toISOString(), lastCandleAt: null, lastTickBasis: "server_receive",
    }));
    render(<RubyMarketReadCard symbol="EURUSD" timeframe="15m" />);
    expect(freshness()).toContain("updated 1m 0s ago (received)");
  });
  it("does not say (received) when a closed bar anchors the age", () => {
    mockUseSymbolTruth.mockReturnValue(truth({
      lastTickAt: new Date(NOW - 10 * 60_000).toISOString(), lastCandleAt: new Date(NOW - 60_000).toISOString(),
      lastTickBasis: "server_receive",
    }));
    render(<RubyMarketReadCard symbol="EURUSD" timeframe="15m" />);
    expect(freshness()).not.toContain("(received)");
  });
  it("names a closed market instead of 'not confirmed'", () => {
    mockUseSymbolTruth.mockReturnValue(truth({
      state: "STALE", notLiveReason: "market_closed",
      lastTickAt: new Date(NOW - 60_000).toISOString(), lastCandleAt: null,
    }));
    render(<RubyMarketReadCard symbol="EURUSD" timeframe="15m" />);
    expect(freshness()).toContain("Market closed — last session's data");
    expect(freshness()).not.toContain("Live (unconfirmed)");
  });
});
