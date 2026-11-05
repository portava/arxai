// Digit rule for the Smart Chart side panels (truth upgrade, 2026-10-28).
//
// Chart Pulse, Admin Diagnostics and the open-position legend each carried a
// private magnitude rule (5 dp under 10, 3 under 1000, else 2), so a V75 quote
// the axis prints as 33588.0069 read "Res 33588.01" in the Pulse, "Latest price
// 33588.01" in Diagnostics and "@ 33588.01" on the position row. They now print
// with the precision the chart resolved for the same symbol (published by
// ARXNativeChart through chartPricePrecisionStore) via formatInstrumentPrice.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen, act } from "@testing-library/react";
import type { ChartIntelligenceResponse } from "@workspace/api-client-react";
import { ChartPulse } from "./ChartPulse";
import { ChartDiagnosticsPanel } from "./ChartDiagnosticsPanel";
import { ChartPositionOverlayPanel } from "./ChartPositionOverlayPanel";
import { __resetChartPricePrecision, publishChartPricePrecision } from "./chartPricePrecisionStore";
import type { UseLivePositionOverlaysResult } from "@/hooks/useLivePositionOverlays";

type ChartState = ChartIntelligenceResponse["state"];
const OWNER = {};

afterEach(() => { cleanup(); __resetChartPricePrecision(); });

function state(): ChartState {
  return {
    symbol: "V75",
    displaySymbol: "V75",
    timeframe: "M5",
    truthState: {
      symbol: "V75", displaySymbol: "V75", assetClass: "synthetic", source: "deriv", isLive: true, stale: false,
      quality: "clean", aiUsable: true, missingCandleCount: 0, duplicateCount: 0, outOfOrderCount: 0,
      invalidOhlcCount: 0, warning: null, message: "Feed nominal", latencyMs: 40, lastCandleTime: null,
    },
    aiUsable: true,
    stale: false,
    marketUnderstanding: {
      trend: { populated: false, regime: "range", direction: "neutral" },
      levels: { nearestSupport: null, nearestResistance: { kind: "resistance", price: 33588.0069, distancePct: 0.1 } },
      readiness: { quality: "low", gates: [] },
      evidence: { contradictions: [] },
    },
    decisionState: { populated: false, bias: "neutral", quality: "—", actionability: "wait", vetoed: false },
    fastFlags: { populated: false, momentumBurst: false, nearRecentHigh: false, nearRecentLow: false, note: null },
    candleStats: {
      direction: "flat", barsAnalyzed: 120, lastClose: 33588.0069, changePct: 0.001,
      range: 12.3456, atr: 3.21, avgRange: 2.5,
    },
    marketSentences: {
      risk: { tone: "neutral", text: "" },
      bestNextAction: { tone: "neutral", text: "Wait." },
    },
    setupState: { populated: false, ageBars: null, stage: "none" },
    speedState: {
      brain: "fast", stateBuildMs: 3, feedLatencyMs: 40, slowBrainBlockedLiveExecution: true,
      activeMode: "fast", slowBrainLastRunAt: null,
    },
  } as unknown as ChartState;
}

function positions(): UseLivePositionOverlaysResult {
  return {
    overlays: [],
    positions: [{
      brokerTicket: "1", accountMode: "demo", side: "BUY", lotSize: 0.1,
      entryPrice: 33588.0069, stopLoss: 33550.5, takeProfit: 33650.25, floatingPnl: null,
    }],
    canTrade: false, busyTicket: null, noTradeReason: null, closePosition: async () => {},
  } as unknown as UseLivePositionOverlaysResult;
}

describe("chart side panels print prices at the chart's resolved precision", () => {
  it("Chart Pulse prints the active level at the published precision", () => {
    publishChartPricePrecision("V75", 4, OWNER);
    render(<ChartPulse state={state()} />);
    expect(screen.getByTestId("pulse-level").textContent).toContain("Res 33588.0069");
  });

  it("Admin Diagnostics prints the latest price and ranges at the published precision", () => {
    publishChartPricePrecision("V75", 4, OWNER);
    render(<ChartDiagnosticsPanel state={state()} />);
    const feed = screen.getByTestId("chart-diag-feed-summary").textContent ?? "";
    expect(feed).toContain("33588.0069");
    const stats = screen.getByTestId("chart-diag-candle-stats").textContent ?? "";
    expect(stats).toContain("12.3456");
    expect(stats).toContain("3.2100");
  });

  it("the open-position legend prints entry, SL and TP at the published precision", () => {
    publishChartPricePrecision("V75", 4, OWNER);
    render(<ChartPositionOverlayPanel symbol="V75" data={positions()} />);
    const row = screen.getByTestId("chart-position-row").textContent ?? "";
    expect(row).toContain("@ 33588.0069");
    expect(row).toContain("SL 33550.5000");
    expect(row).toContain("TP 33650.2500");
  });

  it("follows the chart when it re-resolves the precision", () => {
    publishChartPricePrecision("V75", 4, OWNER);
    render(<ChartPulse state={state()} />);
    act(() => { publishChartPricePrecision("V75", 2, OWNER); });
    expect(screen.getByTestId("pulse-level").textContent).toContain("Res 33588.01");
  });

  it("a chart for another symbol does not set this symbol's digits", () => {
    publishChartPricePrecision("EURUSD", 5, OWNER);
    render(<ChartPositionOverlayPanel symbol="V75" data={positions()} />);
    expect(screen.getByTestId("chart-position-row").textContent).toContain("@ 33588.01");
  });
});
