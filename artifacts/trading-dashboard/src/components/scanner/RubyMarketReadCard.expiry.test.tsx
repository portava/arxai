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
const FULL_GATE = { truth: null, level: "full", isFull: true, downgraded: false, reason: null };
const mockUseScannerReadGate = vi.fn((..._args: unknown[]) => FULL_GATE as Record<string, unknown>);
vi.mock("@/hooks/useScannerReadGate", () => ({
  useScannerReadGate: (...args: unknown[]) => mockUseScannerReadGate(...args),
}));
vi.mock("@/hooks/useSymbolTruth", () => ({
  useSymbolTruth: () => ({ news: { providerConnected: true, events: [], riskLabel: "No scheduled events affect this symbol.", highImpactWindowActive: false, disclaimer: null },
    data: { state: "LIVE_CONFIRMED", lastTickAt: new Date().toISOString(), lastCandleAt: new Date().toISOString() } }),
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

beforeEach(() => {
  mockUseGetMeMarketEdge.mockReset();
  mockUseScannerReadGate.mockReset();
  mockUseScannerReadGate.mockReturnValue(FULL_GATE);
  window.localStorage.clear();
});
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

// Truth audit 2026-10-28 — an expired or gate-downgraded read withholds its
// best action and levels; the headline, feed chip, late warning, evidence,
// timing rows, edge number and reasoning Why/Structure/Momentum of that same
// dead read must not keep describing it as current.
const LIVE_OVER = {
  lifecycleStage: "ENTRY_WINDOW_OPEN",
  late: { isLate: true, doNotChase: true, reason: "~80% of the move already done" },
  evidence: {
    for: [{ label: "Higher highs / higher lows" }, { label: "Scanner agrees on direction" }],
    against: [], conflicts: [], meetsMinimum: true, netScore: 2,
  },
};
function directionalResponse(over: Record<string, unknown>) {
  const r = response({ ...LIVE_OVER, ...over });
  const live = {
    ...mode,
    whatIsHappening: "EURUSD is trending up with higher highs.",
    whyThisMarket: "This market currently shows strong edge (72/100).",
    whyNow: "Ready — the entry window is open now.",
    timingState: "Ready — the entry window is open now.",
  };
  return { ...r, explanation: { ...r.explanation, headline: "EURUSD: ready — Buy bias, strong edge.", simple: live, advanced: live } };
}
const DEAD_STATES: Array<[string, Record<string, unknown>, Record<string, unknown> | null]> = [
  ["an expired read", { expiresAt: new Date(Date.now() - 1000).toISOString() }, null],
  ["a historical-only gate", {}, { truth: null, level: "historical_only", isFull: false, downgraded: true, reason: "Historical candles only." }],
  ["a limited gate", {}, { truth: null, level: "limited", isFull: false, downgraded: true, reason: "Delayed market data." }],
];

describe("truth audit: a withheld read does not keep describing itself as current", () => {
  it("a current read still shows its headline, timing rows, late warning and evidence", () => {
    mockUseGetMeMarketEdge.mockReturnValue(state(directionalResponse({})));
    render(<RubyMarketReadCard symbol="EURUSD" timeframe="15m" />);
    expect(screen.getByTestId("ruby-market-read-headline").textContent).toContain("Buy bias");
    expect(screen.getByTestId("ruby-market-read-late")).toBeTruthy();
    expect(screen.getByTestId("ruby-market-read-evidence").textContent).toContain("Higher highs");
    expect(screen.getByTestId("ruby-market-read-body").textContent).toContain("entry window is open now");
  });

  it.each(DEAD_STATES)("%s: chip, headline and reasoning Why carry no live or directional claim", (_n, over, gate) => {
    if (gate) mockUseScannerReadGate.mockReturnValue(gate);
    mockUseGetMeMarketEdge.mockReturnValue(state(directionalResponse(over)));
    render(<RubyMarketReadCard symbol="EURUSD" timeframe="15m" />);
    const chip = screen.getByTestId("ruby-market-read-freshness");
    expect(chip.textContent).not.toContain("Live feed");
    expect(chip.className).not.toContain("text-success");
    const headline = screen.queryByTestId("ruby-market-read-headline")?.textContent ?? "";
    expect(headline).not.toMatch(/Buy bias|ready —/);
    expect(screen.getByTestId("ruby-market-read-reasoning-why").textContent).not.toContain("Buy bias");
  });

});
