// Profit Mission Phase 3 (fallback reconstruction from Task #662 spec) — render
// proof for the War Room tab (Agent Desk + Proposals).
//
// Mounts the real page with ALL data hooks mocked (no QueryClientProvider, per
// the project's render-proof convention), switches to the "War Room" tab (Radix
// tabs activate on focus in jsdom, so focus+click — see the radix-tabs jsdom
// memory), and asserts:
//   - the Agent Desk renders the mission's specialist team (advisory framing).
//   - the Proposals list renders each scouted setup, surfacing a Risk veto on an
//     unsafe proposal and the Judge's selection on the best one.
//   - the honest scan-result banner renders.
//   - NO banned promise vocabulary leaks into the rendered DOM, and no execution
//     affordance ("place"/"buy now"-style) appears — this surface is read-only.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { MISSION_BANNED_PHRASES } from "@workspace/domain/profit-mission";

const mission = {
  id: 1,
  status: "draft",
  startingAmount: 1000,
  targetAmount: 1300,
  riskProfile: "balanced",
  math: {
    startingAmount: 1000,
    targetAmount: 1300,
    currentValue: 1000,
    requiredProfit: 300,
    requiredReturnPct: 30,
    remainingProfit: 300,
    totalDays: 7,
    tradingDays: 5,
    elapsedDays: 0,
    remainingDays: 7,
    requiredDailyProfit: 42.86,
    requiredSessionProfit: 60,
    requiredHourlyProfit: 7.5,
    requiredDailyReturnPct: 3.82,
    progressPct: 0,
    progressPctClamped: 0,
    timeElapsedPct: 0,
    currentDailyProfit: 0,
    paceRatio: 0,
    onTrack: false,
    invalid: false,
    invalidReasons: [],
  },
  feasibility: {
    tier: "Aggressive",
    feasibilityScore: 34,
    riskScore: 66,
    recommendedRiskProfile: "aggressive",
    missionType: "high_risk_sprint",
    warnings: [],
    explanation: "Planning estimate.",
    canStart: false,
    startBlockReason: "NO_FEED",
    isEstimate: true,
  },
  probability: {
    targetHitProbability: 29,
    drawdownRisk: 47,
    failureProbability: 71,
    projections: {
      best: { endingValue: 1300, profit: 300, returnPct: 30 },
      expected: { endingValue: 1087, profit: 87, returnPct: 8.7 },
      worst: { endingValue: 800, profit: -200, returnPct: -20 },
    },
    confidence: "low",
    sampleSize: 0,
    sampleSizeWarnings: [],
    isEstimate: true,
    disclaimer: "Estimates only, not a promise of profit. Possible loss is real.",
  },
};

const agents = [
  { id: 11, missionId: 1, agentKey: "SCALPER", registryAgentKey: "scalp_specialist", name: "Scalper", role: "Momentum scalps", status: "active", rank: 0, weight: 1, performance: null, createdAt: "2026-06-20T00:00:00.000Z" },
  { id: 12, missionId: 1, agentKey: "TREND", registryAgentKey: "trend_specialist", name: "Trend Rider", role: "Trend continuation", status: "active", rank: 0, weight: 1, performance: null, createdAt: "2026-06-20T00:00:00.000Z" },
  { id: 13, missionId: 1, agentKey: "RISK", registryAgentKey: "risk_governor", name: "Risk Officer", role: "Vetoes unsafe setups", status: "active", rank: 0, weight: 1, performance: null, createdAt: "2026-06-20T00:00:00.000Z" },
  { id: 14, missionId: 1, agentKey: "JUDGE", registryAgentKey: "execution_judge", name: "Execution Judge", role: "Selects the best or no trade", status: "active", rank: 0, weight: 1, performance: null, createdAt: "2026-06-20T00:00:00.000Z" },
];

