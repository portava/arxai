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
