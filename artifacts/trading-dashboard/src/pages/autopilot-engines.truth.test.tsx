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
    expect(screen.queryByText("Cycles today")).toBeNull();
  });
});
