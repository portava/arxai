// Risk Preview: reward-to-risk is directional. A BUY with the stop above and
// the target below entry showed "R:R 2.00" (Math.abs on both distances).
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { RiskPreviewCard } from "./RiskPreviewCard";

afterEach(() => cleanup());

describe("RiskPreviewCard reward-to-risk", () => {
  it("a BUY with stop above and target below entry shows no R:R", () => {
    render(<RiskPreviewCard plan={{ directionBias: "BUY", entryPrice: 1.1, stopLoss: 1.11, takeProfit: 1.08 }} />);
    const rr = screen.getByTestId("risk-preview-rr");
    expect(rr.textContent).not.toContain("2.00 ");
    expect(rr.textContent).toMatch(/wrong side of entry/i);
  });

  it("a correctly sided SELL still shows its R:R", () => {
    render(<RiskPreviewCard plan={{ directionBias: "SELL", entryPrice: 1.1, stopLoss: 1.11, takeProfit: 1.08 }} />);
    expect(screen.getByTestId("risk-preview-rr").textContent).toMatch(/^2\.00/);
  });
});
