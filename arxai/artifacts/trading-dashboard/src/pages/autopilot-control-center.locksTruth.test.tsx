// Truth regression: the Autopilot Control Center's safety locks and kill switch.
//
// Before: every lock rendered as an un-tripped outline (read: clear), although
// only KILL_SWITCH, DAILY_LOSS and WEEKLY_LOSS have a code path that sets
// them, so a scan blocked by news showed NEWS_WINDOW clear next to State
// BLOCKED_BY_NEWS. An engaged platform (safety-core) kill switch showed no
// banner, and the autopilot's own emergency stop read "Kill switch is engaged"
// with no word that nothing releases it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("lucide-react", () => {
  const Stub = () => null;
  return {
    Bot: Stub, Play: Stub, Pause: Stub, StopCircle: Stub, AlertOctagon: Stub,
    Zap: Stub, ThumbsUp: Stub, ThumbsDown: Stub, Brain: Stub, ShieldAlert: Stub,
  };
});
vi.mock("@/hooks/useProductRole", () => ({
  useProductRole: () => ({ role: "ADMIN", isAdmin: true, isInvestor: false, isTrader: false, isLoading: false, homePath: "/" }),
}));

import AutopilotControlCenter from "./autopilot-control-center";

function jsonResponse(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

const BASE_STATUS = {
  mode: "OBSERVE_ONLY", state: "BLOCKED_BY_NEWS", session: null, lastScanTs: null,
  nextScanInSec: 0, consecutiveLosses: 0, openSimulatedPositions: 0,
  dailyRiskRemainingUsd: 50, dailyTradesRemaining: 3, activeRiskLocks: [],
  mt5Connected: false, killSwitchEngaged: false, discipline: 100, lastDecision: null,
};

let status: Record<string, unknown>;
let locks: unknown[];

beforeEach(() => {
  status = { ...BASE_STATUS };
  locks = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/api/autopilot/status")) return jsonResponse(200, status);
    if (u.includes("/api/autopilot/safety-locks")) return jsonResponse(200, { locks });
    return jsonResponse(200, { decisions: [] });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPage() {
  render(<AutopilotControlCenter />);
  // The page has loaded once the status-driven tiles are on screen.
  await screen.findByText(/^Trades remaining/);
}

describe("Autopilot safety locks", () => {
  it("a lock nothing sets reads 'not checked', never as a clear lock", async () => {
    locks = [
      { code: "NEWS_WINDOW", tripped: false, evaluated: false, lastCheckedAt: null, checks: "Not checked: no autopilot code sets this lock." },
      { code: "DAILY_LOSS", tripped: false, evaluated: true, lastCheckedAt: null, checks: "Set when..." },
      { code: "WEEKLY_LOSS", tripped: false, evaluated: true, lastCheckedAt: "2026-10-28T09:00:00Z", checks: "Set when..." },
    ];
    await renderPage();
    expect(screen.getByTestId("lock-NEWS_WINDOW").textContent).toMatch(/not checked/);
    expect(screen.getByTestId("lock-DAILY_LOSS").textContent).toMatch(/not checked yet/);
    expect(screen.getByTestId("lock-WEEKLY_LOSS").textContent).toMatch(/clear/);
    expect(screen.getByTestId("locks-unchecked").textContent).toContain("NEWS_WINDOW");
  });

  it("a lock from a server that does not say it was checked is not shown as clear", async () => {
    locks = [{ code: "RISK_BLOCK", tripped: false }];
    await renderPage();
    expect(screen.getByTestId("lock-RISK_BLOCK").textContent).toMatch(/not checked/);
    expect(screen.getByTestId("lock-RISK_BLOCK").textContent).not.toMatch(/clear/);
  });

  it("the losing-streak tile says 'not measured' when nothing feeds the counter", async () => {
    status = { ...BASE_STATUS, consecutiveLossesMeasured: false };
    await renderPage();
    expect(screen.getByText("Consec losses").parentElement?.textContent).toMatch(/not measured/);
  });
});

describe("Kill switches", () => {
  it("an engaged safety-core kill switch is shown, with what it does and does not do to the autopilot", async () => {
    status = { ...BASE_STATUS, platformStop: {
      readable: true, engaged: true, haltsAutopilotOrders: true, readByAutopilot: false, checkedAt: "2026-10-28T09:01:00Z",
      sources: [{ source: "safety_core_kill_switch", reason: "operator emergency stop", engagedAt: "2026-10-28T09:00:00Z", haltsAutopilotOrders: true }],
    } };
    await renderPage();
    const banner = screen.getByTestId("platform-stop").textContent ?? "";
    expect(banner).toMatch(/Safety-core kill switch is engaged/);
    expect(banner).toMatch(/operator emergency stop/);
    expect(banner).toMatch(/refuses every simulator order/);
    expect(banner).toMatch(/does not read the platform stops/);
  });

  it("an unreadable platform stop says it could not be read", async () => {
    status = { ...BASE_STATUS, platformStop: {
      readable: false, engaged: true, haltsAutopilotOrders: true, readByAutopilot: false, checkedAt: "2026-10-28T09:01:00Z",
      sources: [{ source: "safety_core_kill_switch", reason: "state unreadable", engagedAt: null, haltsAutopilotOrders: true }],
    } };
    await renderPage();
    expect(screen.getByTestId("platform-stop").textContent).toMatch(/Could not read the platform kill switch/);
  });

  it("a server that does not report the platform stop is not shown as released", async () => {
    await renderPage();
    const t = screen.getByTestId("platform-stop").textContent ?? "";
    expect(t).toMatch(/not reported/);
    expect(t).not.toMatch(/released/);
  });

  it("the autopilot's own emergency stop says nothing here releases it and that it is not the platform switch", async () => {
    status = { ...BASE_STATUS, killSwitchEngaged: true };
    locks = [{ code: "KILL_SWITCH", tripped: true, evaluated: true, ts: "2026-10-28T09:00:00Z", lastCheckedAt: "2026-10-28T09:01:00Z", checks: "..." }];
    await renderPage();
    const t = screen.getByTestId("autopilot-emergency-stop").textContent ?? "";
    expect(t).toMatch(/Autopilot emergency stop is engaged/);
    expect(t).toMatch(/clears only when the API server restarts/);
    expect(t).toMatch(/not the platform kill switch/);
  });
});
