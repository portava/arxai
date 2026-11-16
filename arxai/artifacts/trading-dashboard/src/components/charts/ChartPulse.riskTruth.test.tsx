// Chart Pulse "Risk" chip: "Normal" only for the server's all-clear risk read
// (tone "info"). A risk sentence that assessed nothing ("Risk not assessed",
// tone "neutral") or an unknown tone is "Not assessed", never "Normal".

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import type { ChartIntelligenceResponse } from "@workspace/api-client-react";
import { ChartPulse } from "./ChartPulse";

afterEach(() => cleanup());

type ChartState = ChartIntelligenceResponse["state"];

function pulseState(risk: { tone: string; text: string }): ChartState {
  return {
    symbol: "EURUSD", displaySymbol: "EURUSD", timeframe: "M5",
    truthState: { symbol: "EURUSD", displaySymbol: "EURUSD", assetClass: "forex", source: "mt5_broker", isLive: true,
      stale: false, quality: "clean", aiUsable: true, missingCandleCount: 0, duplicateCount: 0, outOfOrderCount: 0,
      invalidOhlcCount: 0, warning: null, message: "live" },
    aiUsable: true, stale: false,
    marketUnderstanding: {
      trend: { populated: false, regime: "range", direction: "neutral" },
      levels: { nearestSupport: null, nearestResistance: null },
    },
    decisionState: { populated: false, bias: "neutral", quality: "—", actionability: "wait", vetoed: false },
    fastFlags: { momentumBurst: false },
    candleStats: { direction: "flat" },
    marketSentences: { risk, bestNextAction: { tone: "neutral", text: "Wait." } },
    setupState: { populated: false, ageBars: null, stage: "none" },
  } as unknown as ChartState;
}

describe("Chart Pulse risk chip", () => {
  it("does not call an unassessed risk 'Normal'", () => {
    render(<ChartPulse state={pulseState({ tone: "neutral",
      text: "Risk not assessed — there isn't enough clean data on EURUSD M5 to read the market yet." })} />);
    const chip = screen.getByTestId("pulse-risk");
    expect(chip.textContent).not.toMatch(/Normal/);
    expect(chip.textContent).toMatch(/Not assessed/);
  });

  it("keeps the server's verdicts for real reads", () => {
    for (const [tone, value] of [["info", "Normal"], ["caution", "Elevated"], ["danger", "High"]] as const) {
      render(<ChartPulse state={pulseState({ tone, text: "x" })} />);
      expect(screen.getByTestId("pulse-risk").textContent).toMatch(new RegExp(value));
      cleanup();
    }
  });
});
