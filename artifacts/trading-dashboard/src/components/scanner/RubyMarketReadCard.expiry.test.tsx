// Truth audit 2026-10-27 — the Ruby Market Read card fetches /me/market-edge
// once (no polling, no refetch on focus). A read whose own lifetime has ended
// must not keep presenting its best action, levels, stage and bias as current
// just because the chart feed is still live.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const mockUseGetMeMarketEdge = vi.fn();
vi.mock("@workspace/api-client-react", () => ({
  useGetMeMarketEdge: (...args: unknown[]) => mockUseGetMeMarketEdge(...args),
  getGetMeMarketEdgeQueryKey: () => ["get-me-market-edge"],
}));
vi.mock("@/components/scanner/ScannerReadGate", () => ({ ScannerReadGate: () => null }));
vi.mock("@/hooks/useScannerReadGate", () => ({
  useScannerReadGate: () => ({ truth: null, level: "full", isFull: true, downgraded: false, reason: null }),
}));
vi.mock("@/hooks/useSymbolTruth", () => ({
  useSymbolTruth: () => ({ news: { providerConnected: true, events: [], riskLabel: "No scheduled events affect this symbol.", highImpactWindowActive: false, disclaimer: null },
    data: { lastTickAt: new Date().toISOString(), lastCandleAt: new Date().toISOString() } }),
}));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));

import { RubyMarketReadCard } from "./RubyMarketReadCard";

const mode = {
  whatIsHappening: "Price is pressing higher", why: "Trend and momentum agree", whyThisMarket: "Cleanest pair",
  whyThisDirection: "Structure favours buyers", whyNow: "Pullback completed", timingState: "Entry window open",
  entryZone: "Buy into the zone", risk: "Stop below the swing", whatConfirms: "Higher low holds",
  whatInvalidates: "Close below the zone", whatToDoNext: "Manage to the stop",
};
function response(signalOver: Record<string, unknown>) {
  return {
    signal: {
      symbol: "EURUSD", displayName: "EURUSD", timeframe: "M15", assetClass: "forex", generatedAt: new Date(Date.now() - 5_000).toISOString(),
      dataSource: "LIVE_FEED", hasSufficientData: true, bias: "BULLISH", direction: "BUY", regime: "TRENDING",
      lifecycleStage: "ENTRY_WINDOW_OPEN", lifecycleReasons: [], confidenceBand: "STRONG", edgeScore: 72,
      scores: { overall: 73 }, evidence: { for: [], against: [], conflicts: [], meetsMinimum: true, netScore: 1 },
      freshness: "FRESH", validForSeconds: 900, expiresAt: new Date(Date.now() + 900_000).toISOString(),
      late: { isLate: false, doNotChase: false, reason: null }, ...signalOver,
    },
    explanation: {
      headline: "Buyers are in control on EURUSD", defaultMode: "SIMPLE", simple: mode, advanced: mode,
      levels: { entryZone: { from: 1.085, to: 1.0855 }, watchZone: null, lateZone: null, stopLoss: 1.083, invalidation: 1.0825, takeProfits: [{ from: 1.088, to: 1.0885 }] },
      bestAction: "Consider a buy into the marked zone and manage to the stop.",
      noTrade: { isNoTrade: false, confidence: 0, reason: null }, hasSufficientData: true, actionable: true, missingContext: [],
      disclaimer: "Read-only market intelligence.",
    },
  };
}
const state = (data: unknown) => ({ data, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() });

beforeEach(() => { mockUseGetMeMarketEdge.mockReset(); window.localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("truth audit: Ruby market read lifetime", () => {
  it("keeps a current read actionable", () => {
    mockUseGetMeMarketEdge.mockReturnValue(state(response({})));
    render(<RubyMarketReadCard symbol="EURUSD" timeframe="15m" />);
    expect(screen.getByTestId("ruby-market-read-best-action")).toBeTruthy();
    expect(screen.getByTestId("ruby-market-read-bias").textContent).toContain("Bullish");
  });
  it.each([
    ["past expiresAt", { expiresAt: new Date(Date.now() - 1).toISOString() }],
    ["missing expiresAt", { expiresAt: undefined }],
    ["malformed expiresAt", { expiresAt: "not-a-date" }],
    ["EXPIRED freshness", { freshness: "EXPIRED" }],
    ["EXPIRED lifecycle", { lifecycleStage: "EXPIRED" }],
  ])("withholds best action, bias, stage and levels on %s", (_name, over) => {
    mockUseGetMeMarketEdge.mockReturnValue(state(response(over)));
    render(<RubyMarketReadCard symbol="EURUSD" timeframe="15m" />);
    expect(screen.queryByTestId("ruby-market-read-best-action")).toBeNull();
    expect(screen.queryByText("Levels")).toBeNull();
    expect(screen.getByTestId("ruby-market-read-bias").textContent).not.toContain("Bullish");
    expect(screen.getByTestId("ruby-market-read-stage").textContent).not.toContain("Entry window open");
  });
  it("withdraws the advice at expiry while the page stays idle", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const now = Date.parse("2026-10-27T14:00:00.000Z"); vi.setSystemTime(now);
    mockUseGetMeMarketEdge.mockReturnValue(state(response({ generatedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString() })));
    render(<RubyMarketReadCard symbol="EURUSD" timeframe="15m" />);
    expect(screen.getByTestId("ruby-market-read-best-action")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(60_001); });
    expect(screen.queryByTestId("ruby-market-read-best-action")).toBeNull();
  });
});
