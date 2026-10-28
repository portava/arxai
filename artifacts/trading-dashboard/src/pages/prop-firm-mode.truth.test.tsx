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

describe("Prop Firm Mode — measured from the challenge start", () => {
  it("says which paper account, which equity mark and which start the figures come from, and shows the size note", async () => {
    const note = "The challenge size is $100000, but your paper account started the challenge with $10000 equity. Profit, target and drawdown are measured in dollars from $10000 and are not scaled.";
    stubStatus({
      config: CONFIG, measured: true, notMeasuredReason: null,
      profitUsd: 0, profitTargetProgress: 0, dailyDrawdownRemainingUsd: 5000, totalDrawdownRemainingUsd: 10000,
      passed: ["DAILY_DD", "TOTAL_DD"], failed: [], notChecked: [], status: "ACTIVE", equitySource: "paper_ledger",
      paperAccountId: 3, equityUsd: 10000, equityAsOf: "2026-10-28T11:59:00.000Z",
      challengeStartedAt: "2026-10-27T09:00:00.000Z", startEquityUsd: 10000, dailyDrawdownSince: "2026-10-28T00:00:00.000Z",
      notes: [note],
    });
    render(<PropFirmMode />);
    const from = await screen.findByTestId("prop-measured-from");
    expect(from.textContent).toMatch(/paper account #3/);
    expect(from.textContent).toMatch(/last stored mark/);
    expect(from.textContent).toMatch(/when the challenge started/);
    expect(screen.getByTestId("prop-note").textContent).toBe(note);
    expect(screen.queryByText("$-90000")).toBeNull();
  });
});
