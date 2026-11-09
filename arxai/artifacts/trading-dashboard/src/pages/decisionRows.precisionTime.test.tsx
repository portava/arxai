// Regression: Shadow Mode printed every price with toFixed(5) ("entry
// 39200.00000" for US30) and Brain Analysis did the same for support /
// resistance levels. Shadow decisions, the shadow journal and Autopilot
// decisions showed only toLocaleTimeString(), so yesterday's 14:02 read like
// today's (the in-memory stores are not pruned by age).
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { rowTimeLabel } from "@/lib/rowTimeLabel";

vi.mock("@/hooks/useProductRole", () => ({
  useProductRole: () => ({ role: "ADMIN", isAdmin: true, isInvestor: false, isTrader: false, isLoading: false, homePath: "/" }),
}));

import ShadowMode from "./shadow-mode";
import ShadowJournal from "./shadow-journal";
import AutopilotControlCenter from "./autopilot-control-center";
import { TechnicalPanel } from "./brain-analysis";

const NOW = new Date("2026-10-28T12:00:00Z");
const TWO_DAYS_AGO = "2026-10-26T14:02:00Z";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function serve(routes: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    return new Response(JSON.stringify(key ? routes[key] : {}), { status: 200 });
  }));
}

describe("row times carry a date when the row is not from today", () => {
  it("rowTimeLabel: today is time-only, an older row includes its date, a bad time says so", () => {
    const today = rowTimeLabel("2026-10-28T11:00:00Z", NOW);
    expect(today).toBe(new Date("2026-10-28T11:00:00Z").toLocaleTimeString());
    const old = rowTimeLabel(TWO_DAYS_AGO, NOW);
    expect(old).not.toBe(new Date(TWO_DAYS_AGO).toLocaleTimeString());
    expect(old).toMatch(/26/);
    expect(rowTimeLabel("not-a-time", NOW)).toBe("time not reported");
  });
});

describe("Shadow Mode decision rows", () => {
  it("an index price is not shown with 5 decimals and an old row is dated", async () => {
    serve({
      "/api/shadow-mode/status": { enabled: true, startedAt: null, totalsObserved: 1, totalDecisions: 1, tracking: 0, wins: 0, losses: 0, breakevens: 0, expired: 0, rejected: 0, waits: 0 },
      "/api/shadow-mode/decisions": { decisions: [
        { id: "d1", ts: TWO_DAYS_AGO, symbol: "US30", strategy: "s", marketCondition: "trend", action: "BUY", entry: 39200, sl: 39100, tp: 39400, confidence: 60, status: "SHADOW_TRACKING_OUTCOME", reason: "r", reasonToAvoid: "", riskGovernor: { approved: true, level: "OK", hardBlocks: [] } },
        { id: "d2", ts: "2026-10-28T11:00:00Z", symbol: "EURUSD", strategy: "s", marketCondition: "trend", action: "SELL", entry: 1.08523, sl: 1.0885, tp: 1.0798, confidence: 60, status: "SHADOW_TRACKING_OUTCOME", reason: "r2", reasonToAvoid: "", riskGovernor: { approved: true, level: "OK", hardBlocks: [] } },
      ] },
    });
    render(<ShadowMode />);
    await waitFor(() => expect(screen.getByText("US30")).toBeTruthy());
    const page = document.body.textContent ?? "";
    expect(page).not.toMatch(/39200\.00000/);
    expect(page).toMatch(/entry 39200\.00 sl 39100\.00 tp 39400\.00/);
    expect(page).toMatch(/entry 1\.08523 sl 1\.08850 tp 1\.07980/);
    expect(page).toContain(rowTimeLabel(TWO_DAYS_AGO, NOW));
  });
});

describe("Shadow Journal rows", () => {
  it("an old entry is dated", async () => {
    serve({ "/api/shadow-journal": { entries: [
      { id: "j1", ts: TWO_DAYS_AGO, rightOrWrong: "RIGHT", symbol: "US30", strategy: "s", marketCondition: "trend", aiSaw: "a", whatHappened: "w", lesson: "l" },
    ] } });
    render(<ShadowJournal />);
    await waitFor(() => expect(screen.getByText("US30")).toBeTruthy());
    expect(document.body.textContent ?? "").toContain(rowTimeLabel(TWO_DAYS_AGO, NOW));
  });
});

describe("Autopilot decision rows", () => {
  it("an old decision is dated", async () => {
    serve({
      "/api/autopilot/status": { mode: "OFF", state: "IDLE", session: null, lastScanTs: null, nextScanInSec: 0, consecutiveLosses: 0, openSimulatedPositions: 0, dailyRiskRemainingUsd: 0, dailyTradesRemaining: 0, activeRiskLocks: [], mt5Connected: false, killSwitchEngaged: false, discipline: 100, lastDecision: null },
      "/api/autopilot/decisions": { decisions: [
        { decisionId: "a1", ts: TWO_DAYS_AGO, symbol: "US30", timeframe: "M5", strategy: "trend", considered: "", action: "SKIP", reason: "old", confidenceScore: 1, opportunityScore: 1, entrySniperScore: 1, tradeGrade: 1, riskScore: 1, rulesPassed: [], rulesFailed: [], marketHealth: "ok", newsRisk: "low", sessionRisk: "low", finalDecision: "SKIP", nextAction: "wait" },
      ] },
      "/api/autopilot/safety-locks": { locks: [] },
    });
    render(<AutopilotControlCenter />);
    await waitFor(() => expect(screen.getByText("old")).toBeTruthy());
    expect(document.body.textContent ?? "").toContain(rowTimeLabel(TWO_DAYS_AGO, NOW));
  });
});

describe("Brain Analysis levels", () => {
  it("index levels are not printed with 5 decimals", () => {
    render(<TechnicalPanel data={{ supportLevels: [39150.5], resistanceLevels: [39410] } as never} />);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/39150\.50000|39410\.00000/);
    expect(text).toMatch(/39150\.50/);
    expect(text).toMatch(/39410\.00/);
  });
});
