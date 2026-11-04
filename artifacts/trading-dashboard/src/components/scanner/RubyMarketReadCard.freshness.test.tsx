// Truth audit 2026-10-28 — the Market Read "updated Xs ago" line must be
// measured from an OBSERVATION. The snapshot's lastCandleAt is a candle's
// closeTime, which for the still-forming bar is its SCHEDULED future close
// (docs/TRUTH_EVIDENCE_INTEGRITY_2026_10_26.md). Taking max(tick, candle)
// let that future time win and clamp to "updated 0s ago" for the whole bar.
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
function truth(data: { lastTickAt: string | null; lastCandleAt: string | null }) {
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

describe("truth audit: Market Read freshness anchor", () => {
  it("measures the age from the last tick, not the forming bar's scheduled close", () => {
    mockUseSymbolTruth.mockReturnValue(truth({
      lastTickAt: new Date(NOW - 5 * 60_000).toISOString(),
      lastCandleAt: new Date(NOW + 14 * 60_000).toISOString(),
    }));
    render(<RubyMarketReadCard symbol="EURUSD" timeframe="15m" />);
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(freshness()).not.toContain("updated 0s ago");
    expect(freshness()).toContain("updated 7m 0s ago");
  });

  it("does not claim a fresh update when only a forming bar's scheduled close is known", () => {
    mockUseSymbolTruth.mockReturnValue(truth({
      lastTickAt: null,
      lastCandleAt: new Date(NOW + 14 * 60_000).toISOString(),
    }));
    render(<RubyMarketReadCard symbol="EURUSD" timeframe="15m" />);
    act(() => { vi.advanceTimersByTime(120_000); });
    const text = freshness();
    expect(text).not.toMatch(/updated \d+s ago/);
    expect(text).not.toContain("Live feed ·");
    expect(text).toContain("forming bar");
    expect(screen.getByTestId("ruby-market-read-freshness").className).not.toContain("text-success");
  });

  it("still uses a closed bar's close time when it is the newest observation", () => {
    mockUseSymbolTruth.mockReturnValue(truth({
      lastTickAt: new Date(NOW - 10 * 60_000).toISOString(),
      lastCandleAt: new Date(NOW - 60_000).toISOString(),
    }));
    render(<RubyMarketReadCard symbol="EURUSD" timeframe="15m" />);
    expect(freshness()).toContain("Live feed · updated 1m 0s ago");
  });
});
