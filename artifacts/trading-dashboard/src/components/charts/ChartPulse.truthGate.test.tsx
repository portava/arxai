// Chart Pulse must not say "Ready" on a read the chart-truth gate has not
// verified (truth upgrade, 2026-10-28).
//
// Readiness quality comes from the candle engines, which only check that the
// feed is AI-usable and not stale. The chart-truth gate (Chart Truth ≥ 75,
// feed not stale, broker mirror not failed) is a separate verdict, and the
// Ruby panel on the same board answers "Chart data is syncing…" when it is
// closed. The server now caps such a summary at "watch"; the Pulse may only
// downgrade further, and it says why the read is not verified.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import type { ChartIntelligenceResponse } from "@workspace/api-client-react";
import { ChartPulse } from "./ChartPulse";

afterEach(() => cleanup());

type ChartState = ChartIntelligenceResponse["state"];

function gate(truth: number, over: Record<string, unknown> = {}) {
  const ok = truth >= 75;
  return {
    chartTruthScore: truth, chartReadScore: 90, truthLabel: ok ? "Verified" : "Degraded", readLabel: "Readable",
    confidentReadAllowed: ok, scannerConfirmAllowed: ok, selfTradeChartAllowed: ok, candlestickModeAllowed: true,
    autonomousChartActionAllowed: true, tradeConfirmationAllowed: true,
    blockedReasons: ok ? [] : [`Chart Truth Score ${truth} < 75 (Degraded) — chart-based confirmation blocked.`],
    primaryBlockReason: ok ? null : `Chart Truth Score ${truth} < 75 (Degraded) — chart-based confirmation blocked.`,
    note: "fixture", ...over,
  };
}

// A clean, non-stale feed with an A-grade setup. `actionability` is what the
// server sent (an older/uncapped server can still send "ready").
function state(g: ReturnType<typeof gate> | undefined, actionability = "ready", isLive = true): ChartState {
  return {
    symbol: "EURUSD",
    displaySymbol: "EURUSD",
    timeframe: "M5",
    truthState: {
      symbol: "EURUSD", displaySymbol: "EURUSD", assetClass: "forex", source: "mt5_broker", isLive, stale: false,
      quality: "clean", aiUsable: true, missingCandleCount: 0, duplicateCount: 0, outOfOrderCount: 0,
      invalidOhlcCount: 0, warning: null, message: "Feed nominal",
    },
    aiUsable: true,
    stale: false,
    marketUnderstanding: {
      trend: { populated: true, regime: "trending", direction: "bullish" },
      levels: { nearestSupport: null, nearestResistance: null },
    },
    decisionState: { populated: true, bias: "bullish", quality: "A", actionability, vetoed: false },
    fastFlags: { populated: true, momentumBurst: false },
    candleStats: { direction: "up" },
    marketSentences: {
      risk: { tone: "info", text: "Risk looks normal." },
      bestNextAction: { tone: "caution", text: "Best action: watch only — this read is not verified." },
    },
    setupState: { populated: true, ageBars: 2, stage: "entry_valid" },
    gateOutput: g,
  } as unknown as ChartState;
}

describe("Chart Pulse readiness respects the chart-truth gate", () => {
  it("verified read: 'A · Ready' in bullish tone, no unverified banner", () => {
    render(<ChartPulse state={state(gate(87))} />);
    expect(screen.getByTestId("pulse-readiness").textContent).toContain("A · Ready");
    expect(screen.getByTestId("pulse-readiness").className).toMatch(/emerald/);
    expect(screen.queryByTestId("chart-pulse-unverified")).toBeNull();
  });

  it("Chart Truth 70: never 'Ready', not bullish, and a banner says why", () => {
    render(<ChartPulse state={state(gate(70))} />);
    const readiness = screen.getByTestId("pulse-readiness");
    expect(readiness.textContent).not.toContain("Ready");
    expect(readiness.textContent).toContain("A · Watch");
    expect(readiness.className).not.toMatch(/emerald/);
    const banner = screen.getByTestId("chart-pulse-unverified");
    expect(banner.textContent).toContain("Chart Truth 70/100 (needs 75)");
    expect(banner.textContent).toMatch(/not verified/i);
  });

  it("a server-capped 'watch' shows as watch with the same banner", () => {
    render(<ChartPulse state={state(gate(70), "watch")} />);
    expect(screen.getByTestId("pulse-readiness").textContent).toContain("A · Watch");
    expect(screen.getByTestId("chart-pulse-unverified")).toBeTruthy();
  });

  it("a feed that is not live cannot show 'Ready' either", () => {
    render(<ChartPulse state={state(gate(87), "ready", false)} />);
    expect(screen.getByTestId("pulse-readiness").textContent).not.toContain("Ready");
    expect(screen.getByTestId("chart-pulse-unverified").textContent).toMatch(/feed is not live/i);
  });

  it("failed mirror and missing gate are not verified", () => {
    render(<ChartPulse state={state(gate(87, { tradeConfirmationAllowed: false }))} />);
    expect(screen.getByTestId("chart-pulse-unverified").textContent).toMatch(/broker-mirror check failed/i);
    cleanup();
    render(<ChartPulse state={state(undefined)} />);
    expect(screen.getByTestId("pulse-readiness").textContent).not.toContain("Ready");
    expect(screen.getByTestId("chart-pulse-unverified").textContent).toMatch(/could not be loaded/i);
  });
});
