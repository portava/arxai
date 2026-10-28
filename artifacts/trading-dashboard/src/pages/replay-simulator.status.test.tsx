// Replay Simulator: the result pill compared result.status with "OK" and
// "completed" (lower case) while the engine returns COMPLETED, STOPPED or
// FAILED. Every run therefore got the amber pause icon and the screen-reader
// text "status: paused". A FAILED run also looked like a normal result:
// result.errors and result.warnings were never rendered, so the partial
// numbers read as a complete replay.
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
    started_at: "2026-10-28T10:00:00.000Z", finished_at: "2026-10-28T10:00:01.000Z",
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

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Replay Simulator result status", () => {
  it("a COMPLETED run is labelled completed, not paused", async () => {
    stubFetch(runBody({ status: "COMPLETED" }));
    await runIt();
    const pill = screen.getByText("COMPLETED").closest("[aria-label]");
    expect(pill?.getAttribute("aria-label")).toBe("status: completed");
  });

  it("a FAILED run shows its error and says the numbers are partial", async () => {
    stubFetch(runBody({ status: "FAILED", candles_processed: 31, errors: ["boom"] }));
    await runIt();
    expect(screen.getByText("FAILED").closest("[aria-label]")?.getAttribute("aria-label")).toBe("status: failed");
    expect(screen.getByText(/boom/)).toBeTruthy();
    expect(screen.getByText(/did not finish/i).textContent).toMatch(/31 of 80 candles/);
  });

  it("a STOPPED run shows its warning and is not labelled paused", async () => {
    stubFetch(runBody({ status: "STOPPED", candles_processed: 25, warnings: ["Replay stopped at candle 25 via stop request"] }));
    await runIt();
    expect(screen.getByText("STOPPED").closest("[aria-label]")?.getAttribute("aria-label")).toBe("status: stopped");
    expect(screen.getByText(/Replay stopped at candle 25/)).toBeTruthy();
  });

  it("an unrecognised status is disclosed as unknown", async () => {
    stubFetch(runBody({ status: "WEIRD" }));
    await runIt();
    expect(screen.getByText("WEIRD").closest("[aria-label]")?.getAttribute("aria-label")).toBe("status: unknown (WEIRD)");
  });
});
