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

describe("special rules say what reads them", () => {
  it("V75 reduced lot and spike protection are not listed as active green rules", () => {
    renderPage({ tab: "rules", settings: { data: BALANCED_APPLIED } });
    const summary = screen.getByTestId("rule-summary");
    expect(summary.textContent).not.toMatch(/capped at 50%/i);
    const saved = Array.from(summary.querySelectorAll("[data-rule-kind]"))
      .filter((el) => /reduced lot|spike protection/i.test(el.textContent ?? ""));
    expect(saved).toHaveLength(2);
    for (const el of saved) {
      expect(el.getAttribute("data-rule-kind")).toBe("saved");
      expect(el.textContent).toMatch(/not applied/i);
      expect(el.querySelector(".bg-success")).toBeNull();
    }
  });

  it("the news toggles are reminders, not blocks, and no copy promises an automatic halving", () => {
    renderPage({ tab: "rules", settings: { data: BALANCED_APPLIED } });
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Automatically halves/i);
    expect(text).not.toMatch(/Block During|Block Around|News proximity warnings active/);
    for (const el of screen.getByTestId("rule-summary").querySelectorAll("[data-rule-kind='reminder']")) {
      expect(el.textContent).toMatch(/does not block/i);
      expect(el.querySelector(".bg-success")).toBeNull();
    }
  });

  it("Spike Protection does not promise to pause", () => {
    renderPage({ tab: "limits", settings: { data: BALANCED_APPLIED } });
    const desc = screen.getByTestId("spike-protection-desc").textContent ?? "";
    expect(desc).not.toMatch(/^Pause during/);
    expect(desc).toMatch(/nothing pauses/i);
  });
});

describe("Lot Size Reference table matches the position sizer", () => {
  // Same inputs the row labels name, $1,000 account, sized by the api-server's sizer.
  const ROWS: Record<string, { symbol: string; entry: number; stopLoss: number }> = {
    "V75 Index (30pt SL)": { symbol: "Volatility 75 Index", entry: 100, stopLoss: 70 },
    "V75 1s (50pt SL)": { symbol: "Volatility 75 (1s) Index", entry: 100, stopLoss: 50 },
    "V25 Index (20pt SL)": { symbol: "Volatility 25 Index", entry: 100, stopLoss: 80 },
    "EURUSD (30pip SL)": { symbol: "EURUSD", entry: 1.1, stopLoss: 1.097 },
    "US30 (50pt SL)": { symbol: "US30", entry: 40000, stopLoss: 39950 },
  };

  it("every row equals calculatePositionSize's finalLot at 0.25%, 0.5% and 1%", async () => {
    const { calculatePositionSize } = await import("../../../api-server/src/lib/riskGovernor/positionSizer");
    renderPage({ tab: "calculator", settings: { data: BALANCED_APPLIED } });
    for (const [label, input] of Object.entries(ROWS)) {
      const cells = Array.from(screen.getByTestId(`lot-ref-row-${label}`).querySelectorAll("td")).slice(1);
      const shown = cells.map((c) => c.textContent);
      const expected = [0.25, 0.5, 1].map((riskPercent) =>
        calculatePositionSize({ ...input, accountBalance: 1000, riskPercent }).finalLot.toFixed(2));
      expect({ label, shown }).toEqual({ label, shown: expected });
    }
  });
});

describe("a failed GET /risk/settings is not shown as Balanced defaults", () => {
  const FAILED = { data: undefined, isLoading: false, isError: true };

  it("no mode badge, no Active card, and the failure is stated", () => {
    renderPage({ settings: FAILED });
    expect(screen.queryByText(/Balanced Mode/)).toBeNull();
    expect(screen.getByTestId("risk-mode-badge").textContent).toMatch(/could not be loaded/i);
    expect(screen.getByTestId("risk-settings-load-error").textContent).toMatch(/could not be loaded/i);
    for (const mode of ["Conservative", "Balanced", "Aggressive", "Custom"]) {
      expect(within(modeCard(mode)).queryByText("Active")).toBeNull();
      expect(within(modeCard(mode)).queryByText("Currently Active")).toBeNull();
    }
  });

  it("the limit editor does not show placeholder limits that a Save would write", () => {
    renderPage({ tab: "limits", settings: FAILED });
    expect(screen.queryByText("Save Custom Limits")).toBeNull();
    expect(screen.getByTestId("risk-limits-load-error").textContent).toMatch(/could not be loaded/i);
  });

  it("special-rule switches are not rendered as switched on", () => {
    renderPage({ tab: "rules", settings: FAILED });
    const switches = screen.getAllByRole("switch");
    expect(switches.length).toBeGreaterThan(0);
    for (const sw of switches) {
      expect(sw.getAttribute("aria-checked")).toBe("false");
      expect((sw as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.getByTestId("rule-summary").textContent).toMatch(/could not be loaded/i);
  });

  it("System Status says the lock and mode could not be loaded, not OPEN / Balanced", () => {
    renderPage({ tab: "emergency", settings: FAILED });
    for (const label of ["Live Locked", "Risk Mode"]) {
      const row = screen.getByTestId(`system-status-${label}`);
      expect(row.textContent).toMatch(/could not be loaded/i);
      expect(row.textContent).not.toMatch(/OPEN|Balanced/);
      expect(row.querySelector(".text-success")).toBeNull();
    }
  });
});

describe("System Status never colours an unread bot status green", () => {
  it("with no bot status read, the bot rows say so in grey instead of a green '—' / 'NO'", () => {
    renderPage({ tab: "emergency", settings: { data: BALANCED_APPLIED }, bot: { data: undefined, isError: true } });
    for (const label of ["Bot Mode", "Is Running", "Is Paused"]) {
      const row = screen.getByTestId(`system-status-${label}`);
      expect(row.textContent).toMatch(/could not be loaded/i);
      expect(row.textContent).not.toMatch(/\bNO\b|—/);
      expect(row.querySelector(".text-success")).toBeNull();
    }
  });

  it("'Is Paused' is not hard-coded green", () => {
    renderPage({
      tab: "emergency", settings: { data: BALANCED_APPLIED },
      bot: { data: { mode: "AUTO", symbol: "EURUSD", strategy: "x", riskMode: "Balanced", isRunning: true, isPaused: false, lastScanAt: null } },
    });
    const paused = screen.getByTestId("system-status-Is Paused");
    expect(paused.textContent).toMatch(/NO/);
    expect(paused.querySelector(".text-success")).toBeNull();
    const running = screen.getByTestId("system-status-Is Running");
    expect(running.querySelector(".text-success")).toBeNull();
    expect(screen.getByTestId("system-status-bot-scope").textContent).toMatch(/saved Bot Control settings/);
  });
});
