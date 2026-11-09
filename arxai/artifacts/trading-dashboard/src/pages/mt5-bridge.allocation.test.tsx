// Regression (truth review, pass 2): the MT5 Bridge page read
// `(mode as any).userAllocation` / `.assignedStartingBalance` from what
// useTradingMode() returns. Neither field exists there, so the Allocation
// tile, row and header chip always showed "—" whatever was assigned. The same
// cast read the risk caps (allowed markets, max lot, max open trades, stop
// loss required) and the freeze message from fields the hook does not return,
// so "Stop Loss Required: No" and "All approved symbols" were shown even when
// the server reported the opposite.
//
// The allocation now comes from the canonical per-user allocation view on the
// shared-account summary (the same source the live dispatch gate reads); the
// caps and freeze message come from the account-mode envelope. Missing or
// failed reads are said so, never shown as a value.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

let mode: Record<string, unknown> = {};
let summary: { data?: unknown; isLoading?: boolean; isError?: boolean } = {};
vi.mock("@workspace/api-client-react", () => ({
  useGetMt5Status: () => ({ data: { connected: true, secondsSinceHeartbeat: 3 }, isLoading: false }),
  useGetMeSharedAccountSummary: () => summary,
  getGetMt5StatusQueryKey: () => ["mt5-status"],
  getGetMeSharedAccountSummaryQueryKey: () => ["summary"],
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: () => {} }) }));
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => mode }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Eleanor" }) }));

const { default: MT5BridgePage } = await import("./mt5-bridge");

function values(label: string): string[] {
  return screen.getAllByText(label, { exact: true }).map((e) => (e.parentElement?.textContent ?? "").replace(label, "").trim());
}

const allocationView = (over: Record<string, unknown> = {}) => ({
  assignedAllocation: 2500, availableAllocation: 2400, reservedRisk: 100, openFloatingLoss: 0,
  bridgeAvailability: "HEALTHY", bridgeMessage: "", hasAllocation: true, isOverAllocated: false, ...over,
});

const envelope = (over: Record<string, unknown> = {}) => ({
  userApprovalStatus: "APPROVED", liveExecutionArmed: false,
  userAllocation: { hasAllocation: true, currentBalance: 2600, assignedStartingBalance: 2600, equity: null, marginUsed: null },
  userRiskCaps: { maxLotSize: 0.5, maxOpenTrades: 3, maxDailyLossAmount: 50, allowedSymbols: ["EURUSD", "XAUUSD"], requireStopLoss: true },
  userFrozenStatus: { isFrozen: false, freezeMessage: null },
  ...over,
});

const baseMode = (env: Record<string, unknown> | null, over: Record<string, unknown> = {}) => ({
  isLoading: false, isFrozen: false, isLiveShared: true, isLiveArmed: false, isModeUnknown: env == null,
  cleanBlockedReason: null, cleanModeLabel: "Live Shared", hasRiskCaps: true, envelope: env, ...over,
});

afterEach(() => cleanup());

describe("mt5-bridge allocation", () => {
  it("shows the assigned allocation from the allocation view (tile, row and header)", () => {
    mode = baseMode(envelope());
    summary = { data: { ok: true, userId: 7, accounts: [], allocationView: allocationView() }, isLoading: false, isError: false };
    const { container } = render(<MT5BridgePage />);
    const vals = values("Allocation");
    expect(vals.length).toBeGreaterThan(0);
    for (const v of vals) expect(v).toMatch(/\$2,500\.00/);
    expect(container.textContent).not.toMatch(/Allocation\s*—/);
  });

  it("no allocation assigned says 'Not assigned', not a dash or $0", () => {
    mode = baseMode(envelope());
    summary = { data: { ok: true, userId: 7, accounts: [], allocationView: allocationView({ hasAllocation: false, assignedAllocation: 0 }) } };
    render(<MT5BridgePage />);
    for (const v of values("Allocation")) {
      expect(v).toBe("Not assigned");
    }
  });

  it("a failed allocation read says it could not be loaded", () => {
    mode = baseMode(envelope());
    summary = { data: undefined, isLoading: false, isError: true };
    render(<MT5BridgePage />);
    for (const v of values("Allocation")) expect(v).toBe("Could not be loaded");
  });

  it("an error-path summary (allocationView null) is not shown as an allocation", () => {
    mode = baseMode(envelope());
    summary = { data: { ok: false, userId: 7, accounts: [], allocationView: null, error: "db down" } };
    render(<MT5BridgePage />);
    for (const v of values("Allocation")) expect(v).toBe("Could not be loaded");
  });
});

describe("mt5-bridge risk caps come from the account-mode envelope", () => {
  it("reports the server's caps: allowed markets, max lot, max open trades, stop loss required", () => {
    mode = baseMode(envelope());
    summary = { data: { ok: true, userId: 7, accounts: [], allocationView: allocationView() } };
    render(<MT5BridgePage />);
    expect(values("Allowed Markets").join(" ")).toMatch(/2 approved/);
    expect(values("Max Lot Size").join(" ")).toMatch(/0\.5/);
    expect(values("Max Open Trades").join(" ")).toMatch(/^3$/);
    expect(values("Stop Loss Required").join(" ")).toMatch(/Yes/);
  });

  it("no restriction list (null) is 'All approved symbols'; stop loss not required is 'No'", () => {
    mode = baseMode(envelope({ userRiskCaps: { maxLotSize: null, maxOpenTrades: null, maxDailyLossAmount: null, allowedSymbols: null, requireStopLoss: false } }));
    summary = { data: { ok: true, userId: 7, accounts: [], allocationView: allocationView() } };
    render(<MT5BridgePage />);
    expect(values("Allowed Markets").join(" ")).toMatch(/All approved symbols/);
    expect(values("Stop Loss Required").join(" ")).toMatch(/No/);
    expect(values("Max Lot Size").join(" ")).toMatch(/Not set/);
  });

  it("an unknown account mode does not claim 'No' stop loss or 'All approved symbols'", () => {
    mode = baseMode(null);
    summary = { data: { ok: true, userId: 7, accounts: [], allocationView: allocationView() } };
    render(<MT5BridgePage />);
    for (const label of ["Allowed Markets", "Max Lot Size", "Max Open Trades", "Stop Loss Required"]) {
      const v = values(label).join(" ");
      expect(v, label).toMatch(/Could not be checked/);
    }
  });

  it("a frozen account shows the server's freeze message", () => {
    mode = baseMode(envelope({ userFrozenStatus: { isFrozen: true, freezeMessage: "Paused by your operator for review." } }), { isFrozen: true });
    summary = { data: { ok: true, userId: 7, accounts: [], allocationView: allocationView() } };
    render(<MT5BridgePage />);
    expect(screen.getByTestId("bridge-state-copy").textContent).toBe("Paused by your operator for review.");
  });
});
