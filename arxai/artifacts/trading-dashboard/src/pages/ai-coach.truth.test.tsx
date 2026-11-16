// AI Coach: "Suggested rule changes" says plainly when the journal supports
// none, instead of an empty heading (the server no longer sends constants).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AiCoach from "./ai-coach";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function serve(rules: string[]) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    doingWell: "ok", doingPoorly: "ok", bestStrategy: "a", worstStrategy: "a",
    bestSymbol: "EURUSD", weakestSymbol: "EURUSD", mostCommonMistake: "none",
    recommendedFocus: "focus", suggestedRuleChanges: rules,
    confidenceCalibration: "Sample size too small.", dataSource: "SIMULATOR",
    generatedAt: "2026-10-28T10:00:00.000Z",
  }), { status: 200 })));
}

describe("AI Coach rule suggestions", () => {
  it("no suggestions: says why instead of an empty list", async () => {
    serve([]);
    render(<AiCoach />);
    const empty = await screen.findByTestId("coach-rules-empty");
    expect(empty.textContent).toMatch(/No rule change suggested/);
  });

  it("journal-derived suggestions are listed under a heading that names the journal", async () => {
    serve(['Pause "breakout" — net -55.00 across 2 journal entries.']);
    render(<AiCoach />);
    const list = await screen.findByTestId("coach-rules");
    expect(list.textContent).toContain('Pause "breakout"');
    expect(document.body.textContent).toContain("Suggested rule changes (from your journal)");
  });
});
