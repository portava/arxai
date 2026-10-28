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
