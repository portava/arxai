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
import ShadowJournal from "./shadow-journal";
import ConfidenceCalibration from "./confidence-calibration";
import StrategyPromotion from "./strategy-promotion";
import AiReadinessScore from "./ai-readiness-score";

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

  it("idle because shadow mode stopped says so, and unranked strategies are listed, not scored", async () => {
    bodies["/api/strategy-tournament/results"] = {
      running: false, idleReason: "SHADOW_STOPPED", startedAt: null, ranked: [],
      unranked: [{ strategy: "Session Breakout", decisions: 3, reason: "No tracked win or loss yet" }],
      leaderboard: { bestOverall: null, worst: null },
    };
    await show(<StrategyTournament />);
    expect(screen.getByText("IDLE — shadow mode is stopped")).toBeTruthy();
    expect(screen.getByText(/No strategy has a tracked win or loss yet/)).toBeTruthy();
    expect(screen.getByTestId("tournament-unranked").textContent).toMatch(/Session Breakout \(3 decisions\)/);
  });

  it("the Grade column says it is confidence ÷ 10, not an independent trade grade", async () => {
    bodies["/api/strategy-tournament/results"] = { running: true, startedAt: null, ranked: [ROW], leaderboard: {} };
    await show(<StrategyTournament />);
    expect(screen.getByText("Grade (conf÷10)").getAttribute("title")).toMatch(/not an independent trade grade/);
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

  it("ideas nobody tracked say so, and the untracked count is shown", async () => {
    bodies["/api/shadow-mode/status"] = { ...STATUS, priceSource: "SYNTHETIC_SIMULATOR", untracked: 2 };
    bodies["/api/shadow-mode/decisions"] = { decisions: [
      { ...WAIT_DEC, id: "a", action: "BUY", sl: 1.08, tp: 1.095, status: "SHADOW_EXPIRED",
        outcomeAt: "2026-10-01T10:02:00Z", untrackedReason: "TRACKING_STOPPED" },
      { ...WAIT_DEC, id: "b", action: "BUY", sl: 1.08, tp: 1.095, status: "SHADOW_TRADE_IDEA",
        untrackedReason: "TRACKER_NOT_RUNNING" },
    ] };
    await show(<ShadowMode />);
    expect(screen.getByText(/shadow mode was stopped at .*before this idea reached its stop or target/i)).toBeTruthy();
    expect(screen.getByText(/shadow mode was stopped when this decision was made/i)).toBeTruthy();
    expect(screen.getByText("Outcome not tracked").nextSibling?.textContent).toBe("2");
  });
});

describe("Shadow Journal", () => {
  it("a finished idea with no measured R reads NOT MEASURED, not PENDING", async () => {
    bodies["/api/shadow-journal"] = { entries: [{
      id: "e1", ts: "2026-10-01T10:00:00Z", symbol: "EURUSD", strategy: "Trend Continuation", marketCondition: "MIXED",
      aiSaw: "r", whatHappened: "SHADOW_EXPIRED — R not measured: neither stop nor target was reached before the window ended",
      rightOrWrong: "NOT_MEASURED", lesson: "Expired without reaching its stop or target; the cause was not analysed.",
    }] };
    await show(<ShadowJournal />);
    expect(screen.getByText("NOT MEASURED")).toBeTruthy();
    expect(screen.queryByText("PENDING")).toBeNull();
  });
});

describe("Confidence Calibration", () => {
  it("an empty bucket reads 'no data', never 0%", async () => {
    bodies["/api/confidence-calibration"] = {
      totalSample: 20, label: "NEEDS_MORE_DATA",
      labelBasis: "Needs at least 20 tracked outcomes with 10+ at confidence 80-100 and 10+ at 50-70; observed 20 in total, 0 high and 20 low.",
      buckets: [
        { bucket: "60-70", sample: 20, winRate: 60, avgR: 0.8 },
        { bucket: "80-90", sample: 0, winRate: null, avgR: null },
        // An older server sends 0 for an empty bucket: still "no data".
        { bucket: "90-100", sample: 0, winRate: 0, avgR: 0 },
      ],
    };
    await show(<ConfidenceCalibration />);
    expect(screen.getAllByText("no data")).toHaveLength(2);
    expect(screen.queryByText("0%")).toBeNull();
    expect(screen.getByText("60%")).toBeTruthy();
    expect(screen.getByText(/0 high and 20 low/)).toBeTruthy();
  });
});

describe("Strategy Promotion", () => {
  const GATE = {
    strategy: "Session Breakout", level: "TESTING", demotion: null, updatedAt: null, lastReason: null, eligibleFor: null,
    stats: { sample: 4, tracked: 0, winRate: 0, avgR: 0, drawdownR: 0, rgViolations: 0, expectancy: 0 },
  };

  it("a strategy with no tracked outcome shows no win rate or R, and an untouched gate has no reason", async () => {
    bodies["/api/strategy-promotion"] = { strategies: [GATE], demotionSuggestions: [{ strategy: "Session Breakout", suggested: null, reasons: [], tracked: 0 }] };
    await show(<StrategyPromotion />);
    expect(screen.getByText(/no tracked win or loss yet, so no win rate or R/)).toBeTruthy();
    expect(screen.queryByText(/wr=0%/)).toBeNull();
    expect(screen.getByText("No promotion or demotion recorded yet.")).toBeTruthy();
    expect(screen.getByText(/No demotions suggested for the 1 strategy checked\. 0 of 1 had the 10\+ tracked outcomes/)).toBeTruthy();
  });

  it("with nothing checked it does not claim 'No demotions suggested'", async () => {
    bodies["/api/strategy-promotion"] = { strategies: [], demotionSuggestions: [] };
    await show(<StrategyPromotion />);
    expect(screen.queryByText(/No demotions suggested/)).toBeNull();
    expect(screen.getByText(/none was checked for demotion/)).toBeTruthy();
  });
});

describe("AI Readiness Score", () => {
  it("unmeasured factors read 'not measured', with no bar or number", async () => {
    bodies["/api/ai-readiness-score"] = {
      score: 50, label: "NEEDS_MORE_TESTING", factors: { riskDiscipline: 100, sampleSize: 0 },
      notMeasured: [{ factor: "safetyCompliance", why: "No safety-compliance check feeds this score." }],
      trackedOutcomes: 0,
      basis: "Average of 2 measured factors over 0 tracked outcomes; 1 not measured and not scored.",
      realBrokerReadiness: "Real broker readiness unavailable until MT5 bridge is connected.",
    };
    await show(<AiReadinessScore />);
    const nm = screen.getByTestId("readiness-not-measured");
    expect(nm.textContent).toMatch(/safetyCompliance/);
    expect(nm.textContent).toMatch(/Not measured — no points/);
    expect(nm.textContent).not.toMatch(/\b100\b/);
    expect(screen.getByTestId("readiness-basis").textContent).toMatch(/over 0 tracked outcomes/);
  });
});
