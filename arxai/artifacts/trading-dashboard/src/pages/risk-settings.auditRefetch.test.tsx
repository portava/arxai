// Risk Control Center: a failed refetch is not a current verdict. React Query
// keeps the previous `data` when a later read fails (status "error"), so the
// audit banner kept "Trading conditions GREEN — all risk checks passed", the
// audit card kept "All clear", and System Status kept the old Bot Mode /
// start / pause rows, all with no sign that the latest read had failed.
// (After the merge with the legacy-audit wording, a passed read says "no rule
// tripped"; the tests wait for that verdict instead of the old GREEN copy.)
// These tests run the real generated hooks against a stubbed fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/useLiveAccountSnapshot", () => ({ useLiveAccountSnapshot: () => ({ live: null }) }));
vi.mock("@/components/account/CanonicalBalancePanel", () => ({ CanonicalBalancePanel: () => null }));
vi.mock("@/components/risk/RiskLimitLayersPanel", () => ({
  RiskLimitLayersPanel: () => <div data-testid="risk-limit-layers" />,
  RISK_LIMIT_LAYERS_QUERY_KEY: ["me", "risk-limits", "layers"],
}));

const SETTINGS = {
  id: 1, riskMode: "Balanced",
  riskPerTradePct: 0.5, maxDailyLossPct: 2, maxWeeklyLossPct: 5, maxOpenTrades: 2, maxTradesPerDay: 5,
  maxLotSize: 0.1, stopAfterLosingStreak: 3, cooldownAfterLossMinutes: 30, minConfidenceScore: 75,
  disableDuringAbnormalVolatility: true, liveLocked: false,
  vol75ExtraConfidence: true, vol75SmallLot: true, us30BlockNews: true, stocksBlockEarnings: true, forexBlockEvents: true,
};

// Only the audit and bot status run through the real hooks.
vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useGetRiskSettings: () => ({ data: SETTINGS, isLoading: false, isError: false }),
  useGetPositionSize: () => ({ data: undefined }),
  useUpdateRiskSettings: () => ({ mutate: vi.fn(), isPending: false }),
  useApplyRiskMode: () => ({ mutate: vi.fn(), isPending: false }),
  useSetLiveLock: () => ({ mutate: vi.fn(), isPending: false }),
  useEmergencyStop: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateBotStatus: () => ({ mutate: vi.fn(), isPending: false }),
}));

const { default: RiskSettings } = await import("./risk-settings");

// What the server sends for a passed audit: this trader's rows, closed rows
// counted, on the legacy basis it names.
const PASSED_AUDIT = {
  passed: true, reasonsBlocked: [], warnings: [], riskPercent: 0.5, dailyLossUsed: 0, weeklyLossUsed: 0,
  tradesRemaining: 5, openTradesCount: 0, losingStreak: 0, cooldownActive: false,
  closedTradesMeasured: true, measuredFrom: "LEGACY_TRADES_TABLE", balanceSource: "PLACEHOLDER_1000",
  accountBalanceUsed: 1000, tradeSource: "LEGACY_TRADES_TABLE", scope: "USER", tradeScope: "USER", notMeasured: [],
};
const passedVerdict = async () =>
  expect((await screen.findByTestId("risk-audit-headline")).textContent).toMatch(/no rule tripped/i);
const BOT = { mode: "AUTO", symbol: "EURUSD", strategy: "x", riskMode: "Balanced", isRunning: true, isPaused: false, lastScanAt: null };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let failing = false;

function renderPage() {
  window.history.replaceState({}, "", "/risk-settings?tab=emergency");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><RiskSettings /></QueryClientProvider>);
  return qc;
}

beforeEach(() => {
  failing = false;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (failing) return json({ error: "database unreadable" }, 500);
    if (u.includes("/api/risk/audit")) return json(PASSED_AUDIT);
    if (u.includes("/api/bot/status")) return json(BOT);
    return json({});
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("a risk audit refetch that fails after a passed read", () => {
  it("no longer shows the passed verdict / clear card, and says the audit could not be loaded with the last read time", async () => {
    const qc = renderPage();
    await passedVerdict();
    expect(screen.getByTestId("risk-audit-detail-clear")).toBeTruthy();

    failing = true;
    await act(async () => { await qc.refetchQueries(); });

    await waitFor(() => expect(screen.queryByTestId("risk-audit-headline")).toBeNull());
    expect(screen.queryAllByText(/no rule tripped/i)).toHaveLength(0);
    expect(screen.queryByTestId("risk-audit-detail-clear")).toBeNull();
    expect(screen.queryByText(/Real-time evaluation of all risk rules/)).toBeNull();
    const banner = screen.getByTestId("risk-audit-banner-unavailable");
    expect(banner.textContent).toMatch(/could not be loaded/i);
    expect(banner.textContent).toMatch(/last successful read/i);
    const detail = screen.getByTestId("risk-audit-detail-unavailable");
    expect(detail.textContent).toMatch(/could not be loaded/i);
    expect(detail.textContent).toMatch(/last successful read/i);
  });

  it("shows the verdict again once a later read succeeds", async () => {
    const qc = renderPage();
    await passedVerdict();
    failing = true;
    await act(async () => { await qc.refetchQueries(); });
    await screen.findByTestId("risk-audit-banner-unavailable");
    failing = false;
    await act(async () => { await qc.refetchQueries(); });
    await passedVerdict();
    expect(screen.queryByTestId("risk-audit-banner-unavailable")).toBeNull();
  });
});

describe("a bot status poll that fails after a good read", () => {
  it("System Status says the bot rows could not be loaded instead of the old AUTO / YES / NO", async () => {
    const qc = renderPage();
    await waitFor(() => expect(screen.getByTestId("system-status-Bot Mode").textContent).toMatch(/AUTO/));

    failing = true;
    await act(async () => { await qc.refetchQueries(); });

    await waitFor(() => expect(screen.getByTestId("system-status-Bot Mode").textContent).toMatch(/could not be loaded/i));
    for (const label of ["Bot Mode", "Is Running", "Is Paused"]) {
      const row = screen.getByTestId(`system-status-${label}`);
      expect(row.textContent).toMatch(/could not be loaded/i);
      expect(row.textContent).not.toMatch(/AUTO|\bYES\b|\bNO\b/);
    }
  });
});
