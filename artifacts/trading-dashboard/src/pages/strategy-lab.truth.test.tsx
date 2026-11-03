// Strategy Lab: missing result fields are not shown as a measured 0 / 0%,
// scenarios that were never replayed are not counted as run, replay net has a
// stated unit, and a failed list request is not "No experiments yet".
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/ss/PageShell", () => ({
  PageShell: ({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) => <div>{actions}{children}</div>,
}));

const { default: StrategyLab } = await import("./strategy-lab");

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: status >= 200 && status < 300, status, json: async () => body,
  })));
}

function statValue(label: string): string {
  const el = screen.getByTestId(`strategy-lab-stat-${label}`);
  return el.querySelector("[data-stat-value]")?.textContent ?? "";
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Strategy Lab truth labels", () => {
  it("missing totals and win rate are '—', not 0 / 0%", async () => {
    stubFetch(200, { experiments: [{ experimentId: "e1", title: "Exp", status: "COMPLETED", symbol: "EURUSD", resultSummary: { scenariosRun: 3 } }] });
    render(<StrategyLab />);
    await screen.findByText("Exp");
    expect(screen.queryByText("0%")).toBeNull();
    expect(statValue("trades")).toBe("—");
    expect(statValue("net")).toBe("—");
    expect(statValue("winrate")).toBe("—");
  });

  it("all-missing scenarios read '0 of 3 replayed', zero trades has no win rate, and net has a unit", async () => {
    const missing = { replayRunId: "", trades: 0, netPnl: 0, winRate: 0 };
    stubFetch(200, { experiments: [{ experimentId: "e2", title: "Exp2", status: "COMPLETED", symbol: "EURUSD", resultSummary: {
      scenariosRun: 3, totalTrades: 0, totalNet: 0, aggregateWinRate: 0,
      perScenario: [{ scenarioId: "a", ...missing }, { scenarioId: "b", ...missing }, { scenarioId: "c", ...missing }],
    } }] });
    render(<StrategyLab />);
    await screen.findByText("Exp2");
    expect(statValue("scenarios")).toBe("0 of 3");
    expect(screen.getByTestId("strategy-lab-stat-scenarios").textContent).toMatch(/replayed/i);
    expect(statValue("trades")).toBe("0");
    expect(statValue("winrate")).toBe("—");
    expect(screen.getByTestId("strategy-lab-stat-net").textContent).toMatch(/price units × size/);
  });

  it("a 500 shows an error, not 'No experiments yet'", async () => {
    stubFetch(500, { error: "list experiments failed" });
    render(<StrategyLab />);
    await waitFor(() => expect(screen.getByText(/list experiments failed/)).toBeTruthy());
    expect(screen.queryByText("No experiments yet")).toBeNull();
  });

  // Regression: the stats tile said "1 of 2 replayed", but the ranking list
  // and recommendations on the same card still ranked the never-replayed
  // scenario as "net 0, wr 0%" — above a real losing scenario — and named it
  // "Best scenario … with net 0". A zero-trade scenario showed "wr 0%".
  it("a stored ranking does not rank or name a scenario that was never replayed", async () => {
    stubFetch(200, { experiments: [{ experimentId: "e3", title: "Exp3", status: "COMPLETED", symbol: "EURUSD", resultSummary: {
      scenariosRun: 2, totalTrades: 3, totalNet: -5, aggregateWinRate: 33,
      perScenario: [{ scenarioId: "scenario-a", replayRunId: "r1", trades: 3 }, { scenarioId: "scenario-b", replayRunId: "", trades: 0 }],
      ranking: [{ scenarioId: "scenario-b", netPnl: 0, winRate: 0 }, { scenarioId: "scenario-a", netPnl: -5, winRate: 33 }],
      recommendations: [
        { type: "BEST_SCENARIO", message: "Best scenario: scenario-b with net 0" },
        { type: "WORST_SCENARIO", message: "Worst scenario: scenario-a with net -5" },
      ],
    } }] });
    render(<StrategyLab />);
    await screen.findByText("Exp3");
    const ranking = screen.getByTestId("strategy-lab-ranking").textContent ?? "";
    const rows = Array.from(screen.getByTestId("strategy-lab-ranking").querySelectorAll("li")).map((li) => li.textContent ?? "");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/#1 .*scenario-a.* net -5, wr 33%/);
    expect(ranking).toMatch(/Not replayed \(scenario not found\): scenario-b/);
    expect(ranking).not.toMatch(/wr 0%/);
    const recs = screen.getByTestId("strategy-lab-recommendations").textContent ?? "";
    expect(recs).not.toMatch(/scenario-b with net 0/);
    expect(recs).toMatch(/Best scenario: scenario-a with net -5/);
  });

  it("a replayed scenario with zero trades has no win rate in the ranking", async () => {
    stubFetch(200, { experiments: [{ experimentId: "e4", title: "Exp4", status: "COMPLETED", symbol: "EURUSD", resultSummary: {
      scenariosRun: 1, totalTrades: 0, totalNet: 0, aggregateWinRate: 0,
      perScenario: [{ scenarioId: "scenario-z", replayRunId: "r9", trades: 0 }],
      ranking: [{ scenarioId: "scenario-z", netPnl: 0, winRate: 0 }],
    } }] });
    render(<StrategyLab />);
    await screen.findByText("Exp4");
    const ranking = screen.getByTestId("strategy-lab-ranking").textContent ?? "";
    expect(ranking).not.toMatch(/wr 0%/);
    expect(ranking).toMatch(/no trades/);
  });
});
