import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SelfTradeAccountingCoverage } from "@workspace/api-client-react";
import { AccountingSummary } from "./AccountingSummary";
const queries = vi.hoisted(() => ({ overview: {} as any, detail: {} as any }));
vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useGetSelfTradeOverview: () => queries.overview,
  useGetSelfTradeAgentById: () => queries.detail,
  useGetSelfTradeAgentLedger: () => ({ data: { entries: [] } }),
  useAdminFundSelfTradeAgent: () => ({ mutate: vi.fn(), isPending: false }),
  useAdminDefundSelfTradeAgent: () => ({ mutate: vi.fn(), isPending: false }),
  useAdminSetSelfTradeAutonomy: () => ({ mutate: vi.fn(), isPending: false }),
  useAdminSetSelfTradeStatus: () => ({ mutate: vi.fn(), isPending: false }),
}));
import { OverviewTab, AgentDetailPanel } from "@/pages/admin/self-trade-ai";
const recorded: SelfTradeAccountingCoverage = {
  status: "RECORDED",
  asOf: "2026-10-26T12:00:00Z",
  dayStart: "2026-10-26T00:00:00Z",
  closedTrades: 1,
  recordedTrades: 1,
  unknownTrades: 0,
  unresolvedAccounting: 0,
  unknownCloseTime: 0,
  missingLedgers: 0,
  unpostedTrades: 0,
  unreconciledLedgers: 0,
  unmatchedPostings: 0,
  recordedRealizedPnl: 0,
  recordedAvailableFunds: 1000,
  dailyRecordedPnl: 0,
  dailyLossUsed: 0,
  notes: [
    "Recorded book values; coverage does not verify broker history, fees or a current account balance.",
  ],
};
const incomplete: SelfTradeAccountingCoverage = {
  ...recorded,
  status: "INCOMPLETE",
  closedTrades: 2,
  unknownTrades: 1,
  unresolvedAccounting: 1,
  recordedRealizedPnl: 25,
  dailyLossUsed: null,
};
function detailPanel() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AgentDetailPanel agentId={1} />
    </QueryClientProvider>,
  );
}
afterEach(cleanup);
beforeEach(() => {
  queries.overview = {
    data: {
      totalAgents: 1,
      activeAgents: 1,
      fundedAgents: 1,
      totalAllocated: 1000,
      totalAvailable: 1000,
      totalOpenPnl: 0,
      totalRealizedPnl: 0,
      byStatus: { ACTIVE: 1 },
      accounting: recorded,
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
  queries.detail = {
    data: {
      agent: { id: 1, status: "ACTIVE", autonomyLevel: 0 },
      ledger: { allocatedFunds: 1000, availableFunds: 1000, realizedPnl: 0 },
      accounting: recorded,
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
});
describe("recorded accounting coverage", () => {
  it("renders a genuine recorded zero, its coverage and UTC period", () => {
    render(<AccountingSummary accounting={recorded} />);
    expect(screen.getByText("Recorded accounting")).toBeTruthy();
    expect(screen.getByTestId("recorded-pnl").textContent).toBe("$0.00");
    expect(screen.getByTestId("daily-loss").textContent).toBe("$0.00");
    expect(screen.getByText(/1 of 1 closed trades/)).toBeTruthy();
    expect(screen.getByText("Daily net loss (UTC)")).toBeTruthy();
    expect(
      screen.getByText("Recorded outcomes for 2026-10-26 (UTC)"),
    ).toBeTruthy();
    expect(screen.getByText(/does not verify broker history/)).toBeTruthy();
  });
  it("shows the known subtotal while explicitly withholding complete P&L and daily loss", () => {
    render(<AccountingSummary accounting={incomplete} />);
    expect(screen.getByText("Accounting incomplete")).toBeTruthy();
    expect(screen.getByText(/Total P&L is unavailable/)).toBeTruthy();
    expect(screen.getByTestId("recorded-pnl").textContent).toBe("$25.00");
    expect(screen.getByTestId("daily-loss").textContent).toBe("—");
    expect(screen.getByText(/1 of 2 closed trades/)).toBeTruthy();
    expect(screen.getByText(/1 unresolved accounting holds/)).toBeTruthy();
  });
  it("unknown server coverage is not interpreted as a zero outcome", () => {
    render(<AccountingSummary />);
    expect(screen.getByText(/Accounting coverage is unavailable/)).toBeTruthy();
    expect(screen.getByTestId("recorded-pnl").textContent).toBe("—");
    expect(screen.getByTestId("daily-loss").textContent).toBe("—");
  });
  it("missing and non-finite amounts never display NaN, Infinity or invented zero", () => {
    render(
      <AccountingSummary
        accounting={{
          ...recorded,
          status: "UNAVAILABLE",
          recordedRealizedPnl: NaN,
          recordedAvailableFunds: null,
          dailyLossUsed: Infinity,
        }}
      />,
    );
    expect(screen.getByTestId("recorded-pnl").textContent).toBe("—");
    expect(screen.getByTestId("daily-loss").textContent).toBe("—");
  });
  it("an unknown result does not turn recorded zero green or make it a complete total", () => {
    render(
      <AccountingSummary
        accounting={{ ...incomplete, recordedRealizedPnl: 0 }}
      />,
    );
    expect(screen.getByTestId("recorded-pnl").textContent).toBe("$0.00");
    expect(screen.getByTestId("recorded-pnl").className).not.toMatch(
      /green|emerald|success/,
    );
    expect(screen.getByText(/Total P&L is unavailable/)).toBeTruthy();
  });
});
describe("actual self-trade read surfaces", () => {
  it("overview consumes accounting coverage and labels stored capital", () => {
    queries.overview.data.accounting = incomplete;
    render(<OverviewTab />);
    expect(screen.getByText("Accounting incomplete")).toBeTruthy();
    expect(screen.getByText("Recorded allocation")).toBeTruthy();
    expect(screen.getByText("Recorded open P&L")).toBeTruthy();
    expect(screen.getByTestId("daily-loss").textContent).toBe("—");
    expect(screen.queryByText("Realized P&L")).toBeNull();
  });
  it("an old overview response has an explicit unknown fallback", () => {
    delete queries.overview.data.accounting;
    render(<OverviewTab />);
    expect(screen.getByText(/Accounting coverage is unavailable/)).toBeTruthy();
  });
  it("failed overview refresh withdraws cached accounting", () => {
    queries.overview.isError = true;
    render(<OverviewTab />);
    expect(screen.getByText("Couldn't load overview")).toBeTruthy();
    expect(screen.queryByTestId("recorded-pnl")).toBeNull();
  });
  it("agent detail uses the same coverage presentation", () => {
    queries.detail.data.accounting = incomplete;
    detailPanel();
    expect(screen.getByText("Accounting incomplete")).toBeTruthy();
    expect(screen.getByTestId("recorded-pnl").textContent).toBe("$25.00");
  });
  it("failed detail refresh withdraws cached accounting", () => {
    queries.detail.isError = true;
    detailPanel();
    expect(screen.getByText("Couldn't load agent")).toBeTruthy();
    expect(screen.queryByTestId("recorded-pnl")).toBeNull();
  });
  it("agent detail cannot label missing capital as an available zero", () => {
    queries.detail.data.ledger = null;
    delete queries.detail.data.accounting;
    detailPanel();
    expect(screen.getByText("— recorded available")).toBeTruthy();
    expect(screen.getByText(/Accounting coverage is unavailable/)).toBeTruthy();
  });
});
