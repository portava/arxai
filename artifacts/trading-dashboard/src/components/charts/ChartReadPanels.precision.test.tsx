// Chart read panels print prices at the instrument's precision and level
// personalities in plain words (truth upgrade, 2026-10-28).
//
// ChartReadPanels carried a private magnitude rule (5 dp under 10, 3 under
// 1000, else 2): a V10 support at 5123.457 read "5123.46" and an XAGUSD level
// lost its 4th digit. It also printed the raw personality token
// ("retest_pending"). The panels (and Chart Pulse before the chart has
// published its precision) now use the shared digit rule.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import type { ChartIntelligenceResponse } from "@workspace/api-client-react";
import { ChartExitPanel, ChartEntryPanel } from "./ChartReadPanels";
import { ChartPulse } from "./ChartPulse";
import { __resetChartPricePrecision, publishChartPricePrecision } from "./chartPricePrecisionStore";

type ChartState = ChartIntelligenceResponse["state"];

afterEach(() => { cleanup(); __resetChartPricePrecision(); });

function v10State(): ChartState {
  const support = { kind: "support", price: 5123.457, personality: "retest_pending", distancePct: -0.1 };
  const resistance = { kind: "resistance", price: 5140.102, personality: "trap_zone", distancePct: 0.2 };
  return {
    symbol: "V10",
    displaySymbol: "V10",
    timeframe: "M5",
    truthState: { isLive: true, stale: false, aiUsable: true, quality: "clean", message: "Feed nominal" },
    aiUsable: true,
    stale: false,
    latestClosedCandle: { open: 5130.111, high: 5131.204, low: 5129.877, close: 5130.123, isComplete: true },
    currentCandle: null,
    marketUnderstanding: {
      trend: { populated: true, regime: "trending", direction: "bullish" },
      levels: { populated: true, levels: [support, resistance], nearestSupport: support, nearestResistance: resistance },
      readiness: { quality: "C", gates: [] },
      evidence: { contradictions: [] },
    },
    decisionState: { populated: true, bias: "bullish", quality: "C", actionability: "watch", vetoed: false },
    decisionReasoning: {
      populated: true,
      improve: [{ text: "Holds support", price: 5123.457 }],
      invalidate: [{ text: "Close below support", price: 5123.457 }],
    },
    decisionFork: { populated: false, expectations: [] },
    fastFlags: { populated: true, momentumBurst: false },
    candleStats: { direction: "up" },
    marketSentences: {
      risk: { tone: "info", text: "" },
      whatInvalidates: { tone: "caution", text: "x" },
      entryTiming: { tone: "neutral", text: "x" },
      bestNextAction: { tone: "neutral", text: "x" },
    },
    setupState: { populated: false, ageBars: null, stage: "no_setup" },
    gateOutput: {
      chartTruthScore: 87, confidentReadAllowed: true, autonomousChartActionAllowed: true, tradeConfirmationAllowed: true,
    },
  } as unknown as ChartState;
}

describe("Chart read panels — instrument precision and plain level words", () => {
  it("Exit panel prints a V10 level at 3 dp and the personality in words", () => {
    render(<ChartExitPanel state={v10State()} />);
    const panel = screen.getByTestId("chart-exit-panel");
    expect(panel.textContent).toContain("5123.457");
    expect(panel.textContent).not.toContain("5123.46 ");
    expect(panel.textContent).toContain("5140.102");
    expect(panel.textContent).not.toMatch(/retest_pending|trap_zone/);
    expect(panel.textContent).toContain("waiting for a retest");
    expect(panel.textContent).toContain("possible trap zone");
    // Invalidation reasoning price too.
    expect(panel.textContent).toContain("(5123.457)");
  });

  it("uses the chart's published precision when there is one", () => {
    publishChartPricePrecision("V10", 3, {});
    render(<ChartExitPanel state={v10State()} />);
    expect(screen.getByTestId("chart-exit-panel").textContent).toContain("5123.457");
  });

  it("Chart Pulse active level falls back to the state's observed digits (Sup 5123.457, not 5123.46)", () => {
    render(<ChartPulse state={v10State()} />);
    expect(screen.getByTestId("pulse-level").textContent).toContain("Sup 5123.457");
  });

  it("Entry panel reasoning prices use the same digits", () => {
    render(<ChartEntryPanel state={v10State()} />);
    expect(screen.getByTestId("chart-entry-panel").textContent).toContain("(5123.457)");
  });
});
