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

// Every candle-data check Ruby's handshake reads, measured and passing
// (a bound broker quote). `unmeasured` leaves those keys without evidence.
const SOURCE_KEYS = ["ohlc_integrity", "source_authenticity", "timeframe_accuracy", "symbol_mirror_accuracy",
  "historical_live_merge", "feed_freshness", "price_precision"];
function truthScore(score: number, unmeasured: string[] = []) {
  const subMetrics = [...SOURCE_KEYS, "render_accuracy", "scale_quality", "interaction_stability"].map((key) => {
    const measured = SOURCE_KEYS.includes(key) && !unmeasured.includes(key);
    return { key, label: key, weight: 0.1, rawScore: measured ? 100 : null, weightedScore: measured ? 10 : null,
      evidenceStatus: measured ? "measured" : "unavailable", detail: "fixture" };
  });
  return { score, label: score >= 75 ? "Verified" : "Degraded", subMetrics, evidenceCoverage: 0.87,
    unmeasuredKeys: subMetrics.filter((m) => m.evidenceStatus !== "measured").map((m) => m.key), primaryConcern: null, note: "fixture" };
}

// A clean, non-stale feed with an A-grade setup. `actionability` is what the
// server sent (an older/uncapped server can still send "ready").
function state(g: ReturnType<typeof gate> | undefined, actionability = "ready", isLive = true,
  score: ReturnType<typeof truthScore> = truthScore(g?.chartTruthScore ?? 0)): ChartState {
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
    chartTruthScore: score,
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

  // Truth: with no bound broker quote the broker comparison is unmeasured, so
  // a clean feed scores exactly 75 and the gate opens — but Ruby's handshake
  // needs that check measured and answers "syncing". Pulse must agree.
  it("Chart Truth exactly 75 with the broker comparison unmeasured is not 'Ready'", () => {
    render(<ChartPulse state={state(gate(75), "ready", true, truthScore(75, ["symbol_mirror_accuracy"]))} />);
    const readiness = screen.getByTestId("pulse-readiness");
    expect(readiness.textContent).not.toContain("Ready");
    expect(readiness.className).not.toMatch(/emerald/);
    expect(screen.getByTestId("chart-pulse-unverified").textContent).toContain("the broker price comparison was not measured");
  });

  it("candles that are not real OHLC, or a feed that is not clean, are not verified", () => {
    render(<ChartPulse state={state(gate(87, { candlestickModeAllowed: false }))} />);
    expect(screen.getByTestId("chart-pulse-unverified").textContent).toContain("the provider does not deliver real OHLC candles");
    cleanup();
    const delayed = state(gate(87));
    (delayed as unknown as { truthState: Record<string, unknown> }).truthState = {
      ...(delayed as unknown as { truthState: Record<string, unknown> }).truthState, quality: "delayed", aiUsable: false };
    render(<ChartPulse state={delayed} />);
    expect(screen.getByTestId("pulse-readiness").textContent).not.toContain("Ready");
    expect(screen.getByTestId("chart-pulse-unverified").textContent).toContain("the candle feed is delayed");
  });

  // Truth: a merge-seam failure (the chart's own history/live join) also
  // closes trade confirmation; with no broker quote it was reported as a
  // failed broker-mirror check that never ran.
  it("a merge-seam failure is named as such, not as a failed broker comparison", () => {
    render(<ChartPulse state={state(gate(87, { tradeConfirmationAllowed: false,
      blockedReasons: ["Merge-seam integrity failed — chart-based trade confirmation blocked."] }))} />);
    const banner = screen.getByTestId("chart-pulse-unverified").textContent ?? "";
    expect(banner).not.toMatch(/broker-mirror/i);
    expect(banner).toContain("the chart's history and live bars do not join cleanly");
  });

  it("failed mirror and missing gate are not verified", () => {
    render(<ChartPulse state={state(gate(87, { tradeConfirmationAllowed: false,
      blockedReasons: ["Broker price alignment failed — chart-based trade confirmation blocked."] }))} />);
    expect(screen.getByTestId("chart-pulse-unverified").textContent).toMatch(/broker-mirror check failed/i);
    cleanup();
    render(<ChartPulse state={state(undefined)} />);
    expect(screen.getByTestId("pulse-readiness").textContent).not.toContain("Ready");
    expect(screen.getByTestId("chart-pulse-unverified").textContent).toMatch(/could not be loaded/i);
  });
});
