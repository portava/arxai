/**
 * Fund Control overview truth:
 *  - A bridge that never reported equity is sent as 0 (accountEquityReported
 *    false). The mirrored equity total must say it leaves that bridge out,
 *    not present a partial sum as the whole.
 *  - Reconciliation, capital-queue and allocation rows come from queries that
 *    do not gate the skeleton; while they load they must read "Loading", not
 *    0 / "No reconciliation run recorded yet."
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

type Q = { data?: unknown; isLoading?: boolean; isError?: boolean; isFetching?: boolean; refetch?: () => void };
const h = vi.hoisted(() => ({
  pools: {} as Q,
  recon: {} as Q,
  mirror: {} as Q,
  pl: {} as Q,
  requests: {} as Q,
  settings: {} as Q,
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetAdminFundBookPools: () => h.pools,
  useGetAdminFundBookReconciliationOverview: () => h.recon,
  useGetAdminFundBookBrokerMirror: () => h.mirror,
  useGetAdminFundBookPlAllocation: () => h.pl,
  useListAdminCapitalRequests: () => h.requests,
  useGetAdminCapitalSettings: () => h.settings,
}));

import { OverviewSection } from "./OverviewSection";

function bridge(id: number, equity: number, reported: boolean) {
  return {
    bridgeConnectionId: id, status: "CONNECTED", accountType: "DEMO",
    accountBalance: reported ? equity : 0, accountEquity: reported ? equity : 0,
    margin: 0, freeMargin: 0, freshness: "FRESH", openPositionCount: 0, floatingPlTotal: 0,
    accountBalanceReported: reported, accountEquityReported: reported,
  };
}

const loaded = (data: unknown): Q => ({ data, isLoading: false, isError: false });

beforeEach(() => {
  h.pools = loaded({ pools: [] });
  h.mirror = loaded({ bridges: [bridge(1, 1000, true), bridge(2, 0, false), bridge(3, 500, true)], openPositions: [] });
  h.recon = loaded({ openCount: 0, criticalOpenCount: 0, investigatingCount: 0, activeFreezes: [], lastRunAt: new Date().toISOString() });
  h.pl = loaded({ assignedTotal: 0, assignedCount: 0, unassigned: [], unavailableCount: 0 });
  h.requests = loaded({ requests: [] });
  h.settings = loaded({ settings: { managementFeeAnnualPct: 2, performanceFeePct: 20 } });
});
afterEach(() => cleanup());

describe("OverviewSection mirrored equity total", () => {
  it("discloses the bridge whose equity was never reported instead of counting it as $0", () => {
    render(<OverviewSection />);
    const card = screen.getByTestId("kpi-broker-equity").parentElement as HTMLElement;
    expect(card.textContent).toMatch(/1 of 3 bridges/);
    expect(card.textContent).toMatch(/not included/i);
  });

  it("says Unavailable when no bridge reported equity", () => {
    h.mirror = loaded({ bridges: [bridge(1, 0, false), bridge(2, 0, false)], openPositions: [] });
    render(<OverviewSection />);
    expect(screen.getByTestId("kpi-broker-equity").textContent).toMatch(/Unavailable/);
  });

  it("adds no disclosure when every bridge reported equity", () => {
    h.mirror = loaded({ bridges: [bridge(1, 1000, true)], openPositions: [] });
    render(<OverviewSection />);
    const card = screen.getByTestId("kpi-broker-equity").parentElement as HTMLElement;
    expect(card.textContent).not.toMatch(/not included/i);
  });
});

describe("OverviewSection secondary queries while loading", () => {
  it("shows reconciliation as loading, not 0 discrepancies or 'no run recorded'", () => {
    h.recon = { isLoading: true };
    render(<OverviewSection />);
    expect(screen.queryByTestId("kpi-open-discrepancies")).toBeNull();
    expect(screen.queryByTestId("kpi-critical-discrepancies")).toBeNull();
    expect(screen.queryByText(/No reconciliation run recorded yet/)).toBeNull();
    expect(screen.getByTestId("kpi-recon-loading").textContent).toMatch(/Loading/);
  });

  it("shows allocation as loading, not 0 unassigned positions", () => {
    h.pl = { isLoading: true };
    render(<OverviewSection />);
    expect(screen.queryByTestId("kpi-unassigned-positions")).toBeNull();
    expect(screen.getByTestId("kpi-allocation-loading").textContent).toMatch(/Loading/);
  });

  it("shows the capital queue as loading, not 0 pending requests", () => {
    h.requests = { isLoading: true };
    render(<OverviewSection />);
    expect(screen.queryByTestId("kpi-pending-deposits")).toBeNull();
    expect(screen.queryByTestId("kpi-pending-withdrawals")).toBeNull();
    expect(screen.getByTestId("kpi-capital-loading").textContent).toMatch(/Loading/);
  });

  it("does not call the fee policy unavailable while it is still loading", () => {
    h.settings = { isLoading: true };
    render(<OverviewSection />);
    const card = screen.getByTestId("kpi-fees-accrued").parentElement as HTMLElement;
    expect(card.textContent).not.toMatch(/Fee policy unavailable/);
    expect(card.textContent).toMatch(/loading/i);
  });
});
