// Truth regression: a trader with no weekly loss cap (user_risk_settings
// max_weekly_loss_percent NULL, sent as 0 = "off") must see "Off — no weekly
// cap", not "Max Weekly Loss 0%" (which reads as zero tolerance), and Save
// Custom Limits must not be silently rejected by the form's 0.1% minimum.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mutate = vi.fn();
let settings: Record<string, unknown> = {};

vi.mock("@workspace/api-client-react", () => {
  const idle = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useGetRiskSettings: () => ({ data: settings, isLoading: false }),
    useUpdateRiskSettings: () => ({ mutate, isPending: false }),
    useApplyRiskMode: idle,
    useSetLiveLock: idle,
    useEmergencyStop: idle,
    useUpdateBotStatus: idle,
    useGetBotStatus: () => ({ data: undefined }),
    useGetRiskAudit: () => ({ data: undefined, isLoading: false, refetch: vi.fn() }),
    useGetPositionSize: () => ({ data: undefined }),
    getGetRiskSettingsQueryKey: () => ["risk-settings"],
    getGetRiskAuditQueryKey: () => ["risk-audit"],
    getGetPositionSizeQueryKey: () => ["position-size"],
  };
});
vi.mock("@/hooks/useLiveAccountSnapshot", () => ({ useLiveAccountSnapshot: () => ({ live: null }) }));
vi.mock("@/components/account/CanonicalBalancePanel", () => ({ CanonicalBalancePanel: () => null }));
vi.mock("@/components/risk/RiskLimitLayersPanel", () => ({ RiskLimitLayersPanel: () => null, RISK_LIMIT_LAYERS_QUERY_KEY: ["layers"] }));
vi.mock("@/components/compliance/DisclaimerBanner", () => ({ DisclaimerBanner: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import RiskSettings from "./risk-settings";

function baseSettings(over: Record<string, unknown> = {}) {
  return {
    id: 1, riskMode: "Custom", riskPerTradePct: 0.5, maxDailyLossPct: 2, maxWeeklyLossPct: 0,
    maxOpenTrades: 2, maxTradesPerDay: 5, maxLotSize: 0.1, stopAfterLosingStreak: 3,
    cooldownAfterLossMinutes: 30, minConfidenceScore: 75, disableDuringAbnormalVolatility: true,
    liveLocked: false, vol75ExtraConfidence: false, vol75SmallLot: false, us30BlockNews: false,
    stocksBlockEarnings: false, forexBlockEvents: false, ...over,
  };
}

async function renderLimits() {
  const qc = new QueryClient();
  render(<QueryClientProvider client={qc}><RiskSettings /></QueryClientProvider>);
  await act(async () => { await Promise.resolve(); });
}
async function submit() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Save Custom Limits/ }));
  });
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

// Radix Slider measures itself; jsdom has no ResizeObserver.
class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  mutate.mockReset();
  window.history.replaceState({}, "", "/risk-settings?tab=limits");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Risk settings — no weekly loss cap", () => {
  it("labels a 0 (no cap) weekly limit as off, not 0%", async () => {
    settings = baseSettings({ maxWeeklyLossPct: 0 });
    await renderLimits();
    const label = screen.getByText(/Max Weekly Loss/);
    expect(label.textContent).not.toMatch(/0%/);
    expect(label.textContent).toMatch(/off/i);
    expect(screen.getByText(/No weekly cap is set/i)).toBeTruthy();
  });

  it("saves the other limits without first moving the weekly slider", async () => {
    settings = baseSettings({ maxWeeklyLossPct: 0 });
    await renderLimits();
    await submit();
    expect(mutate).toHaveBeenCalledTimes(1);
    const sent = (mutate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    // 0 is the store's "off" (the server writes it as NULL): the save keeps
    // the weekly cap off, it does not invent one.
    expect(sent.maxWeeklyLossPct).toBe(0);
    expect(sent.maxDailyLossPct).toBe(2);
  });

  it("an out-of-range limit shows a visible message instead of failing silently", async () => {
    settings = baseSettings({ maxWeeklyLossPct: 5, maxDailyLossPct: 0 });
    await renderLimits();
    await submit();
    expect(mutate).not.toHaveBeenCalled();
    const daily = screen.getByText(/Max Daily Loss/).closest("div")!.parentElement!;
    expect(within(daily).getByText(/0\.1/)).toBeTruthy();
  });

  it("a set weekly cap still shows its percent", async () => {
    settings = baseSettings({ maxWeeklyLossPct: 5 });
    await renderLimits();
    expect(screen.getByText(/Max Weekly Loss/).textContent).toMatch(/5%/);
  });
});
