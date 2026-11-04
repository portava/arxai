import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// GET /api/ai/coach-summary answers a trader with no journal rows with
// isEmpty:true and placeholder sentences (aiBrain.ts). The page used to pour
// those sentences into the green "What is working" / red "What is not
// working" scorecard and print "none" as the most common mistake, as if the
// journal had been scored.

const { default: AiCoach } = await import("./ai-coach");

// The exact empty payload the real route returns.
const emptyPayload = {
  isEmpty: true,
  doingWell: "Not enough journal data yet — log a few paper trades to build your scorecard.",
  doingPoorly: "Not enough journal data yet.",
  bestStrategy: null, worstStrategy: null,
  bestSymbol: null, weakestSymbol: null,
  mostCommonMistake: "none",
  recommendedFocus: "Place a paper trade and add a journal note to begin.",
  suggestedRuleChanges: [],
  confidenceCalibration: "No trades yet — confidence cannot be calibrated.",
  dataSource: "JOURNAL",
  perUserScoped: true,
  generatedAt: new Date().toISOString(),
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("AI Coach — empty journal", () => {
  it("shows a plain empty state, not the scorecard", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => emptyPayload })));
    render(<AiCoach />);
    expect(await screen.findByText(/No journal entries to score yet/)).toBeTruthy();
    expect(screen.queryByText(/What is working/)).toBeNull();
    expect(screen.queryByText(/What is not working/)).toBeNull();
    expect(screen.queryByText(/Most common mistake/)).toBeNull();
    expect(screen.queryByText(/Best strategy/)).toBeNull();
    // The server's own next step is still shown.
    expect(screen.getByText(/Place a paper trade and add a journal note to begin/)).toBeTruthy();
  });

  it("never prints the literal 'none' as a scored mistake when no mistake tag was recorded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({
      ...emptyPayload, isEmpty: undefined,
      doingWell: "Win rate 67% across 3 journal trades with a recorded P/L — keep the same selection criteria.",
      doingPoorly: "No clear pattern of mistakes yet — log more trades.",
      bestStrategy: "Breakout", worstStrategy: "Breakout", bestSymbol: "EURUSD", weakestSymbol: "EURUSD",
    }) })));
    render(<AiCoach />);
    expect(await screen.findByText(/What is working/)).toBeTruthy();
    expect(screen.getByText(/No mistake tags recorded/)).toBeTruthy();
    expect(screen.queryByText(/^none$/)).toBeNull();
  });
});
