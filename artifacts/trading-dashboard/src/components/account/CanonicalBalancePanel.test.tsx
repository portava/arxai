/**
 * CanonicalBalancePanel truth:
 *  - When the server withholds realized P/L for closed trades
 *    (realizedPnLPendingCount > 0), Realized P/L and Live equity are not final
 *    and must say so — a "Fresh" badge is not enough.
 *  - marginUsed is ARX reserved risk (investorLiveBalance.ts), not broker
 *    margin, so it must not be labelled "Margin used".
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

vi.mock("@/hooks/useLiveAccountSnapshotContext", () => ({
  useLiveAccountSnapshotCtx: () => ({ live: null }),
}));

import { CanonicalBalancePanel } from "./CanonicalBalancePanel";
import type { InvestorLiveBalance } from "@/hooks/useLiveAccountSnapshot";

afterEach(() => cleanup());

const base: InvestorLiveBalance = {
  source: "live_shared",
  allocatedBalance: 1000,
  realizedPnL: 25,
  floatingPnL: 5,
  liveEquity: 1030,
  marginUsed: 12,
  freeMargin: 1018,
  availableBalance: 988,
  openTradeCount: 1,
  freshness: { status: "fresh", lastUpdatedAt: new Date().toISOString(), ageMs: 1000 },
};

function tile(label: string): HTMLElement {
  return screen.getByText(label).parentElement as HTMLElement;
}

describe("CanonicalBalancePanel pending realized P/L", () => {
  it("discloses that Realized P/L and Live equity are incomplete when the server reports pending trades", () => {
    render(<CanonicalBalancePanel live={{ ...base, realizedPnLPendingCount: 2 }} />);
    expect(within(tile("Realized P/L")).getByText(/incomplete/i)).toBeTruthy();
    expect(within(tile("Live equity")).getByText(/incomplete/i)).toBeTruthy();
    const note = screen.getByTestId("canonical-balance-pnl-pending-note");
    expect(note.textContent).toMatch(/2 closed trades/);
  });

  it("shows no pending disclosure when nothing is pending", () => {
    render(<CanonicalBalancePanel live={{ ...base, realizedPnLPendingCount: 0 }} />);
    expect(screen.queryByTestId("canonical-balance-pnl-pending-note")).toBeNull();
    expect(screen.queryByText(/incomplete/i)).toBeNull();
  });
});

describe("CanonicalBalancePanel reserved risk label", () => {
  it("does not label reserved risk as broker margin", () => {
    render(<CanonicalBalancePanel live={base} />);
    expect(screen.queryByText("Margin used")).toBeNull();
    expect(screen.queryByText("Free margin")).toBeNull();
    expect(within(tile("Reserved risk")).getByText("$12.00")).toBeTruthy();
  });
});

// Round 3: composeInvestorBalance builds liveEquity as allocated + realized +
// (floatingPnL ?? 0), so an unavailable floating P/L is silently counted as 0.
// The figures built from it must say they leave it out.
describe("CanonicalBalancePanel unavailable floating P/L", () => {
  const floatingMissing: InvestorLiveBalance = {
    ...base,
    realizedPnL: 0,
    floatingPnL: null,
    liveEquity: 1000,
    marginUsed: 0,
    freeMargin: 1000,
    availableBalance: 1000,
    openTradeCount: 2,
    realizedPnLPendingCount: 0,
  };

  it("marks Live equity and Equity after reserve incomplete when floating P/L is unavailable", () => {
    render(<CanonicalBalancePanel live={floatingMissing} />);
    expect(within(tile("Floating P/L")).getByText(/unavailable/i)).toBeTruthy();
    expect(within(tile("Live equity")).getByText(/incomplete.*floating P\/L not included/i)).toBeTruthy();
    expect(within(tile("Equity after reserve")).getByText(/incomplete.*floating P\/L not included/i)).toBeTruthy();
    expect(within(tile("Available")).getByText(/open-trade losses not included/i)).toBeTruthy();
    const note = screen.getByTestId("canonical-balance-floating-missing-note");
    expect(note.textContent).toMatch(/2 open trades/);
    expect(note.textContent).toMatch(/not included/);
  });

  it("does not show 0 open trades when no balance was read", () => {
    render(<CanonicalBalancePanel live={null} />);
    expect(within(tile("Open trades")).queryByText("0")).toBeNull();
    expect(within(tile("Open trades")).getByText("—")).toBeTruthy();
  });

  it("does not show 0 open trades when the server had no live snapshot to count them from", () => {
    render(
      <CanonicalBalancePanel
        live={{ ...floatingMissing, source: "demo", openTradeCount: 0, freshness: { status: "unavailable", lastUpdatedAt: null, ageMs: null } }}
      />,
    );
    expect(within(tile("Open trades")).queryByText("0")).toBeNull();
    expect(within(tile("Open trades")).getByText(/not read/i)).toBeTruthy();
  });

  it("still shows a counted 0 when a live snapshot reports no open trades", () => {
    render(<CanonicalBalancePanel live={{ ...base, floatingPnL: 0, openTradeCount: 0 }} />);
    expect(within(tile("Open trades")).getByText("0")).toBeTruthy();
    expect(screen.queryByText(/not included/i)).toBeNull();
  });
});

describe("CanonicalBalancePanel source truth", () => {
  const demo: InvestorLiveBalance = {
    ...base, source: "demo", floatingPnL: null, openTradeCount: 0,
    freshness: { status: "unavailable", lastUpdatedAt: null, ageMs: null },
  };

  it("never calls demo or paper data live, even when the caller passes a 'Live balance' title", () => {
    render(<CanonicalBalancePanel live={demo} title="Live balance" />);
    expect(screen.queryByText("Live balance")).toBeNull();
    expect(screen.getByText("Demo balance")).toBeTruthy();
    expect(screen.queryByText("Live equity")).toBeNull();
    cleanup();
    render(<CanonicalBalancePanel live={{ ...demo, source: "paper" }} title="Live balance" />);
    expect(screen.getByText("Paper balance")).toBeTruthy();
  });

  it("does not show 'Open trades 0' when no live position snapshot was read", () => {
    render(<CanonicalBalancePanel live={demo} />);
    expect(within(tile("Open trades")).queryByText("0")).toBeNull();
    expect(within(tile("Open trades")).getByText("—")).toBeTruthy();
    cleanup();
    render(<CanonicalBalancePanel live={null} />);
    expect(within(tile("Open trades")).getByText("—")).toBeTruthy();
  });

  it("keeps the live labels and the measured count for Live Shared data", () => {
    render(<CanonicalBalancePanel live={base} title="Live balance" />);
    expect(screen.getByText("Live balance")).toBeTruthy();
    expect(within(tile("Live equity")).getByText("$1,030.00")).toBeTruthy();
    expect(within(tile("Open trades")).getByText("1")).toBeTruthy();
  });
});

// Round 3 review: openPL sums only the positions whose P/L is known, so with
// one known (+40) and one unknown open trade the server sends floatingPnL 40
// (not null). The panel showed "+$40.00" and an unmarked Live equity. The
// block now carries floatingPnLUnknownCount; any unknown trade marks the
// figures built from floating P/L incomplete, naming how many.
describe("CanonicalBalancePanel partly unknown floating P/L", () => {
  const partial: InvestorLiveBalance = {
    ...base,
    realizedPnL: 0,
    floatingPnL: 40,
    liveEquity: 1040,
    marginUsed: 0,
    freeMargin: 1040,
    availableBalance: 1000,
    openTradeCount: 2,
    realizedPnLPendingCount: 0,
    floatingPnLUnknownCount: 1,
  };

  it("marks Floating P/L, Live equity, Equity after reserve and Available incomplete for 1 of 2 trades", () => {
    render(<CanonicalBalancePanel live={partial} />);
    expect(within(tile("Floating P/L")).getByText("+$40.00")).toBeTruthy();
    expect(within(tile("Floating P/L")).getByText(/incomplete.*1 of 2 open trades/i)).toBeTruthy();
    expect(within(tile("Live equity")).getByText(/incomplete.*1 of 2 open trades.*not included/i)).toBeTruthy();
    expect(within(tile("Equity after reserve")).getByText(/incomplete.*1 of 2 open trades.*not included/i)).toBeTruthy();
    expect(within(tile("Available")).getByText(/losses of 1 open trade not included/i)).toBeTruthy();
    const note = screen.getByTestId("canonical-balance-floating-partial-note");
    expect(note.textContent).toMatch(/1 of 2 open trades/);
    expect(note.textContent).toMatch(/not included/);
    expect(screen.queryByTestId("canonical-balance-floating-missing-note")).toBeNull();
  });

  it("says nothing extra when every open trade's P/L is known", () => {
    render(<CanonicalBalancePanel live={{ ...partial, floatingPnLUnknownCount: 0 }} />);
    expect(screen.queryByText(/incomplete/i)).toBeNull();
    expect(screen.queryByText(/not included/i)).toBeNull();
    expect(screen.queryByTestId("canonical-balance-floating-partial-note")).toBeNull();
  });

  it("an unavailable Live Shared balance gives the live reason, not 'not available for this account mode'", () => {
    render(<CanonicalBalancePanel live={{ ...partial, freshness: { status: "unavailable", lastUpdatedAt: null, ageMs: null } }} />);
    const note = screen.getByTestId("canonical-balance-unavailable-note").textContent ?? "";
    expect(note).not.toMatch(/for this account mode/);
    expect(note).toMatch(/not confirmed current/i);
    cleanup();
    render(<CanonicalBalancePanel live={{ ...partial, source: "demo", floatingPnL: null, openTradeCount: 0, freshness: { status: "unavailable", lastUpdatedAt: null, ageMs: null } }} />);
    expect(screen.getByTestId("canonical-balance-unavailable-note").textContent).toMatch(/not available for this account mode/);
  });
});
