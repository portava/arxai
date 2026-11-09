// Analytics Command Center components: a cell with nothing measured says so
// ("No trades", "—"), never a $0 or a 0% result.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SessionHeatmap } from "./SessionHeatmap";
import { ConsistencyTrendCard } from "./ConsistencyTrendCard";
import { RiskExposureGraph } from "./RiskExposureGraph";
import { StrategyAnalyticsTable } from "./StrategyAnalyticsTable";
import type { AnalyticsFigures } from "./types";

afterEach(() => { cleanup(); });

describe("SessionHeatmap", () => {
  it("a session with no trades shows 'No trades' and —, not $0 and 0% win", () => {
    render(<SessionHeatmap data={{
      ASIA: { trades: 0, pnl: 0, wins: 0, sizedTrades: 0 },
      LONDON: { trades: 2, pnl: 150, wins: 1, sizedTrades: 2 },
      NEWYORK: { trades: 1, pnl: 0, wins: 1, sizedTrades: 0 },
    }} basis="Sessions are by each trade's open time in UTC: ASIA 21:00–07:00 (Sydney and Tokyo), LONDON 07:00–13:00, NEWYORK 13:00–21:00." />);
    const asia = screen.getByTestId("session-cell-ASIA").textContent ?? "";
    expect(asia).toContain("No trades");
    expect(asia).toContain("—");
    expect(asia).not.toMatch(/0% win|\$0/);
    const london = screen.getByTestId("session-cell-LONDON").textContent ?? "";
    expect(london).toContain("$150");
    expect(london).toContain("2 trades · 50% win");
    // Traded, but nothing could be sized in USD: no $0 P&L.
    const ny = screen.getByTestId("session-cell-NEWYORK").textContent ?? "";
    expect(ny).not.toContain("$0");
    expect(ny).toContain("P&L not sized");
    expect(screen.getByTestId("session-basis").textContent).toMatch(/NEWYORK 13:00–21:00/);
  });
});

const NOTHING_MEASURED: AnalyticsFigures = {
  totalTrades: 0, netProfitLoss: null, winRate: null, averageRr: null, expectancy: null,
  profitFactor: null, maxDrawdown: null,
  disciplineScoreAvg: null, executionScoreAvg: null, emotionalScoreAvg: null, consistencyScoreAvg: null,
  strongestStrategy: null, weakestStrategy: null, strongestMarketCondition: null, weakestMarketCondition: null,
  unmeasured: {
    disciplineScoreAvg: "No Trader Skill profile has been computed yet.",
    executionScoreAvg: "No Trader Skill profile has been computed yet.",
    emotionalScoreAvg: "No post-trade debriefs yet.",
    consistencyScoreAvg: "No Trader Skill profile has been computed yet.",
  },
};

describe("ConsistencyTrendCard", () => {
  it("an unmeasured pillar is — with the reason, not a red 0/100", () => {
    render(<ConsistencyTrendCard snapshot={NOTHING_MEASURED} />);
    for (const label of ["Discipline", "Execution", "Emotional control", "Consistency"]) {
      const cell = screen.getByTestId(`consistency-${label}`);
      expect(cell.textContent).toContain("—");
      expect(cell.textContent).not.toMatch(/\b0\b|\/100/);
      expect(cell.querySelector(".text-red-300")).toBeNull();
    }
    expect(screen.getByTestId("consistency-Discipline").textContent).toContain("No Trader Skill profile");
    expect(screen.getByTestId("consistency-Emotional control").textContent).toContain("No post-trade debriefs");
  });

  it("a measured pillar keeps its score and the profile's time is shown", () => {
    render(<ConsistencyTrendCard snapshot={{ ...NOTHING_MEASURED, disciplineScoreAvg: 82, behaviorAsOf: "2026-10-27T09:00:00.000Z" }} />);
    expect(screen.getByTestId("consistency-Discipline").textContent).toBe("Discipline82/100");
    expect(screen.getByTestId("consistency-asof").textContent).toContain(new Date("2026-10-27T09:00:00.000Z").toLocaleString());
  });
});

describe("RiskExposureGraph", () => {
  it("unmeasured figures are — with no bar, not 0.00 / 0.0% / $0", () => {
    render(<RiskExposureGraph snapshot={NOTHING_MEASURED} />);
    for (const label of ["Profit factor", "Avg R-multiple", "Win rate", "Max drawdown $"]) {
      const row = screen.getByTestId(`risk-exposure-${label}`);
      expect(row.textContent).toBe(`${label}—`);
    }
  });
});

describe("ConsistencyTrendCard and Trader Skill", () => {
  it("names the emotional pillar as Trader Skill does and says the scores are the same", () => {
    render(<ConsistencyTrendCard snapshot={{ ...NOTHING_MEASURED, emotionalScoreAvg: 100, behaviorAsOf: "2026-10-27T09:00:00.000Z" }} />);
    expect(screen.getByTestId("consistency-Emotional control").textContent).toBe("Emotional control100/100");
    expect(screen.getByTestId("consistency-asof").textContent).toContain("The same scores as your Trader Skill profile");
  });
});

describe("StrategyAnalyticsTable empty states", () => {
  const empty = () => screen.getByTestId("strategy-table-empty").textContent ?? "";

  it("closed trades none of which could be sized say so, not 'No closed trades'", () => {
    render(<StrategyAnalyticsTable rows={[]} coverage={{ closedTrades: 3, sizedTrades: 0, unsizedTrades: 3, unsizedSymbols: ["US30", "XAUUSD"] }} />);
    expect(empty()).not.toContain("No closed trades");
    expect(empty()).toContain("None of your 3 closed trades could be sized in USD (US30, XAUUSD)");
    expect(empty()).toContain("no results by symbol");
  });

  it("only a server-confirmed zero says there are no closed trades", () => {
    render(<StrategyAnalyticsTable rows={[]} coverage={{ closedTrades: 0, sizedTrades: 0, unsizedTrades: 0, unsizedSymbols: [] }} />);
    expect(empty()).toBe("No closed trades to group by symbol.");
  });

  it("without coverage it does not claim there are no closed trades", () => {
    render(<StrategyAnalyticsTable rows={[]} />);
    expect(empty()).not.toContain("No closed trades");
    expect(empty()).toContain("No closed trade sized in USD");
  });

  it("while loading it says it is loading", () => {
    render(<StrategyAnalyticsTable rows={[]} loading />);
    expect(empty()).toMatch(/Loading results by symbol/);
  });
});

describe("SessionHeatmap without a loaded result", () => {
  it("while loading it says so and shows no 'No trades' cells", () => {
    render(<SessionHeatmap data={null} loading />);
    expect(screen.getByTestId("session-heatmap-state").textContent).toMatch(/Loading session results/);
    expect(screen.queryByText("No trades")).toBeNull();
  });

  it("a response without the session results says they are missing, not 'No trades'", () => {
    render(<SessionHeatmap data={null} />);
    expect(screen.getByTestId("session-heatmap-state").textContent).toMatch(/missing from the response/);
    expect(screen.queryByText("No trades")).toBeNull();
  });

  it("a session the response did not report is 'Not reported', not 'No trades'", () => {
    render(<SessionHeatmap data={{ LONDON: { trades: 2, pnl: 150, wins: 1, sizedTrades: 2 } }} />);
    const asia = screen.getByTestId("session-cell-ASIA").textContent ?? "";
    expect(asia).toContain("Not reported");
    expect(asia).not.toContain("No trades");
  });
});
