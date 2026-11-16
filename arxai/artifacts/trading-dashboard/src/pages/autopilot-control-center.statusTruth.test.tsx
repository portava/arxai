// Truth regression: Autopilot status tiles and decision rows.
//
// Before: decision rows listed "conf 72 opp 70 sniper 68 grade 70 risk 30 ...
// news CLEAR" under "Each AI decision shows scores", with nothing saying the
// scores are price-drift mocks and the news a simulated list. With no session
// the tiles read "Daily risk left $0" / "Trades remaining 0", and Discipline
// read 100/100 with no decisions behind it.

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
  mode: "OFF", state: "IDLE", session: null, lastScanTs: null,
  nextScanInSec: 0, consecutiveLosses: 0, openSimulatedPositions: 0,
  dailyRiskRemainingUsd: 0, dailyTradesRemaining: 0, activeRiskLocks: [],
  mt5Connected: false, killSwitchEngaged: false, discipline: 100, lastDecision: null,
};

const DECISION = {
  decisionId: "apd_1", ts: "2026-10-28T09:00:00Z", symbol: "EURUSD", timeframe: "M15", strategy: "trend",
  considered: "", action: "ASK_USER_APPROVAL", reason: "Setup BUY confidence=72",
  confidenceScore: 72, opportunityScore: 70, entrySniperScore: 68, tradeGrade: 70, riskScore: 30,
  rulesPassed: [], rulesFailed: [], marketHealth: "", newsRisk: "CLEAR", sessionRisk: "LONDON",
  finalDecision: "ASK_USER_APPROVAL", nextAction: "Awaiting human approval",
};

let status: Record<string, unknown>;
let decisions: unknown[];

beforeEach(() => {
  status = { ...BASE_STATUS };
  decisions = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/api/autopilot/status")) return jsonResponse(200, status);
    if (u.includes("/api/autopilot/decisions")) return jsonResponse(200, { decisions });
    return jsonResponse(200, { locks: [] });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPage() {
  render(<AutopilotControlCenter />);
  await screen.findByText(/^Trades remaining/);
}

function tile(label: RegExp): string {
  const el = screen.getByText(label);
  return el.parentElement?.textContent ?? "";
}

describe("Autopilot status tiles", () => {
  it("with no session, daily risk and trades remaining say 'no session', not $0 / 0", async () => {
    await renderPage();
    expect(tile(/^Daily risk left/)).toMatch(/no session/);
    expect(tile(/^Daily risk left/)).not.toMatch(/\$0/);
    expect(tile(/^Trades remaining/)).toMatch(/no session/);
  });

  it("discipline with no decisions behind it reads 'not measured'", async () => {
    status = { ...BASE_STATUS, disciplineDecisions: 0 };
    await renderPage();
    expect(tile(/^Discipline$/)).toMatch(/not measured/);
    expect(tile(/^Discipline$/)).not.toMatch(/100\/100/);
  });

  it("tiles say the book is every simulator user and trades remaining counts every non-manual order", async () => {
    status = { ...BASE_STATUS, session: { sessionId: "s", name: "n", mode: "DEMO_AUTO_SIMULATOR", strategy: "t", status: "ACTIVE", rules: {} },
      dailyTradesRemaining: 0, tradesCountedToday: 3, bookScope: "ALL_SIMULATOR_USERS", disciplineDecisions: 4, discipline: 95 };
    await renderPage();
    expect(tile(/^Trades remaining/)).toMatch(/0/);
    expect(tile(/^Discipline$/)).toMatch(/95\/100/);
    const basis = screen.getByTestId("autopilot-tile-basis").textContent ?? "";
    expect(basis).toMatch(/whole simulator book/);
    expect(basis).toMatch(/every non-manual simulator order/);
    expect(basis).toMatch(/3 so far/);
  });
});

describe("Autopilot decision rows", () => {
  it("say the scores are simulated and the news is the simulator's list", async () => {
    decisions = [{ ...DECISION, scoreBasis: "SIMULATED_PRICE_DRIFT", newsBasis: "SIMULATOR_NEWS_LIST", newsDetail: "No high-impact event ... not a live economic calendar." }];
    await renderPage();
    await screen.findByText("EURUSD");
    expect(screen.getByTestId("decisions-basis").textContent).toMatch(/Scores are simulated/);
    expect(screen.getByTestId("decisions-basis").textContent).toMatch(/not a live economic calendar/);
    expect(screen.getByText("simulated scores")).toBeTruthy();
    expect(screen.getByText(/simulated news CLEAR/)).toBeTruthy();
    expect(screen.getByText(/risk 30 \(100 − grade\)/)).toBeTruthy();
  });

  it("a decision whose score source is not reported is not shown as a model score", async () => {
    decisions = [{ ...DECISION }];
    await renderPage();
    await screen.findByText("EURUSD");
    expect(screen.getByText("score source not reported")).toBeTruthy();
  });
});