const proposals = [
  {
    id: 101,
    proposalId: "1:TREND:1",
    missionId: 1,
    missionAgentId: 12,
    agentKey: "TREND",
    symbol: "EURUSD",
    timeframe: "M15",
    direction: "BUY",
    setupType: "breakout",
    confidence: 82,
    urgency: "high",
    entryPlan: { entryPrice: 1.1, entryZoneLow: null, entryZoneHigh: null },
    riskPlan: { stopLoss: 1.09, takeProfit: 1.13, riskAmount: null, expectedR: 3 },
    marketSnapshot: null,
    warnings: [],
    reason: "Structure break with momentum.",
    invalidationLevel: null,
    status: "selected",
    selectionReason: "Highest conviction survivor.",
    rejectionReason: null,
    riskObjection: null,
    judgeDecision: "best",
    createdAt: "2026-06-20T00:00:00.000Z",
  },
  {
    id: 102,
    proposalId: "1:SCALPER:1",
    missionId: 1,
    missionAgentId: 11,
    agentKey: "SCALPER",
    symbol: "XAUUSD",
    timeframe: "M15",
    direction: "SELL",
    setupType: "fade",
    confidence: 61,
    urgency: "medium",
    entryPlan: { entryPrice: 2350, entryZoneLow: null, entryZoneHigh: null },
    riskPlan: { stopLoss: null, takeProfit: 2330, riskAmount: null, expectedR: null },
    marketSnapshot: null,
    warnings: [],
    reason: "Mean-reversion fade.",
    invalidationLevel: null,
    status: "vetoed",
    selectionReason: null,
    rejectionReason: "No protective stop on the setup.",
    riskObjection: "No protective stop on the setup.",
    judgeDecision: null,
    createdAt: "2026-06-20T00:00:00.000Z",
  },
];

const scanResult = {
  proposals,
  selectedProposalId: "1:TREND:1",
  judgeDecision: "best" as const,
  judgeReason: "Selected the highest-conviction survivor.",
  liveFeedConnected: true,
  symbolsScanned: 4,
};

// Phase 6 risk read: protective mode, a medium blow-up score, an active
// cooldown, and martingale explicitly disabled — exercises the Risk Control
// panel's full surface.
const riskState = {
  asOf: "2026-06-20T00:00:00.000Z",
  mode: "protect" as const,
  ladderAction: "reduce_risk" as const,
  pace: "behind" as const,
  drawdownPct: 12,
  peakValue: 1000,
  missionLossPct: 12,
  dailyLossPct: 4,
  budgetUsedPct: 55,
  riskMultiplier: 0.5,
  consecutiveLosses: 2,
  tradesToday: 3,
  budget: {
    maxTradesPerDay: 6,
    maxScalpsPerSession: 3,
    maxLossPerTradePct: 2,
    maxLossPerDayPct: 6,
    maxLossPerSessionPct: 4,
    maxMissionDrawdownPct: 20,
    maxSameSymbolExposure: 1,
    maxCorrelatedExposure: 2,
    maxConsecutiveLosses: 3,
    cooldownAfterLossMinutes: 15,
    cooldownAfterStreakMinutes: 60,
    martingaleAllowed: false,
  },
  blowup: { level: "medium" as const, action: "reduce_risk" as const, score: 48, factors: ["drawdown"] },
  behavioral: { overtrading: false, revenge: false, cooldownTriggered: true, scoreDock: 5 },
  emergency: { triggered: false, action: "none" as const, primary: null, conditions: [] },
  reasons: ["Behind pace — risk reduced, scan frequency unchanged."],
};

const pulse = {
  id: 1,
  currentValue: 880,
  math: mission.math,
  feasibility: mission.feasibility,
  probability: mission.probability,
  risk: riskState,
  asOf: "2026-06-20T00:00:00.000Z",
};

