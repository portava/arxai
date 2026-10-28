import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// Prop Firm Mode used to show "Profit USD $0", "✓ DAILY_DD ✓ TOTAL_DD" and
// ACTIVE when the server had no paper equity to measure. The server now says
// so (measured:false, null money figures, notChecked); the page must show
// "not measured" and must not present any rule as passed.

const { default: PropFirmMode } = await import("./prop-firm-mode");

const CONFIG = {
  enabled: true, startingBalance: 100000, profitTarget: 8000, maxDailyDrawdownUsd: 5000, maxTotalDrawdownUsd: 10000,
  minTradingDays: 5, maxLotSize: 1, maxPositions: 3, newsTradingAllowed: false, weekendHoldingAllowed: false, consistencyRulePctOfTotal: 40,
};

function stubStatus(body: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Prop Firm Mode — unmeasured equity", () => {
  it("shows not measured, no passed rule, and lists the rules as not checked", async () => {
    const reason = "No active paper account, so paper equity could not be read.";
    stubStatus({
      config: CONFIG, measured: false, notMeasuredReason: reason,
      profitUsd: null, profitTargetProgress: null, dailyDrawdownRemainingUsd: null, totalDrawdownRemainingUsd: null,
      passed: [], failed: [], status: "NOT_MEASURED", equitySource: "paper_ledger",
      notChecked: ["PROFIT_TARGET", "DAILY_DD", "TOTAL_DD"].map((rule) => ({ rule, reason })),
    });
    render(<PropFirmMode />);
    const banner = await screen.findByTestId("prop-not-measured");
    expect(banner.textContent).toMatch(/No active paper account/);
    expect(screen.getByTestId("prop-status-badge").textContent).toBe("NOT MEASURED");
    expect(screen.queryByText(/ACTIVE/)).toBeNull();
    expect(screen.queryByText(/✓/)).toBeNull();
    expect(screen.queryByText("$0")).toBeNull();
    expect(screen.queryByText("$null")).toBeNull();
    expect(screen.getAllByText("not measured").length).toBeGreaterThanOrEqual(4);
    for (const rule of ["PROFIT_TARGET", "DAILY_DD", "TOTAL_DD"]) {
      expect(screen.getByTestId(`prop-rule-not-checked-${rule}`).textContent).toMatch(/not checked/);
    }
  });
});
