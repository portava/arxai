import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// The AI Coach aggregates the trader's own Trade Journal rows (real, demo or
// paper trades the trader typed in). The page used to print a literal
// "SIMULATOR" badge whatever the server said.

const { default: AiCoach } = await import("./ai-coach");

function stubFetch(body: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => body })));
}

const summary = {
  doingWell: "Win rate 67% across 3 journal trades with a recorded P/L — keep the same selection criteria.",
  doingPoorly: "No clear pattern of mistakes yet — log more trades.",
  bestStrategy: "Breakout", worstStrategy: "Breakout", bestSymbol: "EURUSD", weakestSymbol: "EURUSD",
  mostCommonMistake: "none", recommendedFocus: "x", suggestedRuleChanges: [],
  confidenceCalibration: "Sample size too small — confidence numbers are not yet calibrated.",
  dataSource: "JOURNAL", generatedAt: new Date().toISOString(),
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("AI Coach — data source label", () => {
  it("names the trade journal as the source, never a literal SIMULATOR badge", async () => {
    stubFetch(summary);
    render(<AiCoach />);
    expect((await screen.findAllByText(/Your trade journal/)).length).toBeGreaterThan(0);
    expect(screen.queryByText("SIMULATOR")).toBeNull();
    expect(document.body.textContent).not.toMatch(/SIMULATOR/);
  });

  it("shows no source badge before a response arrives", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    render(<AiCoach />);
    expect(screen.queryByText("SIMULATOR")).toBeNull();
    expect(screen.queryByText(/Your trade journal/)).toBeNull();
  });
});
