// Truth regression: what the Risk Settings stop controls say they do.
//
// Before: after EMERGENCY STOP engaged the trader's (or, for an operator, the
// platform) kill switch, nothing on this page said new trades were halted or
// where to release the switch; System Status showed Bot Mode OFF / Is
// Running NO / Is Paused NO in green and the audit banner read a pass.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

type MutateOpts = { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void };
const h = vi.hoisted(() => ({
  audit: undefined as unknown,
  auditError: false,
  bot: undefined as unknown,
  toasts: [] as Array<{ title?: string; description?: string }>,
  stopResponse: { success: true, message: "", closedTrades: 0 } as unknown,
  botPatch: null as unknown,
}));

const idle = { isPending: false, mutate: () => undefined };
// One stable object: the page resets its limits form whenever settings changes identity.
const SETTINGS = { data: { riskMode: "Balanced", liveLocked: false }, isLoading: false };

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useGetRiskSettings: () => SETTINGS,
  useGetBotStatus: () => ({ data: h.bot }),
  useGetRiskAudit: () => ({ data: h.audit, isLoading: false, isError: h.auditError, refetch: () => undefined }),
  useGetPositionSize: () => ({ data: undefined }),
  useUpdateRiskSettings: () => idle,
  useApplyRiskMode: () => idle,
  useSetLiveLock: () => idle,
  useEmergencyStop: () => ({ isPending: false, mutate: (_v: unknown, o: MutateOpts) => o.onSuccess?.(h.stopResponse) }),
  useUpdateBotStatus: () => ({
    isPending: false,
    mutate: (v: { data: unknown }, o: MutateOpts) => { h.botPatch = v.data; o.onSuccess?.(v.data); },
  }),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useQueryClient: () => ({ invalidateQueries: () => Promise.resolve(), setQueryData: () => undefined }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: (t: { title?: string; description?: string }) => { h.toasts.push(t); } }),
}));
vi.mock("@/hooks/useLiveAccountSnapshot", () => ({ useLiveAccountSnapshot: () => ({ live: null }) }));
vi.mock("@/components/account/CanonicalBalancePanel", () => ({ CanonicalBalancePanel: () => null }));
vi.mock("@/components/risk/RiskLimitLayersPanel", () => ({ RiskLimitLayersPanel: () => null, RISK_LIMIT_LAYERS_QUERY_KEY: ["risk-limit-layers"] }));
vi.mock("@/components/compliance/DisclaimerBanner", () => ({ DisclaimerBanner: () => null }));

const { default: RiskSettings } = await import("./risk-settings");

const AUDIT = {
  passed: true, reasonsBlocked: [], warnings: [], riskPercent: 0.5, projectedLoss: 5, riskReward: 2,
  dailyLossUsed: 0, weeklyLossUsed: 0, tradesRemaining: 5, openTradesCount: 0, losingStreak: 0, cooldownActive: false,
  closedTradesMeasured: true, measuredFrom: "LEGACY_TRADES_TABLE", balanceSource: "PLACEHOLDER_1000", scope: "USER",
};
const TRADER_KS = {
  engaged: true, sources: ["trader_kill_switch"], venues: ["PAPER", "DEMO", "LIVE"],
  reason: "Your kill switch is engaged. Release it to trade again. (Emergency stop from the bot panel)",
};

beforeEach(() => {
  window.history.replaceState({}, "", "/risk-settings?tab=emergency");
  h.bot = { mode: "OFF", symbol: "EURUSD", strategy: "x", riskMode: "Balanced", isRunning: false, isPaused: false, lastScanAt: null };
  h.audit = { ...AUDIT, tradingHalt: { engaged: false, sources: [], reason: null, venues: [] } };
  h.auditError = false;
  h.toasts = [];
  h.botPatch = null;
});
afterEach(cleanup);

function statusRow(label: string): string {
  return screen.getByTestId(`risk-status-row-${label}`).textContent ?? "";
}

