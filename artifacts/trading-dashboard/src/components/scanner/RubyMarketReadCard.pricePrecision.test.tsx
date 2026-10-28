// Truth fix — the Market Read card printed its Levels cells at the instrument's
// display precision (1.08523) while the Ruby reasoning block in the SAME card
// printed the same stop with a separate 4-dp magnitude rule ("stop 1.0852"),
// rounding away the broker's last digit. One level, one string.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mockUseGetMeMarketEdge = vi.fn();
let pricePrecision: number | null = 5;
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
    data: { state: "LIVE_CONFIRMED", lastTickAt: new Date().toISOString(), lastCandleAt: new Date().toISOString() },
    scannerTruth: { candles: { pricePrecision } },
  }),
}));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));

import { RubyMarketReadCard } from "./RubyMarketReadCard";

const mode = {
  whatIsHappening: "x", why: "x", whyThisMarket: "x", whyThisDirection: "x", whyNow: "x", timingState: "x",
  entryZone: "x", risk: "x", whatConfirms: "", whatInvalidates: "", whatToDoNext: "",
};
function response() {
  return {
    signal: {
      symbol: "EURUSD", displayName: "EURUSD", timeframe: "M15", assetClass: "forex", generatedAt: new Date(Date.now() - 5_000).toISOString(),
      dataSource: "LIVE_FEED", hasSufficientData: true, bias: "BULLISH", direction: "BUY", regime: "TRENDING",
      lifecycleStage: "ENTRY_WINDOW_OPEN", lifecycleReasons: [], confidenceBand: "STRONG", edgeScore: 72,
      scores: { overall: 73 }, evidence: { for: [], against: [], conflicts: [], meetsMinimum: true, netScore: 1 },
      freshness: "FRESH", validForSeconds: 900, expiresAt: new Date(Date.now() + 900_000).toISOString(),
      late: { isLate: false, doNotChase: false, reason: null },
    },
    explanation: {
      headline: "Buyers are in control on EURUSD", defaultMode: "SIMPLE", simple: mode, advanced: mode,
      levels: { entryZone: { from: 1.08551, to: 1.08562 }, watchZone: null, lateZone: null, stopLoss: 1.08523, invalidation: 1.08487, takeProfits: [{ from: 1.08801, to: 1.08853 }] },
      bestAction: "Consider a buy into the marked zone and manage to the stop.",
      noTrade: { isNoTrade: false, confidence: 0, reason: null }, hasSufficientData: true, actionable: true, missingContext: [],
      disclaimer: "Read-only market intelligence.",
    },
  };
}

beforeEach(() => { mockUseGetMeMarketEdge.mockReset(); window.localStorage.clear(); });
afterEach(() => cleanup());

describe("truth fix: Market Read levels print identically in the cells and the reasoning block", () => {
  it.each([[5], [null]])("pricePrecision %s: reasoning stop/invalidation match the Levels cells", (p) => {
    pricePrecision = p;
    mockUseGetMeMarketEdge.mockReturnValue({ data: response(), isLoading: false, isFetching: false, isError: false, refetch: vi.fn() });
    render(<RubyMarketReadCard symbol="EURUSD" timeframe="15m" />);
    fireEvent.click(screen.getByText("Levels"));
    const card = screen.getByTestId("ruby-market-read").textContent ?? "";
    expect(card).toContain("1.08523");
    const reasoning = screen.getByTestId("ruby-market-read-reasoning").textContent ?? "";
    expect(reasoning).toMatch(/stop 1\.08523\b/);
    expect(reasoning).toMatch(/invalidation 1\.08487\b/);
    expect(reasoning).toMatch(/entry 1\.08551 – 1\.08562\b/);
    expect(reasoning).toMatch(/Mark 1\.08487 on the chart/);
  });

  it("a JPY-class level keeps its third decimal in the reasoning block", () => {
    pricePrecision = 3;
    const r = response();
    r.explanation.levels = { ...r.explanation.levels, entryZone: { from: 150.121, to: 150.125 }, stopLoss: 149.987, invalidation: 149.951, takeProfits: [] };
    mockUseGetMeMarketEdge.mockReturnValue({ data: r, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() });
    render(<RubyMarketReadCard symbol="USDJPY" timeframe="15m" />);
    const reasoning = screen.getByTestId("ruby-market-read-reasoning").textContent ?? "";
    expect(reasoning).toMatch(/stop 149\.987\b/);
    expect(reasoning).toMatch(/entry 150\.121 – 150\.125\b/);
  });
});
