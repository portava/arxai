// Edge discovery cards never print the server's 999 "no losing trade" marker
// as a measured profit factor.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { StrongestEdgeCard } from "./StrongestEdgeCard";
import { WeakestAreaCard } from "./WeakestAreaCard";
import { EdgeBreakdownTable } from "./EdgeBreakdownTable";
import type { EdgeReport } from "./types";

function report(over: Partial<EdgeReport> = {}): EdgeReport {
  return {
    id: 1, edgeName: "symbol=EURUSD", symbol: "EURUSD", strategyId: null, timeframe: null,
    sessionName: null, marketCondition: null, sampleSize: 30, winRate: 1, averageRr: 0,
    expectancy: 10, profitFactor: 999, disciplineScoreAvg: 0, executionScoreAvg: 0,
    emotionalScoreAvg: 0, confidenceScore: 60, status: "DEVELOPING_EDGE",
    aiSummary: "EURUSD: developing edge.", createdAt: "2026-10-27T14:05:00.000Z", ...over,
  };
}

afterEach(cleanup);

describe("profit factor marker", () => {
  it("StrongestEdgeCard says the profit factor is not measurable instead of 999.00", () => {
    const { container } = render(<StrongestEdgeCard report={report()} />);
    expect(container.textContent).not.toContain("999");
    expect(container.textContent).toMatch(/no losing trade/i);
  });
  it("WeakestAreaCard never prints PF 999.00", () => {
    const { container } = render(<WeakestAreaCard report={report()} />);
    expect(container.textContent).not.toContain("999");
  });
  it("EdgeBreakdownTable never prints 999.00", () => {
    const { container } = render(<EdgeBreakdownTable reports={[report()]} />);
    expect(container.textContent).not.toContain("999");
  });
  it("a measured profit factor still renders to two decimals", () => {
    const { container } = render(<StrongestEdgeCard report={report({ profitFactor: 1.734 })} />);
    expect(container.textContent).toContain("1.73");
  });
});

describe("as-of time", () => {
  it("StrongestEdgeCard says when the slice was generated", () => {
    const { container } = render(<StrongestEdgeCard report={report({ profitFactor: 2 })} />);
    expect(container.textContent).toContain("Generated 2026-10-27 14:05 UTC");
  });
  it("WeakestAreaCard says when the slice was generated", () => {
    const { container } = render(<WeakestAreaCard report={report({ status: "WEAK_EDGE", profitFactor: 0.8 })} />);
    expect(container.textContent).toContain("Generated 2026-10-27 14:05 UTC");
  });
  it("EdgeBreakdownTable has an As of column", () => {
    const { container } = render(<EdgeBreakdownTable reports={[report()]} />);
    expect(container.textContent).toContain("As of");
    expect(container.textContent).toContain("2026-10-27 14:05 UTC");
  });
  it("a missing createdAt is said plainly, not invented", () => {
    const { container } = render(<StrongestEdgeCard report={report({ createdAt: "" })} />);
    expect(container.textContent).toContain("time not recorded");
  });
});
