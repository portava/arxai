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
