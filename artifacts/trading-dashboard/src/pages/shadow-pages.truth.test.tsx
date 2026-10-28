// shadow-pages.truth.test.tsx — the SHADOW research pages (Shadow Mode,
// Tournament, Calibration, Promotion, Readiness, Journal) must say what was
// observed and what could not be measured. A value the server could not
// compute is never rendered as a number, a 0% bar or a pass.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";
import { render, screen, cleanup, act } from "@testing-library/react";

vi.mock("lucide-react", () => {
  const Stub = () => null;
  return {
    Eye: Stub, Play: Stub, StopCircle: Stub, Sparkles: Stub, Gauge: Stub,
    NotebookPen: Stub, TrendingUp: Stub, Swords: Stub, ShieldAlert: Stub,
  };
});

vi.mock("@/hooks/useProductRole", () => ({
  useProductRole: vi.fn(() => ({
    role: "ADMIN", isAdmin: true, isInvestor: false, isTrader: false, isLoading: false, homePath: "/",
  })),
}));

import StrategyTournament from "./strategy-tournament";
import ShadowMode from "./shadow-mode";

function jsonResponse(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

let bodies: Record<string, unknown> = {};

/** Render a page and let its first load settle. */
async function show(ui: ReactElement) {
  render(ui);
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
}

beforeEach(() => {
  vi.useFakeTimers();
  bodies = {};
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const key = Object.keys(bodies).find((k) => String(url).includes(k));
    return jsonResponse(200, key ? bodies[key] : {});
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ROW = {
  strategy: "Break of Structure", sample: 3, winRate: 100, avgR: 1.67, profitFactor: null, expectancy: 1.67,
  riskAdjustedReturn: 0.96, qualitySetups: 3, confidenceAccuracy: 80, riskDiscipline: 100, tradeGradeAvg: 8,
};

describe("Strategy Tournament", () => {
  it("a profit factor the server could not compute (no losses) reads n/a, not a number", async () => {
    bodies["/api/strategy-tournament/results"] = { running: true, startedAt: null, ranked: [ROW], leaderboard: {} };
    await show(<StrategyTournament />);
    const cell = screen.getByTitle(/No R lost yet/i);
    expect(cell.textContent).toBe("n/a");
  });
});

const STATUS = {
  enabled: false, startedAt: null, totalsObserved: 1, totalDecisions: 1, tracking: 0, wins: 0, losses: 0,
  breakevens: 0, expired: 0, rejected: 0, waits: 1,
};
const WAIT_DEC = {
  id: "w1", ts: "2026-10-01T10:00:00Z", symbol: "EURUSD", strategy: "No Trade Filter", marketCondition: "RANGE",
  action: "WAIT", entry: 1.085, sl: null, tp: null, confidence: 0, status: "SHADOW_WAIT",
  reason: "No actionable signal from any strategy", reasonToAvoid: "",
  riskGovernor: { approved: false, level: "NOT_CHECKED", hardBlocks: [] },
};

describe("Shadow Mode", () => {
  it("says the prices come from the synthetic simulator when the server reports it", async () => {
    bodies["/api/shadow-mode/status"] = { ...STATUS, priceSource: "SYNTHETIC_SIMULATOR" };
    bodies["/api/shadow-mode/decisions"] = { decisions: [] };
    await show(<ShadowMode />);
    expect(screen.getByTestId("shadow-price-source").textContent).toMatch(/synthetic market simulator, not a live market feed or a broker/i);
  });

  it("an unreported price source reads unverified, never live", async () => {
    bodies["/api/shadow-mode/status"] = STATUS;
    bodies["/api/shadow-mode/decisions"] = { decisions: [] };
    await show(<ShadowMode />);
    expect(screen.getByTestId("shadow-price-source").textContent).toMatch(/unverified/i);
  });

  it("a WAIT with no proposed levels shows no stop or target, never invented prices", async () => {
    bodies["/api/shadow-mode/status"] = { ...STATUS, priceSource: "SYNTHETIC_SIMULATOR" };
    bodies["/api/shadow-mode/decisions"] = { decisions: [WAIT_DEC] };
    await show(<ShadowMode />);
    expect(screen.getByText(/no stop or target proposed/i)).toBeTruthy();
    expect(screen.queryByText(/sl 1\.08/)).toBeNull();
  });
});
