// Truth regression: the Live Risk Audit banner and detail on Risk Settings.
//
// Before: the server's closed-trade filter matched no row, so daily / weekly
// loss, losing streak and cooldown were never measured; the page showed
// 0.0% / 0 / green "Clear" and "Trading conditions GREEN — all risk checks
// passed". A failed request rendered nothing at all.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

type Q = { data: unknown; isLoading: boolean; isError: boolean; refetch: () => void };
const h = vi.hoisted(() => ({
  audit: { data: undefined as unknown, isLoading: false, isError: false, refetch: () => undefined } as Q,
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useGetRiskAudit: () => h.audit,
}));

const { AuditBanner, RiskAuditDetail } = await import("./risk-settings");

const BASE = {
  passed: true, reasonsBlocked: [], warnings: [], riskPercent: 0.5, projectedLoss: 5, riskReward: 2,
  dailyLossUsed: 0, weeklyLossUsed: 0, tradesRemaining: 5, openTradesCount: 0, losingStreak: 0, cooldownActive: false,
};

function set(data: unknown, over: Partial<Q> = {}) {
  h.audit = { data, isLoading: false, isError: false, refetch: () => undefined, ...over };
}

afterEach(cleanup);

describe("risk audit banner", () => {
  it("a server that did not measure closed trades cannot read GREEN / all checks passed", () => {
    set({ ...BASE });
    render(<AuditBanner />);
    const t = screen.getByTestId("risk-audit-banner").textContent ?? "";
    expect(t).not.toMatch(/GREEN|all risk checks passed|no rule tripped/i);
    expect(t).toMatch(/not measured/);
  });

  it("a measured pass says no rule tripped and names what it measured against", () => {
    set({ ...BASE, closedTradesMeasured: true, measuredFrom: "LEGACY_TRADES_TABLE", balanceSource: "PLACEHOLDER_1000" });
    render(<AuditBanner />);
    const t = screen.getByTestId("risk-audit-banner").textContent ?? "";
    expect(t).toMatch(/no rule tripped/);
    expect(t).toMatch(/legacy simulated trades table/);
    expect(t).toMatch(/placeholder \$1,000 balance/);
  });

  it("a measured breach names the rule", () => {
    set({ ...BASE, passed: false, closedTradesMeasured: true, dailyLossUsed: 15, losingStreak: 3, cooldownActive: true,
      reasonsBlocked: ["Daily loss limit reached: 15.00% used of 2% allowed"] });
    render(<AuditBanner />);
    const t = screen.getByTestId("risk-audit-banner").textContent ?? "";
    expect(t).toMatch(/a rule is tripped/);
    expect(t).toMatch(/Daily loss limit reached/);
  });

  it("a failed request says it could not be loaded", () => {
    set(undefined, { isError: true });
    render(<AuditBanner />);
    expect(screen.getByTestId("risk-audit-banner").textContent).toMatch(/could not be loaded/);
  });
});

describe("risk audit detail", () => {
  it("unmeasured loss, streak and cooldown read 'not measured', never 0.00% / green Clear / All clear", () => {
    set({ ...BASE });
    render(<RiskAuditDetail />);
    expect(screen.getAllByText("not measured").length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText("Clear")).toBeNull();
    expect(screen.queryByText("All clear")).toBeNull();
    expect(screen.queryByText("0.00%")).toBeNull();
    expect(screen.getByTestId("risk-audit-unmeasured")).toBeTruthy();
  });

  it("measured values are shown as numbers", () => {
    set({ ...BASE, passed: false, closedTradesMeasured: true, dailyLossUsed: 15, weeklyLossUsed: 15, losingStreak: 3, cooldownActive: true,
      reasonsBlocked: ["Losing streak cooldown active"] });
    render(<RiskAuditDetail />);
    expect(screen.getAllByText("15.00%").length).toBe(2);
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("ACTIVE")).toBeTruthy();
  });

  it("a failed request says it could not be loaded", () => {
    set(undefined, { isError: true });
    render(<RiskAuditDetail />);
    expect(screen.getByTestId("risk-audit-detail").textContent).toMatch(/could not be loaded/);
  });
});

describe("risk audit scope", () => {
  it("a user-scoped audit says it counted your rows, and the open-trade count is yours", () => {
    set({ ...BASE, closedTradesMeasured: true, scope: "USER", openTradesCount: 0 });
    render(<><AuditBanner /><RiskAuditDetail /></>);
    expect(screen.getByTestId("risk-audit-banner").textContent).toMatch(/your rows in the legacy simulated trades table/);
    expect(screen.getByText("yours")).toBeTruthy();
  });

  it("an audit over every user's rows says so instead of passing it off as yours", () => {
    set({ ...BASE, passed: false, closedTradesMeasured: true, scope: "ALL_USERS", openTradesCount: 3,
      reasonsBlocked: ["Max open trades reached (3/2)"] });
    render(<><AuditBanner /><RiskAuditDetail /></>);
    expect(screen.getByTestId("risk-audit-banner").textContent).toMatch(/every user's rows/);
    expect(screen.getByText("all users")).toBeTruthy();
  });
});
