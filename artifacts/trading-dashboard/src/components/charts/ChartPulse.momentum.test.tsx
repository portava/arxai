// Chart Pulse "Momentum" tile (truth upgrade, 2026-10-28).
//
// The tile was labelled "Momentum" but showed candleStats.direction — the last
// close compared with the previous close — and coloured a momentum burst by
// that same close-to-close direction, so a wide-range BEARISH bar whose close
// was still above the prior close read "Burst" in bullish green. It now says
// what it measures (the last closed bar vs the prior close) and colours a
// burst by the burst bar's own body.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import type { ChartIntelligenceResponse } from "@workspace/api-client-react";
import { ChartPulse } from "./ChartPulse";

type ChartState = ChartIntelligenceResponse["state"];

afterEach(() => cleanup());

function state(opts: {
  burst: boolean;
  flagsPopulated?: boolean;
  direction: "up" | "down" | "flat" | "unknown";
  bar?: { open: number; close: number } | null;
}): ChartState {
  const bar = opts.bar === undefined ? { open: 1.1, close: 1.101 } : opts.bar;
  return {
    symbol: "EURUSD",
    displaySymbol: "EURUSD",
    timeframe: "M5",
    truthState: { isLive: true, stale: false, aiUsable: true, quality: "clean", message: "Feed nominal" },
    aiUsable: true,
    stale: false,
    latestClosedCandle: bar ? { ...bar, high: Math.max(bar.open, bar.close) + 0.001, low: Math.min(bar.open, bar.close) - 0.001 } : null,
    currentCandle: null,
    marketUnderstanding: {
      trend: { populated: false, regime: "unknown", direction: "unknown" },
      levels: { nearestSupport: null, nearestResistance: null },
    },
    decisionState: { populated: false, bias: "unknown", quality: "unrated", actionability: "unknown", vetoed: false },
    fastFlags: { populated: opts.flagsPopulated ?? true, momentumBurst: opts.burst },
    candleStats: { direction: opts.direction },
    marketSentences: { risk: { tone: "info", text: "" }, bestNextAction: { tone: "neutral", text: "x" } },
    setupState: { populated: false, ageBars: null, stage: "no_setup" },
    gateOutput: { chartTruthScore: 87, confidentReadAllowed: true, autonomousChartActionAllowed: true, tradeConfirmationAllowed: true },
  } as unknown as ChartState;
}

describe("Chart Pulse last-bar tile", () => {
  it("is not labelled 'Momentum' for a one-bar close comparison", () => {
    render(<ChartPulse state={state({ burst: false, direction: "up" })} />);
    const tile = screen.getByTestId("pulse-momentum");
    expect(tile.textContent).not.toMatch(/^Momentum/);
    expect(tile.textContent).toContain("Last bar");
    expect(tile.textContent).toContain("Up vs prior close");
  });

  it("a bearish burst bar that still closed above the prior close is coloured bearish", () => {
    // close < open (bearish body) while close > previous close (direction "up").
    render(<ChartPulse state={state({ burst: true, direction: "up", bar: { open: 1.105, close: 1.101 } })} />);
    const tile = screen.getByTestId("pulse-momentum");
    expect(tile.textContent).toMatch(/Wide-range bar/);
    expect(tile.textContent).toMatch(/bearish/i);
    expect(tile.className).toMatch(/rose/);
    expect(tile.className).not.toMatch(/emerald/);
  });

  it("a bullish burst bar is coloured bullish", () => {
    render(<ChartPulse state={state({ burst: true, direction: "down", bar: { open: 1.1, close: 1.104 } })} />);
    const tile = screen.getByTestId("pulse-momentum");
    expect(tile.className).toMatch(/emerald/);
  });

  it("with too few bars for fast flags it says burst detection is not available", () => {
    render(<ChartPulse state={state({ burst: false, flagsPopulated: false, direction: "down" })} />);
    const tile = screen.getByTestId("pulse-momentum");
    expect(tile.textContent).toContain("Down vs prior close");
    expect(tile.getAttribute("title")).toMatch(/not enough closed bars/i);
  });
});
