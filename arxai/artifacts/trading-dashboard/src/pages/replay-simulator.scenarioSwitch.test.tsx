// Replay Simulator: after running scenario A and picking scenario B, the
// metadata line showed B while the "Replay Result" card kept A's numbers
// without naming a scenario, symbol or run time. Separately, a selected id
// that is not among the loaded options (the dropdown shows "— pick one —")
// still enabled Run Replay, which then ran a scenario the user could not see.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/ss/PageShell", async (orig) => {
  const real = await orig<typeof import("@/components/ss/PageShell")>();
  return { ...real, PageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> };
});

const { default: ReplaySimulator } = await import("./replay-simulator");

const scn = (id: string, title: string, symbol: string) => ({
  scenarioId: id, title, symbol, timeframe: "M5", source: "SYNTHETIC", marketCondition: "TRENDING_UP", candleCount: 80, notes: "",
});
const A = scn("scn_a", "Scenario A", "V75");
const B = scn("scn_b", "Scenario B", "EURUSD");

const runA = {
  replay_run_id: "rrun_1", scenario_id: "scn_a", status: "COMPLETED", symbol: "V75", timeframe: "M5",
  started_at: "2026-10-28T10:00:00.000Z", finished_at: "2026-10-28T10:00:01.000Z",
  candles_processed: 80, decisions_created: 70, simulated_trades_opened: 4, simulated_trades_closed: 4,
  wins: 3, losses: 1, break_even: 0, net_pnl: 12.5, win_rate: 75, max_drawdown: 5, profit_factor: 3.5, position_size: 1,
  warnings: [], errors: [],
  report: { coach_notes: [], safety_notes: [], playbook_recommendations: [], mistake_patterns: [], should_promote_to_playbook: false, should_mark_for_review: false },
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Replay Simulator result vs selected scenario", () => {
  it("the result names its scenario, and says so when another scenario is selected", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () => (String(url).includes("/api/replay/run") ? runA : { scenarios: [A, B], count: 2 }),
    })));
    render(<ReplaySimulator />);
    await screen.findByText("Scenario A (80c, synthetic)");
    fireEvent.click(screen.getByRole("button", { name: "Run Replay" }));
    await screen.findByText("Replay Result");
    const source = screen.getByTestId("replay-result-source");
    expect(source.textContent).toMatch(/Scenario A/);
    expect(source.textContent).toMatch(/V75/);
    expect(screen.queryByTestId("replay-result-mismatch")).toBeNull();

    fireEvent.change(screen.getByLabelText("Select replay scenario"), { target: { value: "scn_b" } });
    expect(screen.getByTestId("replay-result-source").textContent).toMatch(/Scenario A/);
    expect(screen.getByTestId("replay-result-mismatch").textContent).toMatch(/Scenario A.*not.*Scenario B/);
  });

  it("Run Replay is disabled when the selected scenario is not in the loaded list", async () => {
    let listCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/replay/scenarios") && init?.method === "POST") {
        return { ok: true, status: 200, json: async () => ({ scenario_id: "scn_hidden", scenario: {} }) };
      }
      listCalls++;
      return { ok: true, status: 200, json: async () => ({ scenarios: [A], count: 1 }) };
    }));
    render(<ReplaySimulator />);
    await screen.findByText("Scenario A (80c, synthetic)");
    fireEvent.click(screen.getByRole("button", { name: "+ New Synthetic" }));
    await vi.waitFor(() => expect(listCalls).toBe(2));
    // The dropdown cannot show an id that is not among its options.
    await screen.findByTestId("replay-selected-missing");
    expect((screen.getByRole("button", { name: "+ New Synthetic" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Run Replay" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
