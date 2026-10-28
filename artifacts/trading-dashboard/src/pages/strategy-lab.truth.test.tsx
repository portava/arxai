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
});
