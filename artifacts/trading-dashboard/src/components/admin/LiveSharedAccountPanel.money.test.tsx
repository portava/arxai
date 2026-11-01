import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { SharedBridgePoolCard } from "./LiveSharedAccountPanel";

const state = vi.hoisted(() => ({ pool: {} as any, summary: {} as any, queryOptions: null as any }));
vi.mock("@tanstack/react-query", async importOriginal => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQuery: (options: { queryKey: string[] }) => options.queryKey[0] === "adminMasterPool" ? state.pool : { data: { users: [] } },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("@workspace/api-client-react", async importOriginal => ({
  ...await importOriginal<typeof import("@workspace/api-client-react")>(),
  useGetMeSharedAccountSummary: (options: unknown) => { state.queryOptions = options; return state.summary; },
}));

const NOW = Date.parse("2026-11-01T18:00:00.000Z");
const native = () => ({
  status: "reported", currentVerified: false, reason: "CLOCK_AND_CONTINUITY_UNVERIFIED",
  observedAt: new Date(NOW - 2000).toISOString(), receivedAt: new Date(NOW - 1000).toISOString(),
  currency: "KWD", currencyDigits: 3,
  amounts: { balance: "1234.567", equity: "1240.123", profit: "-4.444", credit: "10.000", margin: "20.000", freeMargin: "1220.123" },
});
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  state.pool = { data: { ok: true, pool: {
    mt5Balance: 9999, mt5Equity: 9998, totalAllocated: 400, totalUserUnrealizedPnl: 7,
    snapshotStatus: "FRESH", snapshotAgeMs: 0, lastMt5SnapshotAt: new Date(NOW).toISOString(),
    bridgeAvailability: "HEALTHY", isOverAllocated: false,
  } }, isError: false };
  state.summary = { data: { masterAccess: true, masterMt5: { nativeAccountReport: native() } }, isError: false };
  state.queryOptions = null;
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("uses the existing native account report, never the older pool scalars or derived profit", () => {
  render(<SharedBridgePoolCard />);
  expect(screen.getByTestId("native-money-balance").textContent).toBe("KWD 1,234.567");
  expect(screen.getByTestId("native-money-equity").textContent).toBe("KWD 1,240.123");
  expect(screen.getByTestId("native-money-profit").textContent).toBe("KWD -4.444");
  expect(screen.queryByText("$9999.00")).toBeNull();
  expect(screen.queryByText("$9998.00")).toBeNull();
  expect(screen.queryByText(/^FRESH/)).toBeNull();
  expect(screen.getByText(/current state unverified/)).toBeTruthy();
});
it.each([null, { status: "unavailable", reason: "ACCOUNT_BINDING_MISMATCH", amounts: null }])("holds missing or rejected native money without pool fallback: %j", report => {
  state.summary.data.masterMt5.nativeAccountReport = report;
  render(<SharedBridgePoolCard />);
  expect(screen.getByTestId("native-money-equity").textContent).toBe("—");
  expect(screen.queryByText("$9998.00")).toBeNull();
  expect(screen.queryByText("$0.00")).toBeNull();
});
it("withholds cached native money after a failed refresh", () => {
  state.summary.isError = true;
  render(<SharedBridgePoolCard />);
  expect(screen.getByTestId("native-money-balance").textContent).toBe("—");
});
it.each([false, undefined])("does not render master report without explicit access: %s", access => {
  state.summary.data.masterAccess = access;
  render(<SharedBridgePoolCard />);
  expect(screen.queryByTestId("native-account-report")).toBeNull();
  expect(screen.queryByText(/1,234.567/)).toBeNull();
});
it("new reports update all native fields together at reported precision", () => {
  const { rerender } = render(<SharedBridgePoolCard />);
  state.summary.data.masterMt5.nativeAccountReport = { ...native(), amounts: {
    balance: "2000.123", equity: "1980.123", profit: "-20.000", credit: "0.000", margin: "25.000", freeMargin: "1955.123",
  } };
  rerender(<SharedBridgePoolCard />);
  for (const [key, text] of Object.entries({ balance: "2,000.123", equity: "1,980.123", profit: "-20.000", credit: "0.000", margin: "25.000", freeMargin: "1,955.123" })) {
    expect(screen.getByTestId(`native-money-${key}`).textContent).toBe(`KWD ${text}`);
  }
});
it("a heartbeat cannot keep an old native report fresh", () => {
  render(<SharedBridgePoolCard />);
  act(() => { vi.advanceTimersByTime(125000); });
  expect(screen.getByText(/Stale report/)).toBeTruthy();
  expect(screen.queryByText(/^FRESH/)).toBeNull();
});
it("cached pool data is withheld when its own read fails", () => {
  state.pool.isError = true;
  render(<SharedBridgePoolCard />);
  expect(screen.queryByTestId("pool-total-allocated")).toBeNull();
  expect(screen.getByTestId("native-money-balance").textContent).toBe("KWD 1,234.567");
});
it.each([undefined, null, NaN, Infinity])("missing or invalid allocation risk %s stays unknown instead of zero", value => {
  state.pool.data.pool.totalReservedRisk = value;
  render(<SharedBridgePoolCard />);
  expect(screen.getByTestId("pool-reserved-risk").textContent).toBe("—");
  expect(screen.getByTestId("native-money-margin").textContent).toBe("KWD 20.000");
});
it("an explicitly recorded zero allocation value remains zero", () => {
  state.pool.data.pool.totalReservedRisk = 0;
  render(<SharedBridgePoolCard />);
  expect(screen.getByTestId("pool-reserved-risk").textContent).toBe("0");
});
it("a rejected pool response cannot reuse its money or status", () => {
  state.pool.data.ok = false;
  render(<SharedBridgePoolCard />);
  expect(screen.queryByTestId("pool-total-allocated")).toBeNull();
  expect(screen.queryByText(/Stored allocation gate/)).toBeNull();
  expect(screen.getByTestId("native-money-balance").textContent).toBe("KWD 1,234.567");
});
it("uses the canonical summary cache key with bounded existing polling and no background polling", () => {
  render(<SharedBridgePoolCard />);
  expect(state.queryOptions.query.queryKey).toEqual(["/api/me/shared-account/summary"]);
  expect(state.queryOptions.query.refetchInterval).toBe(3000);
  expect(state.queryOptions.query.refetchIntervalInBackground).toBe(false);
});
