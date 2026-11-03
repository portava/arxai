import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The Risk Control Center showed "Trading conditions GREEN — all risk checks
// passed" and a "Live Risk Audit — Real-time evaluation of all risk rules"
// right under the Live balance panel. The audit measures loss % against a
// $1,000 placeholder and counts trades in the retired legacy trades log
// (every account's rows; its closes are never counted), so none of it is the
// trader's live account. The page now says what the audit read, shows the
// unmeasured figures as "Not measured", never shows that pass green, and a
// failed request reads "could not be loaded" instead of vanishing.

const { default: RiskSettings } = await import("./risk-settings");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

class NoEventSource { onmessage = null; onerror = null; addEventListener() {} removeEventListener() {} close() {} }

const SETTINGS = { riskPerTradePct: 0.5, maxDailyLossPct: 2, maxWeeklyLossPct: 5, maxTradesPerDay: 5, maxOpenTrades: 2, maxLotSize: 0.1, stopAfterLosingStreak: 3, cooldownAfterLossMinutes: 30, minConfidenceScore: 75, disableDuringAbnormalVolatility: true, riskMode: "Balanced", liveLocked: false };
const AUDIT = {
  passed: true, reasonsBlocked: [], warnings: [], riskPercent: 0.5, projectedLoss: 5, riskReward: 2,
  dailyLossUsed: 0, weeklyLossUsed: 0, tradesRemaining: 5, openTradesCount: 0, losingStreak: 0, cooldownActive: false,
};
const BASIS = {
  balanceSource: "PLACEHOLDER_1000", accountBalanceUsed: 1000, tradeSource: "LEGACY_TRADES_TABLE", tradeScope: "ALL_ACCOUNTS",
  notMeasured: ["dailyLossUsed", "weeklyLossUsed", "losingStreak", "cooldownActive"], evaluatedAt: "2026-11-03T10:00:00.000Z",
};

function stub(audit: Record<string, unknown> | null) {
  vi.stubGlobal("EventSource", NoEventSource);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/risk/audit")) return audit ? json(audit) : json({ error: "Failed to compute risk audit" }, 500);
    if (url.includes("/risk/settings")) return json(SETTINGS);
    return json({}, 404);
  }));
}

function renderAt(tab: string) {
  window.history.replaceState({}, "", `/risk-settings?tab=${tab}`);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><RiskSettings /></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Risk Control Center — risk audit basis", () => {
  it("discloses the $1,000 placeholder and the legacy log; never a green 'all risk checks passed'", async () => {
    stub({ ...AUDIT, ...BASIS });
    renderAt("emergency");
    const headline = await screen.findByTestId("risk-audit-headline");
    expect(headline.textContent).toBe("Legacy risk audit: no rule tripped — not a check of your live account");
    expect(screen.queryByText(/all risk checks passed/i)).toBeNull();
    expect(screen.getByTestId("risk-audit-banner").className).not.toMatch(/success/);
    const note = screen.getByTestId("risk-audit-basis").textContent ?? "";
    expect(note).toMatch(/\$1,000 placeholder balance, not your live balance/);
    expect(note).toMatch(/legacy trades log \(every account's rows, not only yours\), which takes no new trades/);
    expect(screen.getByTestId("risk-audit-banner-daily-loss").textContent).toBe("Not measured");
    expect(screen.getByText("Trades left (legacy log)")).toBeTruthy();

    // The detail card on the Emergency tab.
    expect((await screen.findByTestId("risk-audit-detail-title")).textContent).toMatch(/^\s*Legacy Risk Audit$/);
    expect(screen.queryByText(/Real-time evaluation/)).toBeNull();
    expect(screen.queryByText("Live Risk Audit")).toBeNull();
    expect(screen.getByTestId("risk-audit-detail-asof").textContent).toMatch(/last run /);
    expect(screen.getByTestId("risk-audit-detail-basis").textContent).toMatch(/placeholder balance/);
    expect(screen.getByText("Daily Loss Used (vs $1,000)")).toBeTruthy();
    expect(screen.getByText("Open Trades (legacy log, all accounts)")).toBeTruthy();
    expect(screen.getAllByText("Not measured").length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText("Clear")).toBeNull();
    expect(screen.queryByText("All clear")).toBeNull();
    expect(screen.getByTestId("risk-audit-detail-clear").textContent).toMatch(/does not check your live account/);
  });

  it("an older server that does not say what it read gets the same disclosure", async () => {
    stub({ ...AUDIT });
    renderAt("emergency");
    expect((await screen.findByTestId("risk-audit-headline")).textContent).toMatch(/^Legacy risk audit/);
    expect(screen.getByTestId("risk-audit-basis").textContent).toMatch(/placeholder balance/);
    expect(screen.getByTestId("risk-audit-banner-daily-loss").textContent).toBe("Not measured");
  });

  it("a failed audit request reads 'could not be loaded', not an empty space", async () => {
    stub(null);
    renderAt("emergency");
    expect((await screen.findByTestId("risk-audit-banner-error")).textContent).toMatch(/could not be loaded/);
    expect((await screen.findByTestId("risk-audit-detail-error")).textContent).toMatch(/could not be loaded/);
  });
});
