// Truth fix — the Market Read feed row's "updated X ago" must be anchored to an
// OBSERVED data time. The snapshot's lastCandleAt is the newest provider bar's
// closeTime, which for a still-forming bar is a scheduled FUTURE boundary
// (open + interval). Clamping now − future to 0 read "updated 0s ago" for the
// whole bar even when nothing had arrived for 35 minutes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const mockUseGetMeMarketEdge = vi.fn();
let truthData: Record<string, unknown> = {};
vi.mock("@workspace/api-client-react", () => ({
  useGetMeMarketEdge: (...args: unknown[]) => mockUseGetMeMarketEdge(...args),
  getGetMeMarketEdgeQueryKey: () => ["get-me-market-edge"],
}));
vi.mock("@/components/scanner/ScannerReadGate", () => ({ ScannerReadGate: () => null }));
vi.mock("@/hooks/useScannerReadGate", () => ({
  useScannerReadGate: () => ({ truth: null, level: "full", isFull: true, downgraded: false, reason: null }),
}));
vi.mock("@/hooks/useSymbolTruth", () => ({
  useSymbolTruth: () => ({
    news: { providerConnected: true, events: [], riskLabel: "No scheduled events affect this symbol.", highImpactWindowActive: false, disclaimer: null },
    data: truthData,
  }),
}));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));

import { RubyMarketReadCard } from "./RubyMarketReadCard";

const mode = {
  whatIsHappening: "x", why: "x", whyThisMarket: "x", whyThisDirection: "x", whyNow: "x", timingState: "x",
  entryZone: "x", risk: "x", whatConfirms: "x", whatInvalidates: "x", whatToDoNext: "x",
};
function response() {
  return {
    signal: {
      symbol: "EURUSD", displayName: "EURUSD", timeframe: "H1", assetClass: "forex", generatedAt: new Date(Date.now() - 5_000).toISOString(),
      dataSource: "LIVE_FEED", hasSufficientData: true, bias: "BULLISH", direction: "BUY", regime: "TRENDING",
      lifecycleStage: "ENTRY_WINDOW_OPEN", lifecycleReasons: [], confidenceBand: "STRONG", edgeScore: 72,
      scores: { overall: 73 }, evidence: { for: [], against: [], conflicts: [], meetsMinimum: true, netScore: 1 },
      freshness: "FRESH", validForSeconds: 900, expiresAt: new Date(Date.now() + 900_000).toISOString(),
      late: { isLate: false, doNotChase: false, reason: null },
    },
    explanation: {
      headline: "Buyers are in control on EURUSD", defaultMode: "SIMPLE", simple: mode, advanced: mode,
      levels: { entryZone: null, watchZone: null, lateZone: null, stopLoss: null, invalidation: null, takeProfits: [] },
      bestAction: null, noTrade: { isNoTrade: false, confidence: 0, reason: null }, hasSufficientData: true,
      actionable: false, missingContext: [], disclaimer: "Read-only market intelligence.",
    },
  };
}
const state = (data: unknown) => ({ data, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() });

beforeEach(() => { mockUseGetMeMarketEdge.mockReset(); window.localStorage.clear(); });
afterEach(() => { cleanup(); });

describe("truth fix: Market Read 'updated X ago' never anchors to a future bar close", () => {
  it("uses the observed tick time, not the forming bar's scheduled close", () => {
    truthData = {
      state: "LIVE_CONFIRMED",
      lastCandleAt: new Date(Date.now() + 50 * 60_000).toISOString(),
      lastTickAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    };
    mockUseGetMeMarketEdge.mockReturnValue(state(response()));
    render(<RubyMarketReadCard symbol="EURUSD" timeframe="1h" />);
    const text = screen.getByTestId("ruby-market-read-freshness").textContent ?? "";
    expect(text).not.toContain("updated 0s ago");
    expect(text).toMatch(/updated 5m \d+s ago/);
  });

  it("says the update time is unknown when the only stamp is a future bar close (MT5, no tick time)", () => {
    truthData = {
      state: "LIVE_CONFIRMED",
      lastCandleAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      lastTickAt: null,
    };
    mockUseGetMeMarketEdge.mockReturnValue(state(response()));
    render(<RubyMarketReadCard symbol="EURUSD" timeframe="1h" />);
    const text = screen.getByTestId("ruby-market-read-freshness").textContent ?? "";
    expect(text).not.toMatch(/updated \d+s ago/);
    expect(text).toContain("last update time not reported");
  });

  it("still reports a past observed data time as before", () => {
    truthData = {
      state: "LIVE_CONFIRMED",
      lastCandleAt: new Date(Date.now() - 30_000).toISOString(),
      lastTickAt: null,
    };
    mockUseGetMeMarketEdge.mockReturnValue(state(response()));
    render(<RubyMarketReadCard symbol="EURUSD" timeframe="1h" />);
    expect(screen.getByTestId("ruby-market-read-freshness").textContent).toMatch(/updated 3\ds ago/);
  });
});
