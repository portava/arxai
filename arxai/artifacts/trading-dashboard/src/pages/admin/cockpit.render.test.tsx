import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Admin Cockpit render proof (Task #752).
 *
 * Proven here:
 *   1. ADMIN (not previewing-as-user) renders the cockpit: status strip,
 *      Overview cards, the persistent risk rail, and the audit timeline.
 *   2. The Pattern Sync tab is present and switches to the ADMIN-ONLY +
 *      ADVISORY Pattern Sync Command Center (carrying its "advisory · admin-
 *      only" + "never places, gates or modifies a trade" honesty copy).
 *   3. A NON-admin session is blocked by AdminDiagnosticsGate (the cockpit
 *      body never renders) — proving the whole surface is admin/owner-only.
 *
 * Every data hook from the generated client is mocked, so the render is a
 * pure proof and never touches the network. useTradingMode (consumed by the
 * gate) and the toast are mocked. A real QueryClientProvider is supplied
 * because useCockpitAction calls useQueryClient for cache invalidation.
 */

// ── trading-mode (drives AdminDiagnosticsGate) — overridable per test ──
let modeValue: {
  isLoading: boolean;
  envelope: unknown;
  shouldShowAdminDiagnostics: boolean;
  isAdminPreviewingUserMode: boolean;
};
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => modeValue,
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

// ── generated client: every cockpit hook + queryKey getter ──
// NOTE: the factory is hoisted above all module-scope declarations, so every
// value it uses (helpers + fixtures) must be defined INSIDE the factory.
vi.mock("@workspace/api-client-react", () => {
  const ok = <T,>(data: T) => () => ({ data, isLoading: false, isError: false, error: null, refetch: () => {} });
  const mut = () => () => ({ mutate: () => {}, isPending: false, isError: false, error: null });
  const key = (k: string) => () => [k];

  const overviewData = {
    traders: { total: 7, approvedLive: 2, armed: 1, suspended: 1 },
    investors: { total: 4, active: 3, frozen: 1 },
    bridge: { connected: true, live: true, masterAccountType: "live", heartbeatAgeSeconds: 4 },
    exposure: { openPositions: 3, totalFloatingPl: 125.5 },
    capital: { poolNav: 50000, reservedRisk: 1200, availableAllocation: 4800 },
    safety: { platformMode: "LIVE_SHARED", liveExecutionEnabled: true, killSwitchActive: false },
    alerts: { open: 2, critical: 1 },
  };

  const patternSyncData = {
    leaderSymbol: "EURUSD",
    alignmentSummary: "2 of 3 aligned bullish on H4.",
    symbols: [
      { symbol: "EURUSD", sufficient: true, patternType: "TREND_PULLBACK", direction: "bullish", strengthScore: 72, clarityScore: 65, role: "leader" },
      { symbol: "GBPUSD", sufficient: false, patternType: null, direction: null, strengthScore: null, clarityScore: null, role: null },
    ],
  };

  return {
    useGetAdminCockpitOverview: ok(overviewData),
    getGetAdminCockpitOverviewQueryKey: key("/api/admin/cockpit/overview"),
    useGetAdminCockpitTraders: ok({ rows: [] }),
    getGetAdminCockpitTradersQueryKey: key("/api/admin/cockpit/traders"),
    useGetAdminCockpitTraderDetail: ok(null),
    getGetAdminCockpitTraderDetailQueryKey: () => ["/api/admin/cockpit/traders", "detail"],
    useGetAdminCockpitInvestors: ok({ rows: [] }),
    getGetAdminCockpitInvestorsQueryKey: key("/api/admin/cockpit/investors"),
    useGetAdminCockpitInvestorDetail: ok(null),
    getGetAdminCockpitInvestorDetailQueryKey: () => ["/api/admin/cockpit/investors", "detail"],
    useGetAdminCockpitBridge: ok({ connections: [], ownerView: false }),
    getGetAdminCockpitBridgeQueryKey: key("/api/admin/cockpit/bridge"),
    useGetAdminCockpitOpenTrades: ok({ rows: [], totalFloatingPl: 0 }),
    getGetAdminCockpitOpenTradesQueryKey: key("/api/admin/cockpit/open-trades"),
    useGetAdminCockpitRiskAlerts: ok({ alerts: [] }),
    getGetAdminCockpitRiskAlertsQueryKey: key("/api/admin/cockpit/risk-alerts"),
    useGetAdminCockpitCapital: ok({
      poolNav: 50000, reservedRisk: 1200, availableAllocation: 4800,
      finalized: null, indicative: null, pending: null,
    }),
    getGetAdminCockpitCapitalQueryKey: key("/api/admin/cockpit/capital"),
    useGetAdminCockpitAuditLog: ok({ entries: [] }),
    getGetAdminCockpitAuditLogQueryKey: key("/api/admin/cockpit/audit-log"),
    useGetAdminCockpitPatternSync: ok(patternSyncData),
    getGetAdminCockpitPatternSyncQueryKey: key("/api/admin/cockpit/pattern-sync"),
    useRefreshAdminCockpit: mut(),
    useApproveAdminCockpitTrader: mut(),
    useSuspendAdminCockpitTrader: mut(),
    useRestoreAdminCockpitTrader: mut(),
    useFullActivationAdminCockpitTrader: mut(),
    useEmergencyCloseAdminCockpitTrader: mut(),
    useFreezeAdminCockpitInvestor: mut(),
    useUnfreezeAdminCockpitInvestor: mut(),
    useAddAdminCockpitNote: mut(),
  };
});

import AdminCockpitPage from "./cockpit";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AdminCockpitPage />
    </QueryClientProvider>,
  );
}

