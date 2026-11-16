// Trade plan checklist: items that only echo the user's own inputs are shown
// as "not checked", not counted as passes.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { evaluateChecklist } from "@workspace/domain/trade-plan";
import { TradePlanChecklist } from "./TradePlanChecklist";

afterEach(() => cleanup());

describe("TradePlanChecklist", () => {
  it("counts self-reported items as 'your input, not checked'", () => {
    const checklist = evaluateChecklist({
      symbol: "EURUSD", directionBias: "BUY", strategyId: null,
      marketCondition: "TRENDING", entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12,
      riskAmount: 10, maxLossAllowed: 20, rewardToRiskTarget: null, confidenceLevel: 80,
      permissionStatus: "CLEAR", permissionBlockers: [], permissionWarnings: [],
      brokerStatus: "CONNECTED", hasActiveRiskLock: false,
    });
    render(<TradePlanChecklist checklist={checklist} />);
    const counts = screen.getByTestId("trade-plan-checklist-counts").textContent ?? "";
    expect(counts).toContain("6 pass");
    expect(counts).toContain("3 your input, not checked");
    expect(screen.getByText(/you marked the market TRENDING/)).toBeTruthy();
  });
});
