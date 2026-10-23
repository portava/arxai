// Render proof for the Profit Mission "Performance" view.
//
// Mounts the component with ALL data hooks mocked (no QueryClientProvider, per
// the project's render-proof convention) and asserts the honest, at-a-glance
// story:
//   - backtest vs forward metrics render side by side with honest labels;
//   - the per-side sample-size warning surfaces;
//   - the forward-over-time chart renders when ≥1 forward result exists;
//   - the drift severity badge + history render, and a SEVERE-drift demotion
//     is clearly explained (what demoted, why, risk reduced, promotion paused);
//   - an honest empty state shows when there is NO forward evidence;
//   - NO banned promise vocabulary leaks into the DOM.

import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { MISSION_BANNED_PHRASES } from "@workspace/domain/profit-mission";

// recharts' ResponsiveContainer needs ResizeObserver + nonzero element sizes,
// neither of which jsdom provides. Polyfill them so the trend chart mounts.
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 300 });
});

const metrics = (o: Partial<Record<string, number>>) => ({
  totalTrades: 0,
  winningTrades: 0,
  losingTrades: 0,
  winRate: 0,
  netProfitLoss: 0,
  maxDrawdownPct: 0,
  averageRr: 0,
  expectancyR: 0,
  profitFactor: 0,
  ...o,
});

const backtestResult = {
  id: 1,
  missionId: 1,
  kind: "BACKTEST",
  strategyKey: "flame_scalp",
  symbol: "EURUSD",
  timeframe: "M15",
  label: "Backtest — flame_scalp EURUSD M15",
  sampleSize: 120,
  sampleWarning: null,
  isVerified: true,
  metrics: metrics({ totalTrades: 120, winRate: 0.58, netProfitLoss: 640, maxDrawdownPct: 8, averageRr: 1.9, expectancyR: 0.42, profitFactor: 1.8 }),
  headline: "Backtest looks healthy.",
  notes: [],
  promotionEligible: true,
  createdAt: "2026-06-10T00:00:00.000Z",
};

const forwardResults = [
  {
    id: 2,
    missionId: 1,
    kind: "FORWARD",
    strategyKey: "flame_scalp",
    symbol: "EURUSD",
    timeframe: "M15",
    label: "Forward — real closed trades",
    sampleSize: 6,
    sampleWarning: "Small sample — treat with caution.",
    isVerified: false,
    metrics: metrics({ totalTrades: 6, winRate: 0.33, netProfitLoss: -45, maxDrawdownPct: 14, averageRr: 1.1, expectancyR: -0.12, profitFactor: 0.7 }),
    headline: "Forward is lagging the baseline.",
    notes: [],
    promotionEligible: false,
    createdAt: "2026-06-18T00:00:00.000Z",
  },
  {
    id: 3,
    missionId: 1,
    kind: "FORWARD",
    strategyKey: "flame_scalp",
    symbol: "EURUSD",
    timeframe: "M15",
    label: "Forward — real closed trades",
    sampleSize: 9,
    sampleWarning: "Small sample — treat with caution.",
    isVerified: false,
    metrics: metrics({ totalTrades: 9, winRate: 0.3, netProfitLoss: -80, maxDrawdownPct: 18, averageRr: 1.0, expectancyR: -0.2, profitFactor: 0.6 }),
    headline: "Forward is lagging the baseline.",
    notes: [],
    promotionEligible: false,
    createdAt: "2026-06-20T00:00:00.000Z",
  },
];

const drift = {
  drift: {
    severity: "SEVERE",
    score: 0.7,
    signals: [
      { name: "expectancy", detail: "forward expectancy -0.20R is 148% below historical 0.42R", weight: 0.5 },
      { name: "win_rate", detail: "forward win rate 30.0% is 28.0pp below historical", weight: 0.2 },
    ],
    reasons: ["expectancy: forward expectancy turned negative", "win_rate: forward win rate dropped sharply"],
    recommendDemote: true,
    recommendReduceRisk: true,
    recommendPausePromotion: true,
  },
  demoted: true,
  promotionPaused: true,
  insufficientEvidence: false,
};

const promotion = {
  currentLevel: 2,
  riskReducedByDrift: true,
  decision: { allowedMaxLevel: 2, currentLevel: 2, gates: [] },
  guardrail: { maxLevel: 6 },
};

const driftEvents = [
  { id: 30, missionId: 1, type: "mission_drift_demote", message: "Severe drift — mission demoted.", metadata: { severity: "SEVERE", score: 0.7, demoted: true }, createdAt: "2026-06-20T01:00:00.000Z" },
  { id: 20, missionId: 1, type: "mission_drift_check", message: "Drift check.", metadata: { severity: "MINOR", score: 0.2, demoted: false }, createdAt: "2026-06-19T01:00:00.000Z" },
  { id: 10, missionId: 1, type: "mission_created", message: "Mission created.", metadata: {}, createdAt: "2026-06-10T01:00:00.000Z" },
];