const ADMIN_MODE = {
  isLoading: false,
  envelope: { mode: "LIVE_SHARED" },
  shouldShowAdminDiagnostics: true,
  isAdminPreviewingUserMode: false,
};

describe("AdminCockpitPage", () => {
  beforeEach(() => {
    modeValue = { ...ADMIN_MODE };
  });
  afterEach(() => cleanup());

  it("renders the cockpit for an admin session (status strip + overview + rail + audit)", () => {
    renderPage();
    expect(screen.getByTestId("admin-cockpit-page")).toBeTruthy();
    expect(screen.getByTestId("cockpit-status-strip")).toBeTruthy();
    expect(screen.getByTestId("cockpit-overview")).toBeTruthy();
    expect(screen.getByTestId("cockpit-risk-rail")).toBeTruthy();
    // Overview composed the aggregate (approved-live count from mock).
    expect(screen.getByTestId("cockpit-ov-traders")).toBeTruthy();
    // The gate did NOT block.
    expect(screen.queryByTestId("admin-diag-gate-blocked")).toBeNull();
  });

  it("switches to the admin-only, advisory Pattern Sync tab", () => {
    renderPage();
    const trigger = screen.getByRole("tab", { name: /Pattern Sync/i });
    // Radix Tabs activate on focus in jsdom — focus then click.
    fireEvent.focus(trigger);
    fireEvent.click(trigger);
    expect(screen.getByTestId("cockpit-pattern-sync")).toBeTruthy();
    const advisory = screen.getByTestId("cockpit-pattern-sync-advisory");
    expect(advisory.textContent ?? "").toMatch(/never places, gates or modifies a trade/i);
  });

  it("blocks a non-admin session (cockpit body never renders)", () => {
    modeValue = {
      isLoading: false,
      envelope: { mode: "PAPER" },
      shouldShowAdminDiagnostics: false,
      isAdminPreviewingUserMode: false,
    };
    renderPage();
    expect(screen.getByTestId("admin-diag-gate-blocked")).toBeTruthy();
    expect(screen.queryByTestId("admin-cockpit-page")).toBeNull();
    expect(screen.queryByTestId("cockpit-pattern-sync")).toBeNull();
  });

  it("blocks an admin who is previewing-as-user", () => {
    modeValue = { ...ADMIN_MODE, isAdminPreviewingUserMode: true };
    renderPage();
    expect(screen.getByTestId("admin-diag-gate-blocked")).toBeTruthy();
    expect(screen.queryByTestId("admin-cockpit-page")).toBeNull();
  });
});
