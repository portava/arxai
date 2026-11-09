// Two different engines are both called "Autopilot": the in-memory simulator
// autopilot (api-server lib/autopilot.ts, /api/autopilot/*) reported by the
// Autopilot Control Center, and the paper autopilot (autopilot_cycles,
// lib/paperAutopilot) summarised on the Command Center's Memory tab. Each
// surface must name the engine it reports, so "Autopilot OFF" on one board and
// "Cycles today 50" on the other do not read as one system contradicting itself.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/hooks/useProductRole", () => ({
  useProductRole: () => ({
    role: "ADMIN", isAdmin: true, isInvestor: false, isTrader: false, isLoading: false, homePath: "/",
  }),
}));

const { default: AutopilotControlCenter } = await import("./autopilot-control-center");
const { PaperAutopilotSummaryCard } = await import("./ai-command-center");

function jsonResponse(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Autopilot boards name their engine", () => {
  it("the Autopilot Control Center says it reports the simulator autopilot, not the paper autopilot", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/api/autopilot/status")) {
        return jsonResponse(200, {
          mode: "OFF", state: "IDLE", session: null, lastScanTs: null, nextScanInSec: 0,
          consecutiveLosses: 0, openSimulatedPositions: 0, dailyRiskRemainingUsd: 0,
          dailyTradesRemaining: 0, activeRiskLocks: [], mt5Connected: false,
          killSwitchEngaged: false, discipline: 100, lastDecision: null,
        });
      }
      return jsonResponse(200, { decisions: [], locks: [] });
    }));
    render(<AutopilotControlCenter />);
    const scope = await screen.findByTestId("autopilot-engine-scope");
    expect(scope.textContent).toMatch(/simulator autopilot/i);
    expect(scope.textContent).toMatch(/paper autopilot.*separate engine/i);
    expect(screen.getByText("SIMULATOR AUTOPILOT")).toBeTruthy();
  });

  it("the Command Center card says it counts the paper autopilot, not the simulator autopilot", () => {
    render(<PaperAutopilotSummaryCard a={{
      cycles_today: 50, paper_trades_opened_today: 7, paper_trades_closed_today: 2,
      safety_blocks_today: 1, last_cycle: null,
    }} />);
    expect(screen.queryByText(/^Autopilot$/)).toBeNull();
    expect(document.body.textContent).toMatch(/Paper autopilot/);
    const scope = screen.getByTestId("paper-autopilot-scope");
    expect(scope.textContent).toMatch(/simulator autopilot.*separate engine/i);
  });

  it("a missing paper autopilot summary is unknown, not zero cycles", () => {
    render(<PaperAutopilotSummaryCard a={undefined} />);
    expect(screen.getByTestId("paper-autopilot-missing").textContent).toMatch(/unknown/i);
    // The tiles stay on the card (merged behaviour), each "—", never a 0 count.
    expect(screen.getByTestId("autopilot-cycles-today").textContent).toBe("—");
    expect(screen.queryByText("0")).toBeNull();
  });

  it("today's counts that hit the server's read window are shown as lower bounds", () => {
    render(<PaperAutopilotSummaryCard a={{
      cycles_today: 50, paper_trades_opened_today: 7, paper_trades_closed_today: 2,
      safety_blocks_today: 1, last_cycle: null, today_counts_capped: true, cycles_read_limit: 50,
    }} />);
    expect(screen.queryByText("50")).toBeNull();
    expect(screen.getByText("50+")).toBeTruthy();
    expect(screen.getByTestId("paper-autopilot-capped").textContent).toMatch(/latest 50 cycles only/);
  });

  it("the 'today' tiles name their UTC day basis even when not capped", () => {
    render(<PaperAutopilotSummaryCard a={{
      cycles_today: 12, paper_trades_opened_today: 3, paper_trades_closed_today: 2,
      safety_blocks_today: 0, last_cycle: null, today_counts_capped: false, cycles_read_limit: 50, today_basis: "UTC",
    }} />);
    expect(screen.getByText("Cycles today (UTC)")).toBeTruthy();
    expect(screen.getByText("Opened today (UTC)")).toBeTruthy();
    expect(screen.getByTestId("paper-autopilot-day-basis").textContent).toMatch(/UTC calendar day/);
  });

  it("a day basis the server did not report is said so, not assumed", () => {
    render(<PaperAutopilotSummaryCard a={{
      cycles_today: 12, paper_trades_opened_today: 3, paper_trades_closed_today: 2,
      safety_blocks_today: 0, last_cycle: null,
    }} />);
    expect(screen.getByTestId("paper-autopilot-day-basis").textContent).toMatch(/not reported/);
    expect(screen.queryByText(/\(UTC\)/)).toBeNull();
  });

  it("the last cycle line says when that cycle started", () => {
    const startedAt = "2026-10-01T08:15:00.000Z";
    render(<PaperAutopilotSummaryCard a={{
      cycles_today: 0, paper_trades_opened_today: 0, paper_trades_closed_today: 0, safety_blocks_today: 0,
      today_basis: "UTC",
      last_cycle: { autopilot_cycle_id: "apc_x", status: "COMPLETED", started_at: startedAt, paper_trades_opened: 1, paper_trades_rejected: 0 },
    }} />);
    const line = screen.getByTestId("paper-autopilot-last-cycle").textContent ?? "";
    expect(line).toContain(new Date(startedAt).toLocaleString());
    expect(line).toMatch(/apc_x/);
    cleanup();
    render(<PaperAutopilotSummaryCard a={{
      cycles_today: 0, paper_trades_opened_today: 0, paper_trades_closed_today: 0, safety_blocks_today: 0,
      last_cycle: { autopilot_cycle_id: "apc_y", status: "COMPLETED", paper_trades_opened: 0, paper_trades_rejected: 0 },
    }} />);
    expect(screen.getByTestId("paper-autopilot-last-cycle").textContent).toMatch(/time not reported/);
  });

  // autopilot_cycles.paper_trades_rejected (summed into safety_blocks_today)
  // counts each symbol/timeframe check ended by an AI HOLD, the daily paper
  // loss limit, a sniper skip or a paper-execution refusal (not checks that
  // threw). A day of ordinary HOLDs is not "safety blocks".
  it("the held/skipped/refused count is not called safety blocks and says AI holds are included", () => {
    render(<PaperAutopilotSummaryCard a={{
      cycles_today: 1440, paper_trades_opened_today: 2, paper_trades_closed_today: 1,
      safety_blocks_today: 7198, last_cycle: { autopilot_cycle_id: "c9", status: "COMPLETED", paper_trades_opened: 0, paper_trades_rejected: 5 },
      today_counts_capped: false, cycles_read_limit: null, today_basis: "UTC",
    }} />);
    expect(screen.queryByText(/Safety blocks today/i)).toBeNull();
    // Named after what it counts: a check that threw is also "not opened" but
    // is not in this count.
    expect(screen.queryByText("Not opened today (UTC)")).toBeNull();
    expect(screen.getByText("Held, skipped or refused today (UTC)")).toBeTruthy();
    expect(screen.getByText("7198")).toBeTruthy();
    const basis = screen.getByTestId("autopilot-not-opened-basis").textContent ?? "";
    expect(basis).toMatch(/AI decided to hold/i);
    expect(basis).toMatch(/sniper/i);
    expect(basis).toMatch(/not a count of safety blocks/i);
    expect(basis).toMatch(/symbol\/timeframe check/);
    expect(basis).toMatch(/failed with an error is not counted here/i);
    expect(basis).not.toMatch(/Counts each symbol a paper autopilot cycle did not open/);
    expect(document.body.textContent).toMatch(/held, skipped or refused 5/);
    expect(document.body.textContent).not.toMatch(/not opened 5/);
    expect(document.body.textContent).not.toMatch(/rejected 5/);
  });

  // A symbol/timeframe check that throws (the market-data read, orchestrate…)
  // increments neither opened nor paper_trades_rejected. On a failing day the
  // held/skipped/refused tile reads 0, so the failed checks are shown beside
  // it, and the last cycle says how many of its checks failed.
  it("checks that failed with an error are shown, so a failing day is not read as 0", () => {
    render(<PaperAutopilotSummaryCard a={{
      cycles_today: 30, paper_trades_opened_today: 0, paper_trades_closed_today: 0,
      safety_blocks_today: 0, symbol_checks_failed_today: 120, cycles_failed_today: 30,
      last_cycle: { autopilot_cycle_id: "c30", status: "FAILED", paper_trades_opened: 0, paper_trades_rejected: 0, symbol_checks_failed: 4 },
      today_counts_capped: false, cycles_read_limit: null, today_basis: "UTC",
    }} />);
    const failed = screen.getByTestId("autopilot-failed-checks").textContent ?? "";
    expect(failed).toMatch(/120 symbol\/timeframe checks failed with an error today \(UTC\)/);
    expect(failed).toMatch(/30 cycles ended FAILED/);
    expect(failed).toMatch(/not counted as opened or as held, skipped or refused/);
    expect(screen.getByTestId("paper-autopilot-last-cycle").textContent).toMatch(/failed checks 4/);
  });

  it("a summary that does not report failed checks says so instead of implying none failed", () => {
    render(<PaperAutopilotSummaryCard a={{
      cycles_today: 3, paper_trades_opened_today: 0, paper_trades_closed_today: 0,
      safety_blocks_today: 0, last_cycle: null, today_basis: "UTC",
    }} />);
    const failed = screen.getByTestId("autopilot-failed-checks").textContent ?? "";
    expect(failed).toMatch(/not counted above/);
    expect(failed).toMatch(/did not report how many/);
  });

  it("the server's basis for the not-opened count is shown when it sends one", () => {
    const serverBasis = "Server basis: each symbol a cycle did not open a trade for.";
    render(<PaperAutopilotSummaryCard a={{
      cycles_today: 3, paper_trades_opened_today: 0, paper_trades_closed_today: 0,
      safety_blocks_today: 15, safety_blocks_today_basis: serverBasis, last_cycle: null,
    }} />);
    expect(screen.getByTestId("autopilot-not-opened-basis").textContent).toBe(serverBasis);
  });

  it("no cycle today: does not say the autopilot 'blocked' anything", () => {
    render(<PaperAutopilotSummaryCard a={{
      cycles_today: 0, paper_trades_opened_today: 0, paper_trades_closed_today: 0,
      safety_blocks_today: 0, last_cycle: null, today_basis: "UTC",
    }} />);
    expect(screen.getByTestId("autopilot-today-note").textContent).toMatch(/No autopilot cycle has run today \(UTC\)/);
    expect(screen.getByTestId("autopilot-today-note").textContent).not.toMatch(/blocked/i);
  });

  it("uncapped counts are shown as totals", () => {
    render(<PaperAutopilotSummaryCard a={{
      cycles_today: 12, paper_trades_opened_today: 3, paper_trades_closed_today: 2,
      safety_blocks_today: 0, last_cycle: null, today_counts_capped: false, cycles_read_limit: 50,
    }} />);
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.queryByTestId("paper-autopilot-capped")).toBeNull();
  });
});
