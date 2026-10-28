// Risk Control Center truth. GET /risk/settings joins the saved risk-mode
// label (risk_settings) with the limits the Risk Governor reads
// (user_risk_settings). The two are written separately, so the label alone
// never proves which limits are in force, and nothing the page could not
// read may be shown as a value, an "Active" preset or a green status.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Q = { data: unknown; isLoading: boolean; isError: boolean };
const h = vi.hoisted(() => ({
  settings: { data: undefined, isLoading: false, isError: false } as { data: unknown; isLoading: boolean; isError: boolean },
  bot: { data: undefined, isLoading: false, isError: false } as { data: unknown; isLoading: boolean; isError: boolean },
  audit: { data: undefined, isLoading: false, isError: false } as { data: unknown; isLoading: boolean; isError: boolean },
  applyMutate: vi.fn(),
  stopMutate: vi.fn(),
  botMutate: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }) }));
vi.mock("@/hooks/useLiveAccountSnapshot", () => ({ useLiveAccountSnapshot: () => ({ live: null }) }));
vi.mock("@/components/account/CanonicalBalancePanel", () => ({ CanonicalBalancePanel: () => null }));
vi.mock("@/components/risk/RiskLimitLayersPanel", () => ({
  RiskLimitLayersPanel: () => <div data-testid="risk-limit-layers" />,
  RISK_LIMIT_LAYERS_QUERY_KEY: ["me", "risk-limits", "layers"],
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useGetRiskSettings: () => h.settings,
  useGetBotStatus: () => h.bot,
  useGetRiskAudit: () => ({ ...h.audit, refetch: vi.fn() }),
  useGetPositionSize: () => ({ data: undefined }),
  useUpdateRiskSettings: () => ({ mutate: vi.fn(), isPending: false }),
  useApplyRiskMode: () => ({ mutate: h.applyMutate, isPending: false }),
  useSetLiveLock: () => ({ mutate: vi.fn(), isPending: false }),
  useEmergencyStop: () => ({ mutate: h.stopMutate, isPending: false }),
  useUpdateBotStatus: () => ({ mutate: h.botMutate, isPending: false }),
}));

const { default: RiskSettings } = await import("./risk-settings");

// What a fresh trader's GET /risk/settings returns: the risk_settings label
// defaults to "Balanced" while user_risk_settings defaults to 1% / 3% / no
// weekly cap / 3 open trades / no own lot cap (platform ceiling 5).
const FRESH_USER = {
  id: 1, riskMode: "Balanced",
  riskPerTradePct: 1, maxDailyLossPct: 3, maxWeeklyLossPct: 0, maxOpenTrades: 3, maxTradesPerDay: 5,
  maxLotSize: 5, stopAfterLosingStreak: 3, cooldownAfterLossMinutes: 30, minConfidenceScore: 75,
  disableDuringAbnormalVolatility: true, liveLocked: false,
  vol75ExtraConfidence: true, vol75SmallLot: true, us30BlockNews: true, stocksBlockEarnings: true, forexBlockEvents: true,
};
// The same label after POST /risk/mode {mode:"Balanced"} wrote every preset limit.
const BALANCED_APPLIED = {
  ...FRESH_USER,
  riskPerTradePct: 0.5, maxDailyLossPct: 2, maxWeeklyLossPct: 5, maxOpenTrades: 2, maxTradesPerDay: 5,
  maxLotSize: 0.1, stopAfterLosingStreak: 3, cooldownAfterLossMinutes: 30, minConfidenceScore: 75,
};

function renderPage(
  opts: { tab?: string; settings?: Partial<Q>; bot?: Partial<Q>; audit?: Partial<Q> } = {},
) {
  h.settings = { data: undefined, isLoading: false, isError: false, ...opts.settings };
  h.bot = { data: undefined, isLoading: false, isError: false, ...opts.bot };
  h.audit = { data: undefined, isLoading: false, isError: false, ...opts.audit };
  window.history.replaceState({}, "", `/risk-settings?tab=${opts.tab ?? "mode"}`);
  const qc = new QueryClient();
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const utils = render(<QueryClientProvider client={qc}><RiskSettings /></QueryClientProvider>);
  return { ...utils, qc, invalidate };
}

function modeCard(mode: string): HTMLElement {
  return screen.getByTestId(`risk-mode-card-${mode}`);
}

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  h.applyMutate.mockReset();
  h.stopMutate.mockReset();
  h.botMutate.mockReset();
  h.toast.mockReset();
});

describe("mode cards: the saved label is not proof of the limits in force", () => {
  it("a fresh trader labelled Balanced is not shown the Balanced preset numbers as Active", () => {
    renderPage({ settings: { data: FRESH_USER } });
    const card = modeCard("Balanced");
    expect(within(card).queryByText("Active")).toBeNull();
    expect(within(card).queryByText("Currently Active")).toBeNull();
    expect(card.textContent).toMatch(/limits differ/i);
    // The header no longer claims "Balanced Mode".
    expect(screen.queryByText(/^Balanced Mode$/)).toBeNull();
    // The page names the stored values next to the preset's.
    const mismatch = screen.getByTestId("risk-mode-mismatch");
    expect(mismatch.textContent).toMatch(/Risk\/Trade: 1% stored, preset 0\.5%/);
    expect(mismatch.textContent).toMatch(/Daily Limit: 3% stored, preset 2%/);
    expect(mismatch.textContent).toMatch(/Weekly Limit: no weekly cap stored, preset 5%/);
    expect(mismatch.textContent).toMatch(/Max Open: 3 trades stored, preset 2 trades/);
  });

  it("the preset numbers on every card are labelled as what the preset sets", () => {
    renderPage({ settings: { data: FRESH_USER } });
    for (const mode of ["Conservative", "Balanced", "Aggressive"]) {
      expect(modeCard(mode).textContent).toMatch(/Applying this preset sets/);
    }
  });

  it("Re-apply stays available when the label matches but the limits do not", () => {
    renderPage({ settings: { data: FRESH_USER } });
    const button = within(modeCard("Balanced")).getByRole("button", { name: /Re-apply Balanced preset/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("System Status and the Limits tab do not call a mismatched label the active preset", () => {
    renderPage({ tab: "limits", settings: { data: FRESH_USER } });
    expect(screen.queryByText(/Preset Active/)).toBeNull();
    cleanup();
    renderPage({ tab: "emergency", settings: { data: FRESH_USER } });
    const row = screen.getByTestId("system-status-Risk Mode");
    expect(row.textContent).toMatch(/limits differ/i);
    expect(row.querySelector(".text-success")).toBeNull();
  });

  it("after the preset is applied in full, the card is Active", () => {
    renderPage({ settings: { data: BALANCED_APPLIED } });
    const card = modeCard("Balanced");
    expect(within(card).getByText("Active")).toBeTruthy();
    expect(within(card).getByText("Currently Active")).toBeTruthy();
    expect(screen.queryByTestId("risk-mode-mismatch")).toBeNull();
    expect(screen.getByText(/^Balanced Mode$/)).toBeTruthy();
  });
});
