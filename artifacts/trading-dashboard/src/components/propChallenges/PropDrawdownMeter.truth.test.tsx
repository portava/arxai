// Truth: the Prop Challenge evaluator measures drawdown and daily loss from
// closed demo trades only; open positions' floating P&L is not read. The
// meters must say "closed-trade" and how many open positions were left out,
// so "0.00% / 10%" is not read as equity drawdown while open trades are down.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PropDrawdownMeter } from "./PropDrawdownMeter";
import { PropDailyLossLimitCard } from "./PropDailyLossLimitCard";

afterEach(() => cleanup());

describe("Prop drawdown / daily-loss meters — measurement basis", () => {
  it("drawdown meter is labelled closed-trade and counts the open positions left out", () => {
    render(<PropDrawdownMeter ddPct={0} limit={0.1} openPositions={3} />);
    expect(screen.getByText("Closed-trade drawdown")).toBeTruthy();
    expect(screen.queryByText("Total drawdown")).toBeNull();
    const basis = screen.getByTestId("prop-drawdown-basis").textContent ?? "";
    expect(basis).toMatch(/closed demo trades only/i);
    expect(basis).toMatch(/floating P&L is not counted/i);
    expect(basis).toMatch(/3 open positions are not counted/);
  });

  it("worst-day card is labelled closed-trade loss", () => {
    render(<PropDailyLossLimitCard worstPct={0} worstDate={null} limit={0.05} openPositions={1} />);
    expect(screen.getByText("Worst-day closed-trade loss vs daily limit")).toBeTruthy();
    expect(screen.getByTestId("prop-daily-loss-basis").textContent).toMatch(/1 open position is not counted/);
  });

  it("an unknown open-position count is said to be unchecked, not zero", () => {
    render(<PropDrawdownMeter ddPct={0} limit={0.1} openPositions={null} />);
    expect(screen.getByTestId("prop-drawdown-basis").textContent).toMatch(/could not be checked/i);
  });
});
