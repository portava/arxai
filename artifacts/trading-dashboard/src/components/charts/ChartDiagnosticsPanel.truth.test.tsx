// Admin Chart Diagnostics prints what the server measured, in the server's
// units (truth upgrade, 2026-10-28).

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import type { ChartIntelligenceResponse } from "@workspace/api-client-react";
import { ChartDiagnosticsPanel } from "./ChartDiagnosticsPanel";

afterEach(() => cleanup());

type ChartState = ChartIntelligenceResponse["state"];

function state(over: { changePct?: number | null; lastCandleTime?: string | null } = {}): ChartState {
  return {
    symbol: "EURUSD",
    displaySymbol: "EURUSD",
    timeframe: "M5",
    truthState: {
      symbol: "EURUSD", displaySymbol: "EURUSD", assetClass: "forex", source: "mt5_broker", isLive: true, stale: false,
      quality: "clean", aiUsable: true, missingCandleCount: 0, duplicateCount: 0, outOfOrderCount: 0,
      invalidOhlcCount: 0, warning: null, message: "Feed nominal", latencyMs: 40,
      lastCandleTime: over.lastCandleTime ?? null,
    },
    aiUsable: true,
    stale: false,
    marketUnderstanding: {
      trend: { populated: false, regime: "range", direction: "neutral" },
      levels: { nearestSupport: null, nearestResistance: null },
      readiness: { quality: "unrated", gates: [] },
      evidence: { contradictions: [] },
    },
    decisionState: { populated: false, bias: "neutral", quality: "unrated", actionability: "unknown", vetoed: false },
    fastFlags: { populated: false, momentumBurst: false, nearRecentHigh: false, nearRecentLow: false, note: null },
    candleStats: {
      direction: "up", barsAnalyzed: 50, lastClose: 1.08523,
      // The server already returns a PERCENT: (changeAbs / prev.close) * 100.
      changePct: over.changePct === undefined ? 0.05 : over.changePct,
      range: 0.0012, atr: 0.0009, avgRange: 0.001,
    },
    marketSentences: { risk: { tone: "neutral", text: "" }, bestNextAction: { tone: "neutral", text: "" } },
    setupState: { populated: false, ageBars: null, stage: "no_setup" },
    speedState: {
      brain: "fast", stateBuildMs: 3, feedLatencyMs: 40, slowBrainBlockedLiveExecution: true,
      activeMode: "fast", slowBrainLastRunAt: null,
    },
  } as unknown as ChartState;
}

function statValue(label: string): string {
  const stats = screen.getByTestId("chart-diag-candle-stats");
  const labelEl = Array.from(stats.querySelectorAll("div")).find((d) => d.textContent === label);
  expect(labelEl, `stat ${label}`).toBeTruthy();
  return labelEl!.nextElementSibling?.textContent ?? "";
}

describe("Admin Chart Diagnostics — candle stats", () => {
  it("'Change %' prints the server's percent as-is (+0.05%, not +5.00%)", () => {
    render(<ChartDiagnosticsPanel state={state({ changePct: 0.05 })} />);
    expect(statValue("Change %")).toBe("+0.05%");
  });

  it("negative and missing changes", () => {
    render(<ChartDiagnosticsPanel state={state({ changePct: -1.25 })} />);
    expect(statValue("Change %")).toBe("-1.25%");
    cleanup();
    render(<ChartDiagnosticsPanel state={state({ changePct: null })} />);
    expect(statValue("Change %")).toBe("—");
  });
});

function diagRowValue(label: string): string {
  const block = screen.getByTestId("chart-diag-feed-summary");
  const labelEl = Array.from(block.querySelectorAll("span")).find((s) => s.textContent === label);
  expect(labelEl, `row ${label}`).toBeTruthy();
  return labelEl!.nextElementSibling?.textContent ?? "";
}

describe("Admin Chart Diagnostics — last candle time", () => {
  it("a future closeTime is the forming bar's scheduled close, not an observation", () => {
    const future = new Date(Date.now() + 4 * 60_000 + 5_000).toISOString();
    render(<ChartDiagnosticsPanel state={state({ lastCandleTime: future })} />);
    const value = diagRowValue("Last candle");
    expect(value).not.toMatch(/^in /);
    expect(value).toMatch(/^Forming bar · closes in 4m/);
  });

  it("a past closeTime still reads as an age", () => {
    const past = new Date(Date.now() - 3 * 60_000 - 5_000).toISOString();
    render(<ChartDiagnosticsPanel state={state({ lastCandleTime: past })} />);
    expect(diagRowValue("Last candle")).toMatch(/^3m ago$/);
  });
});
