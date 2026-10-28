// Ruby Command Center → Memory tab: what the performance-memory cards claim.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => ({
    data: h.data[String(queryKey[0])], isLoading: false, isError: false, refetch: vi.fn(),
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children?: unknown }) => <div>{children as never}</div>,
  LineChart: ({ children }: { children?: unknown }) => <div>{children as never}</div>,
  Line: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null,
}));
vi.mock("@/components/scanner/SelectedMarketPanel", () => ({ SelectedMarketPanel: () => null }));
vi.mock("@/components/ruby/RubyAccountHealthStrip", () => ({ RubyAccountHealthStrip: () => null }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@/components/aiMentor", () => ({
  DailyMentorBriefingCard: () => null, MentorActionItems: () => null, MentorHistory: () => null,
  MentorWarningCard: () => null, isMentorWarningSession: () => false,
}));

const { default: AICommandCenterPage } = await import("./ai-command-center");

function commandCenter(over: Record<string, unknown> = {}) {
  return {
    winRate: 50, netPnl: 1, totalClosedTrades: 12, bestSymbol: "EURUSD", worstSymbol: null,
    bestSetup: null, weakestSetup: null, strongestEdge: null, mostRepeatedMistake: null,
    aiDecisionStats: {
      decisionsCreated: 2, buyCount: 2, sellCount: 0, holdCount: 0, blockedCount: 0,
      avgConfidence: 60, avgRiskScore: 30, avgEdgeScore: 0, decisionToTradeRate: 50, decisionToWinRate: 0,
    },
    learningStats: { learningEvents: 0, strategyEdgesUpdated: 0, mistakePatternsTracked: 0, improvementScore: 0, learningConfidence: 50 },
    insights: [], nextBestActions: [], warnings: [],
    ...over,
  };
}

const AUTOPILOT_NONE_TODAY = {
  last_cycle: null, today_utc: "2026-10-28", today_basis: "UTC", ran_today: false, cycles_today: 0,
  paper_trades_opened_today: 0, paper_trades_closed_today: 0, safety_blocks_today: 0,
};

function openMemory() {
  render(<AICommandCenterPage />);
  fireEvent.mouseDown(screen.getByTestId("tab-memory"), { button: 0, ctrlKey: false });
}

beforeEach(() => { h.data = {}; });
afterEach(() => cleanup());

describe("Memory tab: autopilot today", () => {
  it("no cycle today: says nothing ran today (UTC), not just a row of zeros", () => {
    h.data["ai-cc"] = { commandCenter: commandCenter(), autopilot: AUTOPILOT_NONE_TODAY };
    openMemory();
    expect(screen.getByTestId("autopilot-today-note").textContent).toMatch(/No autopilot cycle has run today \(UTC\)/);
    expect(screen.getByText(/Cycles today \(UTC\)/)).toBeTruthy();
  });

  it("autopilot summary missing: shows it could not be loaded, not 0", () => {
    h.data["ai-cc"] = { commandCenter: commandCenter() };
    openMemory();
    expect(screen.getByTestId("autopilot-cycles-today").textContent).toBe("—");
    expect(screen.getByTestId("autopilot-today-note").textContent).toMatch(/could not be loaded/);
  });

  it("cycles today: shows the counts", () => {
    h.data["ai-cc"] = { commandCenter: commandCenter(), autopilot: { ...AUTOPILOT_NONE_TODAY, ran_today: true, cycles_today: 120, paper_trades_opened_today: 120 } };
    openMemory();
    expect(screen.getByTestId("autopilot-cycles-today").textContent).toBe("120");
    expect(screen.queryByTestId("autopilot-today-note")).toBeNull();
  });
});

describe("Memory tab: AI decision quality", () => {
  it("does not call trade calls without an order 'Blocked'", () => {
    h.data["ai-cc"] = {
      commandCenter: commandCenter({
        aiDecisionStats: {
          decisionsCreated: 2, buyCount: 2, sellCount: 0, holdCount: 0, tradeCalls: 2, tradeCallsWithoutOrder: 1,
          blockedCount: null, avgConfidence: 60, avgRiskScore: 30, avgEdgeScore: 0, decisionToTradeRate: 50, decisionToWinRate: 0,
        },
      }),
      autopilot: AUTOPILOT_NONE_TODAY,
    };
    openMemory();
    const row = screen.getByTestId("decision-calls-without-order");
    expect(row.textContent).toMatch(/Trade calls with no demo order: 1 of 2/);
    expect(screen.queryByText(/Blocked:/)).toBeNull();
  });

  it("an older server's 'blockedCount' (which counted open trades) is not shown as blocked", () => {
    h.data["ai-cc"] = { commandCenter: commandCenter({
      aiDecisionStats: { ...commandCenter().aiDecisionStats, blockedCount: 2 },
    }), autopilot: AUTOPILOT_NONE_TODAY };
    openMemory();
    expect(screen.queryByText(/Blocked:/)).toBeNull();
    expect(screen.getByTestId("decision-calls-without-order").textContent).toMatch(/—/);
  });
});

describe("Memory tab: Improvement Score and setups", () => {
  it("an unmeasured Improvement Score says so instead of 0.00", () => {
    h.data["ai-cc"] = { commandCenter: commandCenter({
      learningStats: {
        learningEvents: 0, strategyEdgesUpdated: 2, mistakePatternsTracked: 0, improvementScore: null,
        improvementScoreBasis: "Not measured: strategy edges keep only their current score, not a history, so change over time cannot be computed.",
        learningConfidence: 50,
      },
    }), autopilot: AUTOPILOT_NONE_TODAY };
    openMemory();
    const v = screen.getByTestId("improvement-score");
    expect(v.textContent).toBe("Not measured");
    expect(screen.getByText(/keep only their current score/)).toBeTruthy();
  });

  it("an older server's 0 Improvement Score is not shown as a measured 0.00", () => {
    h.data["ai-cc"] = { commandCenter: commandCenter(), autopilot: AUTOPILOT_NONE_TODAY };
    openMemory();
    expect(screen.getByTestId("improvement-score").textContent).toBe("Not measured");
  });

  it("best/weakest setup carries its overlapping-sum basis", () => {
    h.data["ai-cc"] = { commandCenter: commandCenter({
      bestSetup: "trend", weakestSetup: "session",
      setupRankingBasis: "Setups are ranked by the summed P&L of the trades each signal supported. A trade supported by several signals counts toward each of them, so these sums overlap and do not add up to your net P&L.",
    }), autopilot: AUTOPILOT_NONE_TODAY };
    openMemory();
    expect(screen.getByTestId("setup-ranking-basis").textContent).toMatch(/counts toward each/);
  });
});
