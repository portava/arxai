import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

/**
 * Feature Truth Audit — LiveTradeCard badge honesty.
 *
 * "Live Trading Blocked" and "Bridge Offline" used to be pushed
 * UNCONDITIONALLY — the card asserted a blocked/offline state even when the
 * MT5 bridge was online and live execution enabled. They now derive from the
 * real backend MT5 state (same source as the Live Trades page header):
 *   - connected:true  + liveAllowed:true  → NEITHER badge renders
 *   - connected:false + liveAllowed:false → BOTH badges render
 *   - status not yet loaded               → NEITHER renders (assert nothing
 *     without evidence)
 */

const h = vi.hoisted(() => ({
  mt5State: undefined as undefined | { connected?: boolean; liveAllowed?: boolean },
  snap: undefined as unknown,
  queries: {} as Record<string, unknown>,
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetTradeSnapshot: () => ({ data: h.snap }),
  useGetCoachExplanation: () => ({ data: undefined, isLoading: false }),
  useMoveTradeToBreakeven: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTrailTradeStop: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePartialCloseTrade: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCloseTradeManually: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useGetMt5State: () => ({ data: h.mt5State }),
  useGetAaciDecision: () => ({ data: undefined }),
  getGetTradeSnapshotQueryKey: (id: number) => ["snap", id],
  getGetOpenTradesQueryKey: () => ["open-trades"],
  getGetCoachExplanationQueryKey: (id: number) => ["coach", id],
  getGetMt5StateQueryKey: () => ["mt5-state"],
  getGetAaciDecisionQueryKey: (s: string) => ["aaci", s],
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { queryKey: unknown[] }) => ({ data: h.queries[String(opts.queryKey[0])] ?? {} }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { LiveTradeCard } from "./LiveTradeCard";

const trade = {
  id: 1,
  symbol: "EURUSD",
  direction: "BUY",
  lot: 0.01,
  mode: "LIVE",
  entryPrice: 1.1,
  stopLoss: 1.09,
  takeProfit: 1.12,
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.mt5State = undefined;
  h.snap = undefined;
  h.queries = {};
});
afterEach(() => cleanup());

describe("LiveTradeCard blocked/offline badge honesty", () => {
  it("shows NEITHER badge when bridge is connected and live is allowed", () => {
    h.mt5State = { connected: true, liveAllowed: true };
    render(<LiveTradeCard trade={trade} />);
    expect(screen.queryByTestId("badge-live-blocked")).toBeNull();
    expect(screen.queryByTestId("badge-bridge-offline")).toBeNull();
  });

  it("shows BOTH badges when bridge is offline and live is not allowed", () => {
    h.mt5State = { connected: false, liveAllowed: false };
    render(<LiveTradeCard trade={trade} />);
    expect(screen.getByTestId("badge-live-blocked")).toBeTruthy();
    expect(screen.getByTestId("badge-bridge-offline")).toBeTruthy();
  });

  it("asserts NOTHING while the MT5 state has not loaded", () => {
    h.mt5State = undefined;
    render(<LiveTradeCard trade={trade} />);
    expect(screen.queryByTestId("badge-live-blocked")).toBeNull();
    expect(screen.queryByTestId("badge-bridge-offline")).toBeNull();
  });
});

const snap = {
  currentPrice: 1.105,
  floatingPnl: 5,
  rMultiple: 0.5,
  health: { score: 60, state: "on_track" },
  primarySuggestion: "Hold.",
  suggestions: { breakEven: { recommended: false }, trail: { recommended: false }, partial: { recommended: false } },
};

describe("LiveTradeCard capability badges are gated, not unconditional", () => {
  it("does not claim SL/TP edit or manual close while the kill switch is engaged and the bridge is offline", () => {
    h.snap = snap;
    h.mt5State = { connected: false, liveAllowed: false };
    h.queries["/me/protective-auto-close/settings"] = { settings: { killSwitchEngaged: true } };
    render(<LiveTradeCard trade={trade} />);
    expect(screen.getByTestId("badge-auto-close-killed")).toBeTruthy();
    expect(screen.queryByTestId("badge-sltp-editable")).toBeNull();
    expect(screen.queryByTestId("badge-manual-close")).toBeNull();
  });

  it("does not claim them while the kill-switch state has not been read", () => {
    h.snap = snap;
    h.mt5State = { connected: true, liveAllowed: true };
    render(<LiveTradeCard trade={trade} />);
    expect(screen.queryByTestId("badge-sltp-editable")).toBeNull();
    expect(screen.queryByTestId("badge-manual-close")).toBeNull();
  });

  it("does not claim them before the card shows the controls (no snapshot)", () => {
    h.mt5State = { connected: true, liveAllowed: true };
    h.queries["/me/protective-auto-close/settings"] = { settings: { killSwitchEngaged: false } };
    render(<LiveTradeCard trade={trade} />);
    expect(screen.queryByTestId("badge-sltp-editable")).toBeNull();
    expect(screen.queryByTestId("badge-manual-close")).toBeNull();
  });

  it("shows them when the controls are on screen, the kill switch reads off and the bridge is connected", () => {
    h.snap = snap;
    h.mt5State = { connected: true, liveAllowed: true };
    h.queries["/me/protective-auto-close/settings"] = { settings: { killSwitchEngaged: false } };
    render(<LiveTradeCard trade={trade} />);
    expect(screen.getByTestId("badge-sltp-editable").textContent).not.toMatch(/TP/);
    expect(screen.getByTestId("badge-manual-close")).toBeTruthy();
  });
});

describe("LiveTradeCard header mode badge", () => {
  it("labels the stored mode as the Safety Core state at entry, not a venue", () => {
    render(<LiveTradeCard trade={trade} />);
    const b = screen.getByTestId("badge-trade-mode-1");
    expect(b.textContent).not.toBe("LIVE");
    expect(b.textContent).toMatch(/Safety Core/);
    expect(b.getAttribute("title") ?? "").toMatch(/not a broker/i);
  });
});
