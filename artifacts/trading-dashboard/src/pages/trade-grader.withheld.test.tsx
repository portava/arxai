// Trade Grader: a non-privileged viewer receives the server's masked
// placeholders (maskSimulatorTradeGrade / maskSimulatorEntrySniperScore in
// artifacts/api-server/src/lib/honesty/feedTruthCopy.ts) with `withheld: true`.
// Those zeroed values ("—", 0/100, DO_NOT_ENTER, every factor 0) are not a
// grade, so the page must say nothing was graded instead of rendering them as
// a verdict against the idea.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import TradeGrader from "./trade-grader";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const WAITING = "Live market data isn't confirmed yet — analysis is hidden until a verified feed is available.";

// Exact shapes the server masks return (see feedTruthCopy.ts).
const MASKED_GRADE = {
  tradeGrade: "—", overallScore: 0, strengths: [], weaknesses: [], mistakesDetected: [],
  improvementSuggestion: WAITING, shouldHaveTakenTrade: false, dataSource: "SIMULATOR", withheld: true,
};
const MASKED_SNIPER = {
  score: 0, label: "DO_NOT_ENTER",
  factors: { proximity: 0, trendAlign: 0, stopOk: 0, rrOk: 0, spreadOk: 0, patience: 0 },
  dataSource: "SIMULATOR", withheld: true,
};

function serve(grade: unknown, sniper: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(
    JSON.stringify(String(url).includes("grade-trade") ? grade : sniper), { status: 200 })));
}

describe("Trade Grader withheld result", () => {
  it("the server masks still flag their placeholders as withheld", () => {
    const src = readFileSync(resolve(__dirname, "../../../api-server/src/lib/honesty/feedTruthCopy.ts"), "utf8");
    const grade = src.slice(src.indexOf("export function maskSimulatorTradeGrade"));
    const sniper = src.slice(src.indexOf("export function maskSimulatorEntrySniperScore"));
    expect(grade).toMatch(/overallScore: 0[\s\S]*withheld: true/);
    expect(sniper).toMatch(/label: "DO_NOT_ENTER"[\s\S]*withheld: true/);
  });

  it("a withheld grade is shown as not graded, not as a 0/100 DO_NOT_ENTER verdict", async () => {
    serve(MASKED_GRADE, MASKED_SNIPER);
    render(<TradeGrader />);
    fireEvent.click(screen.getByText("Grade this trade"));
    const card = await screen.findByTestId("trade-grader-withheld");
    expect(card.textContent).toContain("Not graded");
    expect(card.textContent).toContain(WAITING);
    const body = document.body.textContent ?? "";
    expect(body).not.toContain("should NOT take");
    expect(body).not.toContain("DO_NOT_ENTER");
    expect(body).not.toContain("/100");
    expect(body).not.toContain("Strengths");
  });

  it("a real (unmasked) grade still renders its score", async () => {
    serve(
      { tradeGrade: "B", overallScore: 72, strengths: ["RR ok"], weaknesses: [], mistakesDetected: [],
        improvementSuggestion: "Tighten stop.", shouldHaveTakenTrade: true, dataSource: "SIMULATOR" },
      { score: 64, label: "WAIT", factors: { proximity: 10 }, dataSource: "SIMULATOR" },
    );
    render(<TradeGrader />);
    fireEvent.click(screen.getByText("Grade this trade"));
    expect(await screen.findByText(/Score 72\/100/)).toBeTruthy();
    expect(screen.queryByTestId("trade-grader-withheld")).toBeNull();
  });
});