vi.mock("@workspace/api-client-react", () => ({
  useListProfitMissions: () => ({ data: [mission], isLoading: false }),
  useCreateProfitMission: () => ({ mutate: vi.fn(), isPending: false }),
  usePauseProfitMission: () => ({ mutate: vi.fn(), isPending: false }),
  useResumeProfitMission: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelProfitMission: () => ({ mutate: vi.fn(), isPending: false }),
  getListProfitMissionsQueryKey: () => ["profit-missions"],
  useListProfitMissionEvents: () => ({ data: [], isLoading: false }),
  getListProfitMissionEventsQueryKey: () => ["mission-events", 1],
  useListMissionAgents: () => ({ data: agents, isLoading: false }),
  useListMissionProposals: () => ({ data: proposals, isLoading: false }),
  useRunMissionScan: () => ({ mutate: vi.fn(), isPending: false, data: scanResult }),
  getListMissionAgentsQueryKey: () => ["mission-agents", 1],
  getListMissionProposalsQueryKey: () => ["mission-proposals", 1],
  useListMissionTradeDrafts: () => ({ data: [], isLoading: false }),
  getListMissionTradeDraftsQueryKey: () => ["mission-trade-drafts", 1],
  useApproveMissionProposalDraft: () => ({ mutate: vi.fn(), isPending: false }),
  useRejectMissionProposalDraft: () => ({ mutate: vi.fn(), isPending: false }),
  useExecuteMissionProposalDraft: () => ({ mutate: vi.fn(), isPending: false }),
  useGetProfitMissionPulse: () => ({ data: pulse, isLoading: false }),
  getGetProfitMissionPulseQueryKey: () => ["mission-pulse", 1],
  useEmergencyStopProfitMission: () => ({ mutate: vi.fn(), isPending: false }),
  useParseProfitMissionIntent: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import ProfitMissionsPage from "./profit-missions";

afterEach(() => cleanup());

function openWarRoom() {
  render(<ProfitMissionsPage />);
  const tab = screen.getByTestId("page-tab-war-room");
  fireEvent.focus(tab);
  fireEvent.click(tab);
}

describe("Profit Mission War Room (Phase 3 — multi-agent proposals)", () => {
  it("renders the Agent Desk with the mission's specialist team (advisory framing)", () => {
    openWarRoom();
    const desk = screen.getByTestId("card-agent-desk");
    expect(desk.textContent).toMatch(/advisory only/i);
    const list = screen.getByTestId("list-agents");
    expect(within(list).getByTestId("agent-TREND")).toBeTruthy();
    expect(within(list).getByTestId("agent-RISK")).toBeTruthy();
    expect(within(list).getByTestId("agent-JUDGE")).toBeTruthy();
  });

  it("renders each proposal, surfacing the Risk veto and the Judge's selection", () => {
    openWarRoom();
    const list = screen.getByTestId("list-proposals");
    // The selected (best) proposal and its judge note.
    expect(within(list).getByTestId("proposal-1:TREND:1")).toBeTruthy();
    expect(within(list).getByTestId("proposal-status-1:TREND:1").textContent).toMatch(/selected/i);
    expect(within(list).getByText(/judge:/i)).toBeTruthy();
    // The vetoed proposal surfaces the Risk objection.
    expect(within(list).getByTestId("proposal-veto-1:SCALPER:1").textContent).toMatch(/risk:/i);
  });

  it("renders the honest scan-result banner and a read-only 'Run agents' control", () => {
    openWarRoom();
    expect(screen.getByTestId("alert-scan-result").textContent).toMatch(/scanned 4 market/i);
    // The only action is to RUN the advisory agents — never to place a trade.
    expect(screen.getByTestId("button-run-scan").textContent).toMatch(/run agents/i);
  });

  it("renders the Phase 6 Risk Control panel: protective mode, blow-up, drawdown, no-martingale + emergency stop", () => {
    openWarRoom();
    const panel = screen.getByTestId("card-risk-control");
    // Protective mode badge (stricter-only state surfaced honestly).
    expect(within(panel).getByTestId("badge-risk-mode").textContent).toMatch(/protect/i);
    // Blow-up risk + multiplier (Metric: bare testId) + drawdown / budget
    // (Meter: testId-value) render real values.
    expect(within(panel).getByTestId("metric-blowup-level").textContent).toMatch(/medium/i);
    expect(within(panel).getByTestId("metric-risk-multiplier").textContent).toMatch(/0\.50×/);
    expect(within(panel).getByTestId("meter-drawdown-value").textContent).toMatch(/12%/);
    expect(within(panel).getByTestId("meter-budget-used-value").textContent).toMatch(/55%/);
    // An active cooldown is surfaced, martingale is explicitly disabled, and the
    // only control is a non-executing emergency stop.
    expect(within(panel).getByTestId("alert-cooldown")).toBeTruthy();
    expect(within(panel).getByTestId("text-no-martingale").textContent).toMatch(/never increases after a loss/i);
    const stop = within(panel).getByTestId("button-emergency-stop");
    expect(stop.textContent).toMatch(/emergency stop/i);
    expect(panel.textContent).toMatch(/does not place or close any order/i);
  });

  it("never leaks banned promise vocabulary into the War Room DOM", () => {
    const { container } = render(<ProfitMissionsPage />);
    const tab = within(container).getByTestId("page-tab-war-room");
    fireEvent.focus(tab);
    fireEvent.click(tab);
    const text = (container.textContent ?? "").toLowerCase();
    for (const phrase of MISSION_BANNED_PHRASES) {
      expect(text.includes(phrase), `banned phrase leaked: ${phrase}`).toBe(false);
    }
  });
});
