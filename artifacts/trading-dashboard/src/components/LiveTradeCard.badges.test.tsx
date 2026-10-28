import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

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
  closeMutate: (() => Promise.resolve()) as (...a: unknown[]) => Promise<unknown>,
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetTradeSnapshot: () => ({ data: h.snap }),
  useGetCoachExplanation: () => ({ data: undefined, isLoading: false }),
  useMoveTradeToBreakeven: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTrailTradeStop: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePartialCloseTrade: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCloseTradeManually: () => ({ mutateAsync: h.closeMutate, isPending: false }),
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
  h.closeMutate = () => Promise.resolve();
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

// Round 3: the stop / close badges must follow what /trade-management
// actually enforces. Those routes act on the paper book through the Position
// Guardian, with no MT5 bridge dependency, and close / trail answer 409
// NO_CURRENT_QUOTE when the server has no quote for the symbol.
describe("LiveTradeCard capability badges follow the server's real conditions", () => {
  const noQuoteSnap = {
    currentPrice: null,
    floatingPnl: null,
    rMultiple: null,
    health: null,
    priceUnavailableReason: "No quote for EURUSD.",
    primarySuggestion: "No live quote.",
    suggestions: { breakEven: { recommended: false }, trail: { recommended: false }, partial: { recommended: false } },
  };

  it("does not claim close / stop moves while the server has no quote (close and trail return 409)", () => {
    h.snap = noQuoteSnap;
    h.mt5State = { connected: true, liveAllowed: true };
    h.queries["/me/protective-auto-close/settings"] = { settings: { killSwitchEngaged: false } };
    render(<LiveTradeCard trade={trade} />);
    expect(screen.getByTestId("snap-current-1").textContent).toMatch(/Unavailable/);
    expect(screen.queryByTestId("badge-manual-close")).toBeNull();
    expect(screen.queryByTestId("badge-sltp-editable")).toBeNull();
  });

  it("claims them with the MT5 bridge offline, because these controls act on the ARX paper record, not the bridge", () => {
    h.snap = snap;
    h.mt5State = { connected: false, liveAllowed: false };
    h.queries["/me/protective-auto-close/settings"] = { settings: { killSwitchEngaged: false } };
    render(<LiveTradeCard trade={trade} />);
    expect(screen.getByTestId("badge-manual-close")).toBeTruthy();
    expect(screen.getByTestId("badge-sltp-editable")).toBeTruthy();
  });

  it("claims them while the bridge status has not loaded, since the controls do not depend on it", () => {
    h.snap = snap;
    h.mt5State = undefined;
    h.queries["/me/protective-auto-close/settings"] = { settings: { killSwitchEngaged: false } };
    render(<LiveTradeCard trade={trade} />);
    expect(screen.getByTestId("badge-manual-close")).toBeTruthy();
  });
});

describe("LiveTradeCard management buttons report a refused request", () => {
  it("says the close did not go through when the server answers 409, instead of failing silently", async () => {
    h.snap = snap;
    h.closeMutate = () => Promise.reject(new Error("HTTP 409 Conflict: NO_CURRENT_QUOTE"));
    render(<LiveTradeCard trade={trade} />);
    fireEvent.click(screen.getByTestId("button-close-1"));
    await waitFor(() => expect(screen.getByTestId("trade-action-error-1")).toBeTruthy());
    const msg = screen.getByTestId("trade-action-error-1").textContent ?? "";
    expect(msg).toMatch(/Close did not go through/);
    expect(msg).toMatch(/NO_CURRENT_QUOTE/);
  });
});

// Round 3: trades.mode is the Safety Core state at entry, not a venue. Every
// row this card renders is a simulated ARX record (lib/db schema/trades.ts),
// so the simulated badge must not depend on mode.
describe("LiveTradeCard simulated-record badge does not read trades.mode as a venue", () => {
  it("marks a record written while Safety Core was LIVE as simulated", () => {
    render(<LiveTradeCard trade={trade} />);
    expect(screen.getByTestId("badge-trade-mode-1").getAttribute("title") ?? "").toMatch(/not a broker venue/i);
    const b = screen.getByTestId("badge-paper-only");
    expect(b.textContent).toMatch(/Simulated/);
    expect(b.getAttribute("title") ?? "").toMatch(/no broker order/i);
  });

  it("marks a DEMO-mode record the same way", () => {
    render(<LiveTradeCard trade={{ ...(trade as object), mode: "DEMO" } as never} />);
    expect(screen.getByTestId("badge-paper-only").textContent).toMatch(/Simulated/);
  });
});
