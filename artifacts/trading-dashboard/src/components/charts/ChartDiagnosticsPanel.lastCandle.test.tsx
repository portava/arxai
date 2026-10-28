// Truth audit 2026-10-28 (round 3) — the chart's lastCandleTime is the
// forming bar's SCHEDULED close, which is in the future. relativeTime prints
// future stamps as "in 12m"; the feed badge wraps that as "Forming bar ·
// closes in 12m", but Admin Diagnostics printed "Last candle: in 12m", as if a
// candle would arrive in 12 minutes. Both consumers now say the same thing.
import { afterEach, describe, expect, it } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import type { ChartIntelligenceResponse } from "@workspace/api-client-react";
import { ChartDiagnosticsPanel } from "./ChartDiagnosticsPanel";
import { __resetChartPricePrecision } from "./chartPricePrecisionStore";

type ChartState = ChartIntelligenceResponse["state"];

afterEach(() => { cleanup(); __resetChartPricePrecision(); });

function state(lastCandleTime: string | null): ChartState {
  return {
    symbol: "V75",
    displaySymbol: "V75",
    timeframe: "M5",
    truthState: {
      symbol: "V75", displaySymbol: "V75", assetClass: "synthetic", source: "deriv", isLive: true, stale: false,
      quality: "clean", aiUsable: true, missingCandleCount: 0, duplicateCount: 0, outOfOrderCount: 0,
      invalidOhlcCount: 0, warning: null, message: "Feed nominal", latencyMs: 40, lastCandleTime,
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

function lastCandleRow(): string {
  const label = screen.getByText("Last candle");
  return label.parentElement?.textContent ?? "";
}

describe("Admin Diagnostics — Last candle", () => {
  it("a future stamp is the forming bar's scheduled close, not a candle arriving 'in 12m'", () => {
    render(<ChartDiagnosticsPanel state={state(new Date(Date.now() + 12 * 60_000 + 20_000).toISOString())} />);
    const row = lastCandleRow();
    expect(row).toMatch(/Forming bar · closes in 12m/);
    expect(row).not.toMatch(/Last candle\s*in /);
  });

  it("a past stamp still reads as an age", () => {
    render(<ChartDiagnosticsPanel state={state(new Date(Date.now() - 5 * 60_000 - 20_000).toISOString())} />);
    expect(lastCandleRow()).toMatch(/5m ago/);
    expect(lastCandleRow()).not.toMatch(/Forming bar/);
  });

  it("no stamp reads as unknown", () => {
    render(<ChartDiagnosticsPanel state={state(null)} />);
    expect(lastCandleRow()).toContain("—");
  });
});
