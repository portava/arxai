// Trade plan review label truth.
//
// The plan's aiSummary is produced by summarizePlan (lib/domain trade-plan),
// a fixed rule-based string that restates the user's own inputs and the
// checklist counts. No model is consulted, so neither the card nor the page
// may call it an "AI review" / "AI Plan Review" / "AI Trade Plan Builder".

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { summarizePlan, type ChecklistResult } from "@workspace/domain/trade-plan";
import { AIPlanReviewCard } from "./AIPlanReviewCard";

vi.mock("@/components/tradePlan", () => ({ TradePlanBuilderPanel: () => null }));
import TradePlanBuilderPage from "@/pages/trade-plan-builder";

afterEach(() => cleanup());

const CHECKLIST = {
  items: [{ key: "sl", label: "Stop loss set", status: "PASS", detail: "" }],
  passCount: 1, failCount: 0, warnCount: 0, isReady: true, rewardToRisk: 2,
} as unknown as ChecklistResult;

const PLAN = {
  symbol: "EURUSD", directionBias: "BUY", strategyId: "breakout",
  rewardToRisk: 2, rewardToRiskTarget: 1.5, confidenceLevel: 80,
};

describe("summarizePlan is a fixed rule, not a model", () => {
  it("returns the same text for the same inputs", () => {
    const a = summarizePlan(PLAN, CHECKLIST, "2026-10-28T10:00:00.000Z");
    const b = summarizePlan(PLAN, CHECKLIST, "2026-10-28T23:00:00.000Z");
    expect(a).toBe(b);
  });
});

describe("Plan review card", () => {
  it("does not claim an AI review before validation", () => {
    render(<AIPlanReviewCard summary={null} />);
    expect(document.body.textContent).not.toMatch(/AI (plan )?review|AI assists/i);
    expect(screen.getByTestId("plan-review-title").textContent).toBe("Plan review");
    expect(screen.getByTestId("plan-review-basis").textContent).toMatch(/fixed rules/);
  });

  it("labels a validated plan's summary as rule-based, not AI-written", () => {
    render(<AIPlanReviewCard summary={summarizePlan(PLAN, CHECKLIST, "2026-10-28T10:00:00.000Z")} />);
    expect(document.body.textContent).not.toMatch(/AI (plan )?review|AI assists/i);
    expect(screen.getByTestId("plan-review-basis").textContent).toMatch(/not written by an AI model/);
  });
});

describe("Trade plan builder page", () => {
  it("the page title does not claim AI", () => {
    render(<TradePlanBuilderPage />);
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("Trade Plan Builder");
  });
});