describe("Risk Settings: an engaged kill switch is visible", () => {
  it("after an emergency stop the page says new trades are halted and where to release the switch", () => {
    h.audit = {
      ...AUDIT, passed: false,
      reasonsBlocked: [`New trades are halted on PAPER, DEMO, LIVE: ${TRADER_KS.reason}`],
      tradingHalt: TRADER_KS,
    };
    render(<RiskSettings />);
    const banner = screen.getByTestId("risk-audit-banner").textContent ?? "";
    expect(banner).toMatch(/New trades are halted: a stop switch is engaged/);
    expect(banner).not.toMatch(/no rule tripped|GREEN|all risk checks passed/i);
    expect(screen.getByTestId("risk-halt-release").textContent).toMatch(/Resume on Risk Command Center/);
    expect(screen.getByTestId("risk-halt-badge").textContent).toMatch(/New trades halted/);
    expect(statusRow("Stop switch")).toMatch(/ENGAGED \(PAPER, DEMO, LIVE\)/);
  });

  it("a platform-wide stop says it halts every trader and that an operator releases it", () => {
    h.audit = {
      ...AUDIT, passed: false, reasonsBlocked: ["New trades are halted on PAPER, DEMO, LIVE: The safety-core kill switch is engaged."],
      tradingHalt: { engaged: true, sources: ["safety_core_kill_switch"], venues: ["PAPER", "DEMO", "LIVE"], reason: "The safety-core kill switch is engaged." },
    };
    render(<RiskSettings />);
    expect(screen.getByTestId("risk-halt-release").textContent).toMatch(/halts every trader.*operator/);
  });

  it("released switches read 'none engaged'; an audit that could not be loaded never reads released", () => {
    render(<RiskSettings />);
    expect(statusRow("Stop switch")).toMatch(/none engaged/);
    cleanup();
    h.audit = undefined;
    h.auditError = true;
    render(<RiskSettings />);
    expect(statusRow("Stop switch")).toMatch(/could not be loaded/);
    expect(screen.queryByTestId("risk-halt-badge")).toBeNull();
  });

  it("a server that did not read the switches is not shown as released", () => {
    h.audit = { ...AUDIT };
    render(<RiskSettings />);
    expect(statusRow("Stop switch")).toMatch(/not read/);
    expect(statusRow("Stop switch")).not.toMatch(/none engaged/);
  });
});

// Before: "Pause All Trading" PATCHed bot_settings.isPaused, which no order
// path reads, yet the toast said "Bot will not open new positions", the header
// showed "Paused" and the card said "Bot is currently paused".
describe("Risk Settings: the bot paused flag says what it does", () => {
  it("setting the flag never claims new positions are stopped, and names the real pause", () => {
    render(<RiskSettings />);
    fireEvent.click(screen.getByRole("button", { name: /Set Paused Flag/ }));
    expect(h.botPatch).toEqual({ isPaused: true });
    const t = h.toasts.at(-1)!;
    expect(`${t.title} ${t.description}`).not.toMatch(/will not open new positions|Trading paused/i);
    expect(t.description).toMatch(/does not stop new trades/);
    expect(t.description).toMatch(/Pause my trading.*Risk Command Center/);
    expect(screen.getByTestId("bot-paused-flag-note").textContent).toMatch(/No order path reads this flag/);
    expect(screen.queryByText(/Suspends new trade entries/)).toBeNull();
  });

  it("a set flag is labelled as a flag, not as paused trading", () => {
    h.bot = { ...(h.bot as object), isPaused: true };
    render(<RiskSettings />);
    expect(screen.getByTestId("bot-paused-flag-badge").textContent).toMatch(/Bot paused flag set/);
    expect(screen.queryByText("Bot is currently paused")).toBeNull();
    expect(screen.getByText(/New trades are not stopped by it/)).toBeTruthy();
    expect(statusRow("Paused flag")).toMatch(/SET/);
    expect(screen.getByTestId("bot-flags-note").textContent).toMatch(/no order path reads them/);
  });
});