const briefing = { headline: "Stay disciplined; forward results are under review." };
const eod = { headline: "Closed flat after two stop-outs." };
const report = { report: { headline: "Mission report: forward underperforming the backtest." } };

let testResultsData: { results: unknown[] } = { results: [backtestResult, ...forwardResults] };
let driftData: unknown = drift;
let eventsData: unknown[] = driftEvents;

vi.mock("@workspace/api-client-react", () => ({
  useListMissionTestResults: () => ({ data: testResultsData }),
  useGetMissionDrift: () => ({ data: driftData }),
  useGetMissionPromotion: () => ({ data: promotion }),
  useGetMissionBriefing: () => ({ data: briefing }),
  useGetMissionEodReview: () => ({ data: eod }),
  useGetMissionReport: () => ({ data: report }),
  useListProfitMissionEvents: () => ({ data: eventsData }),
  getListMissionTestResultsQueryKey: () => ["mission-test-results", 1],
  getGetMissionDriftQueryKey: () => ["mission-drift", 1],
  getGetMissionPromotionQueryKey: () => ["mission-promotion", 1],
}));

import { MissionPerformanceView } from "./MissionPerformanceView";

afterEach(() => {
  cleanup();
  testResultsData = { results: [backtestResult, ...forwardResults] };
  driftData = drift;
  eventsData = driftEvents;
});

describe("MissionPerformanceView", () => {
  it("charts backtest vs forward with honest labels and per-side sample warnings", () => {
    render(<MissionPerformanceView missionId={1} />);
    const card = screen.getByTestId("card-performance-comparison");
    expect(within(card).getByTestId("cell-backtest-expectancyR").textContent).toMatch(/0\.42R/);
    expect(within(card).getByTestId("cell-forward-expectancyR").textContent).toMatch(/-0\.20R/);
    // Forward expectancy is worse than backtest → "worse" tone delta.
    expect(within(card).getByTestId("cell-delta-expectancyR").className).toMatch(/text-danger/);
    // Honest framing on both sides + the small-sample warning surfaces.
    expect(within(card).getByTestId("summary-backtest").textContent).toMatch(/historical/i);
    expect(within(card).getByTestId("summary-forward").textContent).toMatch(/real closed trades/i);
    expect(within(card).getByTestId("summary-forward-warning").textContent).toMatch(/small sample/i);
  });

  it("renders the forward-over-time chart with a backtest baseline reference", () => {
    render(<MissionPerformanceView missionId={1} />);
    expect(screen.getByTestId("chart-performance-trend")).toBeTruthy();
  });

  it("surfaces drift severity, history, and a SEVERE demotion explanation", () => {
    render(<MissionPerformanceView missionId={1} />);
    expect(screen.getByTestId("badge-drift-severity").textContent).toMatch(/severe/i);
    const panel = screen.getByTestId("alert-drift-demotion");
    expect(panel.textContent).toMatch(/severe drift/i);
    // The demotion explanation covers what/why/risk/promotion.
    expect(screen.getByTestId("demotion-what").textContent).toMatch(/automation/i);
    expect(screen.getByTestId("demotion-risk").textContent).toMatch(/risk/i);
    expect(screen.getByTestId("demotion-promotion").textContent).toMatch(/promotion.*paused/i);
    expect(screen.getByTestId("demotion-why").textContent).toMatch(/expectancy/i);
    // History only includes drift events (not the mission_created event).
    const history = screen.getByTestId("list-drift-history");
    expect(within(history).getByTestId("drift-history-30")).toBeTruthy();
    expect(within(history).getByTestId("drift-history-20")).toBeTruthy();
    expect(within(history).queryByTestId("drift-history-10")).toBeNull();
    expect(within(history).getByTestId("drift-history-demoted-30").textContent).toMatch(/demoted/i);
  });

  it("shows an honest empty state when there is no real forward evidence", () => {
    testResultsData = { results: [backtestResult] };
    driftData = { drift: { severity: "UNKNOWN", score: 0, signals: [], reasons: [], recommendDemote: false, recommendReduceRisk: false, recommendPausePromotion: false }, demoted: false, promotionPaused: false, insufficientEvidence: true };
    eventsData = [];
    render(<MissionPerformanceView missionId={1} />);
    expect(screen.getByTestId("empty-performance-trend").textContent).toMatch(/no real forward trades yet/i);
    expect(screen.getByTestId("summary-forward-empty").textContent).toMatch(/nothing is estimated/i);
    expect(screen.getByTestId("text-drift-insufficient")).toBeTruthy();
    expect(screen.getByTestId("empty-drift-history").textContent).toMatch(/no drift checks/i);
  });

  it("never leaks banned promise vocabulary", () => {
    const { container } = render(<MissionPerformanceView missionId={1} />);
    const text = (container.textContent ?? "").toLowerCase();
    for (const phrase of MISSION_BANNED_PHRASES) {
      expect(text.includes(phrase), `banned phrase leaked: ${phrase}`).toBe(false);
    }
  });
});
