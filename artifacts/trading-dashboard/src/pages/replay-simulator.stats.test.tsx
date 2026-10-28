// Replay Simulator stats: a replay with no closed trade showed "Win rate 0%"
// and "Profit factor 0"; a replay with no losing trade showed the engine's
// 999 sentinel as a profit factor; Net P&L and Max DD were bare numbers
// although they are candle price differences x position size, not money; and
// "Wins / Losses" dropped break-even trades.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/ss/PageShell", async (orig) => {
  const real = await orig<typeof import("@/components/ss/PageShell")>();
  return { ...real, PageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> };
});

const { default: ReplaySimulator } = await import("./replay-simulator");

const scenario = {
  scenarioId: "scn_a", title: "Scenario A", symbol: "V75", timeframe: "M5",
  source: "SYNTHETIC", marketCondition: "TRENDING_UP", candleCount: 80, notes: "",
};

function runBody(over: Record<string, unknown>) {
  return {
    replay_run_id: "rrun_1", scenario_id: "scn_a", status: "COMPLETED", symbol: "V75", timeframe: "M5",
    candles_processed: 80, decisions_created: 70, simulated_trades_opened: 4, simulated_trades_closed: 4,
    wins: 3, losses: 1, break_even: 0, net_pnl: 12.5, win_rate: 75, max_drawdown: 5, profit_factor: 3.5,
    warnings: [], errors: [],
    report: { coach_notes: [], safety_notes: [], playbook_recommendations: [], mistake_patterns: [], should_promote_to_playbook: false, should_mark_for_review: false },
    ...over,
  };
}

function stubFetch(run: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = String(url).includes("/api/replay/run") ? run : { scenarios: [scenario], count: 1 };
    return { ok: true, status: 200, json: async () => body };
  }));
}

async function runIt() {
  render(<ReplaySimulator />);
  await screen.findByText("Scenario A (80c, synthetic)");
  fireEvent.click(screen.getByRole("button", { name: "Run Replay" }));
  await screen.findByText("Replay Result");
}

const stat = (label: string) => screen.getByTestId(`replay-stat-${label}`).textContent ?? "";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Replay Simulator stats", () => {
  it("no closed trade: win rate and profit factor are not shown as 0", async () => {
    stubFetch(runBody({ simulated_trades_opened: 0, simulated_trades_closed: 0, wins: 0, losses: 0, net_pnl: 0, max_drawdown: 0, win_rate: null, profit_factor: null }));
    await runIt();
    expect(stat("win-rate")).not.toMatch(/0%/);
    expect(stat("win-rate")).toMatch(/no closed trades/i);
    expect(stat("profit-factor")).not.toMatch(/\b0\b/);
  });

  it("an older server's 0 win rate on zero trades is still not shown as 0%", async () => {
    stubFetch(runBody({ simulated_trades_opened: 0, simulated_trades_closed: 0, wins: 0, losses: 0, net_pnl: 0, max_drawdown: 0, win_rate: 0, profit_factor: 0 }));
    await runIt();
    expect(stat("win-rate")).not.toMatch(/0%/);
    expect(stat("profit-factor")).not.toMatch(/\b0\b/);
  });

  it("no losing trade: the 999 sentinel is never displayed", async () => {
    stubFetch(runBody({ wins: 4, losses: 0, win_rate: 100, profit_factor: 999 }));
    await runIt();
    expect(screen.queryByText(/999/)).toBeNull();
    expect(stat("profit-factor")).toMatch(/no losing trades/i);
  });

  it("Net P&L and Max DD carry a price-point unit, and break-even trades are counted", async () => {
    stubFetch(runBody({ wins: 2, losses: 1, break_even: 1, position_size: 1 }));
    await runIt();
    expect(stat("net-pnl")).toMatch(/12\.5 pts/);
    expect(stat("max-dd")).toMatch(/5 pts/);
    expect(stat("wins-losses")).toMatch(/2 \/ 1 \/ 1/);
    expect(screen.getByTestId("replay-pnl-unit").textContent).toMatch(/price points.*size 1.*not money/i);
  });
});
