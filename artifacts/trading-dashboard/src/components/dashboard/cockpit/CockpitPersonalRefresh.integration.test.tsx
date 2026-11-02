import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AccountSnapshotCard } from "./CockpitCards";
import { LiveAccountSnapshotProvider } from "@/hooks/useLiveAccountSnapshotContext";
import { useLiveAccountSnapshotCtx } from "@/hooks/useLiveAccountSnapshotContext";
import { useLiveBridgeRefreshState } from "@/hooks/useLiveBridgeRefresh";
import { LiveBridgeAutoRefreshControl } from "@/components/live/LiveBridgeAutoRefreshControl";
import { getGetMt5StatusQueryKey } from "@workspace/api-client-react";

const mode = vi.hoisted(() => ({ isLiveShared: true, isLoading: false, isAdmin: false }));
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => mode }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Eleanor" }) }));
const NOW = Date.parse("2026-11-01T12:00:00.000Z");
class Stream {
  static OPEN = 1;
  static instances: Stream[] = [];
  readyState = 0;
  onerror: (() => void) | null = null;
  listeners: ((event: { data: string }) => void)[] = [];
  constructor() { Stream.instances.push(this); }
  addEventListener(_type: string, listener: (event: { data: string }) => void) { this.listeners.push(listener); }
  close() { this.readyState = 2; }
  emit(data: unknown) { this.readyState = 1; this.listeners.forEach(listener => listener({ data: JSON.stringify(data) })); }
}
const report = (balance: string, profit = "-7.125") => ({
  status: "reported", currentVerified: false, reason: "CLOCK_AND_CONTINUITY_UNVERIFIED",
  observedAt: new Date(NOW - 2000).toISOString(), receivedAt: new Date(NOW - 1000).toISOString(),
  currency: "KWD", currencyDigits: 3,
  amounts: { balance, equity: "0.000", profit, credit: "4.000", margin: "0.000", freeMargin: "0.000" },
});
let summary: Record<string, unknown> = { masterAccess: false, accounts: [], allocationView: { hasAllocation: false, availableAllocation: null } };
let client: QueryClient;
let persisted: Record<string, unknown>;
let fetcher: ReturnType<typeof vi.fn>;
let personalFailure: boolean;
let sharedFailure: boolean;
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); localStorage.clear(); Stream.instances = []; personalFailure = false; sharedFailure = false; mode.isAdmin = false;
  summary = { masterAccess: false, accounts: [], allocationView: { hasAllocation: false, availableAllocation: null } };
  Object.defineProperty(document, "hidden", { configurable: true, value: false }); vi.stubGlobal("EventSource", Stream);
  persisted = { connected: true, accountSnapshot: { broker: "Personal fixture", account: "12345678" }, nativeAccountReport: report("1000.123"), openPositions: [] };
  fetcher = vi.fn(async (url: unknown) => {
    if (String(url).endsWith("/api/mt5/status")) { if (personalFailure) throw Error("Synthetic account read failure"); return response(persisted); }
    if (String(url).endsWith("/api/me/shared-account/summary")) { if (sharedFailure) throw Error("Synthetic shared read failure"); return response(summary); }
    if (String(url).endsWith("/api/me/live/slot-summary")) return response({ dataFreshness: "MISSING", isAllocated: false });
    throw Error("Unexpected endpoint " + String(url));
  });
  vi.stubGlobal("fetch", fetcher);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const personalCalls = () => fetcher.mock.calls.filter(([url]) => String(url).endsWith("/api/mt5/status"));
function ManualControl() { return <LiveBridgeAutoRefreshControl {...useLiveBridgeRefreshState(useLiveAccountSnapshotCtx())} />; }
const mount = (count = 1) => render(<QueryClientProvider client={client}><LiveAccountSnapshotProvider>
  <ManualControl />
  {Array.from({ length: count }, (_, i) => <div data-testid={`surface-${i}`} key={i}><AccountSnapshotCard /></div>)}
</LiveAccountSnapshotProvider></QueryClientProvider>);

it("actual Cockpit consumes the existing personal hint before polling, without a second stream or duplicate money read", async () => {
  mount(2); await flush(1);
  expect(Stream.instances).toHaveLength(1); expect(personalCalls()).toHaveLength(1);
  for (const n of [0, 1]) expect(within(screen.getByTestId(`surface-${n}`)).getByTestId("native-money-balance").textContent).toBe("KWD 1,000.123");
  persisted = { ...persisted, nativeAccountReport: report("9007199254740993.123", "-9.625") };
  const before = Date.now(); act(() => Stream.instances[0]!.emit({ type: "personal_account_changed" })); await flush(30);
  expect(Date.now() - before).toBeLessThan(5000); expect(personalCalls()).toHaveLength(2);
  for (const n of [0, 1]) {
    const surface = within(screen.getByTestId(`surface-${n}`));
    expect(surface.getByTestId("native-money-balance").textContent).toBe("KWD 9,007,199,254,740,993.123");
    expect(surface.getByTestId("native-money-equity").textContent).toBe("KWD 0.000");
    expect(surface.getByTestId("native-money-profit").textContent).toBe("KWD -9.625");
    expect(surface.getByText(/current state unverified/)).toBeTruthy();
  }
  expect(personalCalls().every(([, options]) => options?.cache === "no-store")).toBe(true);
});

it("an external-account refresh failure withholds cached money and the next hint recovers it", async () => {
  mount(); await flush(1); expect(screen.getByTestId("native-money-balance").textContent).toBe("KWD 1,000.123");
  personalFailure = true; act(() => Stream.instances[0]!.emit({ type: "personal_account_changed" })); await flush(30);
  expect(screen.getByTestId("native-money-balance").textContent).toBe("—");
  personalFailure = false; persisted = { ...persisted, nativeAccountReport: report("750.123") };
  act(() => Stream.instances[0]!.emit({ type: "personal_account_changed" })); await flush(30);
  expect(screen.getByTestId("native-money-balance").textContent).toBe("KWD 750.123"); expect(personalCalls()).toHaveLength(3);
});

it("selected connection removal clears figures and unmount closes the single stream", async () => {
  const view = mount(); await flush(1); const stream = Stream.instances[0]!;
  persisted = { connected: false, accountSnapshot: null, nativeAccountReport: null, openPositions: [] };
  act(() => stream.emit({ type: "personal_account_changed" })); await flush(30);
  expect(screen.queryByText("KWD 1,000.123")).toBeNull();
  expect(client.getQueryData(getGetMt5StatusQueryKey())).toMatchObject({ nativeAccountReport: null });
  const calls = personalCalls().length; view.unmount(); expect(stream.readyState).toBe(2);
  act(() => stream.emit({ type: "personal_account_changed" })); await flush(30); expect(personalCalls()).toHaveLength(calls);
});

for (const authority of ["personal", "master"] as const) {
  it(`paused Cockpit manual Refresh rereads ${authority} native money before polling`, async () => {
    localStorage.setItem("arx_autoRefresh_enabled", "false");
    if (authority === "master") { mode.isAdmin = true; summary = { masterAccess: true, accounts: [], masterMt5: { nativeAccountReport: report("1000.123") } }; }
    mount(); await flush(1);
    expect(screen.getByTestId("native-money-balance").textContent).toBe("KWD 1,000.123");
    if (authority === "master") summary = { ...summary, masterMt5: { nativeAccountReport: report("9007199254740993.123", "-12.345") } };
    else persisted = { ...persisted, nativeAccountReport: report("9007199254740993.123", "-12.345") };
    fireEvent.click(screen.getByRole("button", { name: "Refresh" })); await flush(30);
    expect(screen.getByTestId("native-money-balance").textContent).toBe("KWD 9,007,199,254,740,993.123");
    for (const [field, value] of Object.entries({ equity: "0.000", profit: "-12.345", credit: "4.000", margin: "0.000", freeMargin: "0.000" })) {
      expect(screen.getByTestId(`native-money-${field}`).textContent).toBe(`KWD ${value}`);
    }
    expect(fetcher.mock.calls.filter(([url]) => !String(url).endsWith("slot-summary")).every(([, options]) => options?.cache === "no-store")).toBe(true);
    expect(screen.getByText(/current state unverified/)).toBeTruthy();
    expect(Stream.instances).toHaveLength(0);
    expect(localStorage.getItem("arx_autoRefresh_enabled")).toBe("false");
    expect(screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled")).toBe(false);
    if (authority === "master") expect(personalCalls()).toHaveLength(0);
  });
}
it("manual Refresh retains a fresh trailing canonical read after a pre-click request and keeps busy past slot completion", async () => {
  localStorage.setItem("arx_autoRefresh_enabled", "false"); mount(); await flush(1);
  let resolveOld!: (value: Response) => void;
  const normal = fetcher.getMockImplementation()!;
  fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve; }));
  const oldRead = client.refetchQueries({ queryKey: getGetMt5StatusQueryKey(), exact: true });
  await flush(1);
  persisted = { ...persisted, nativeAccountReport: report("3000.123") };
  fireEvent.click(screen.getByRole("button", { name: "Refresh" })); await flush(1);
  expect(screen.getByRole("button", { name: "Refreshing…" }).hasAttribute("disabled")).toBe(true);
  await act(async () => { resolveOld(response({ ...persisted, nativeAccountReport: report("9007199254740993.123", "-12.345") })); await oldRead; });
  fetcher.mockImplementation(normal); await flush(30);
  expect(screen.getByTestId("native-money-balance").textContent).toBe("KWD 3,000.123");
  expect(personalCalls()).toHaveLength(3);
  expect(screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled")).toBe(false);
});
it("failed manual canonical read withholds cached money, clears busy, and a later explicit click recovers", async () => {
  localStorage.setItem("arx_autoRefresh_enabled", "false"); mount(); await flush(1);
  personalFailure = true; fireEvent.click(screen.getByRole("button", { name: "Refresh" })); await flush(30);
  expect(screen.getByTestId("native-money-balance").textContent).toBe("—");
  personalFailure = false; persisted = { ...persisted, nativeAccountReport: report("4000.123") };
  fireEvent.click(screen.getByRole("button", { name: "Refresh" })); await flush(30);
  expect(screen.getByTestId("native-money-balance").textContent).toBe("KWD 4,000.123");
});

it("master canonical failure withholds old report and an explicit retry recovers", async () => {
  localStorage.setItem("arx_autoRefresh_enabled", "false"); mode.isAdmin = true;
  summary = { masterAccess: true, accounts: [], masterMt5: { nativeAccountReport: report("1000.123") } };
  mount(); await flush(1); sharedFailure = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh" })); await flush(30);
  expect(screen.getByTestId("native-money-balance").textContent).toBe("—");
  sharedFailure = false; summary = { ...summary, masterMt5: { nativeAccountReport: report("5000.123") } };
  fireEvent.click(screen.getByRole("button", { name: "Refresh" })); await flush(30);
  expect(screen.getByTestId("native-money-balance").textContent).toBe("KWD 5,000.123");
  expect(personalCalls()).toHaveLength(0);
});
it("enabled manual refresh survives its own SSE reconnect and updates canonical money", async () => {
  mount(); await flush(1); act(() => Stream.instances[0]!.emit({ type: "account_snapshot", snapshot: { accountMode: "UNKNOWN", freshness: "unavailable", positions: [], receivedAtMs: NOW, snapshotAtMs: null, warnings: [] } })); await flush(1);
  persisted = { ...persisted, nativeAccountReport: report("6000.123") };
  fireEvent.click(screen.getByRole("button", { name: "Refresh" })); await flush(30);
  expect(screen.getByTestId("native-money-balance").textContent).toBe("KWD 6,000.123");
  expect(Stream.instances).toHaveLength(2); expect(Stream.instances[0]!.readyState).toBe(2);
});
it("cache removal retires a pending trailing read; only another explicit click creates a new manual controller", async () => {
  localStorage.setItem("arx_autoRefresh_enabled", "false"); mount(); await flush(1);
  let resolveOld!: (value: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve; }));
  void client.refetchQueries({ queryKey: getGetMt5StatusQueryKey(), exact: true }); await flush(1);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" })); await flush(1);
  act(() => client.removeQueries({ queryKey: getGetMt5StatusQueryKey(), exact: true })); await flush(1);
  const before = personalCalls().length;
  await act(async () => { resolveOld(response(persisted)); }); await flush(30);
  expect(personalCalls()).toHaveLength(before);
  expect(screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled")).toBe(false);
  persisted = { ...persisted, nativeAccountReport: report("7000.123") };
  fireEvent.click(screen.getByRole("button", { name: "Refresh" })); await flush(30);
  expect(screen.getByTestId("native-money-balance").textContent).toBe("KWD 7,000.123");
});
it("unmount retires manual trailing work even if transport ignores abort", async () => {
  localStorage.setItem("arx_autoRefresh_enabled", "false"); const view = mount(); await flush(1);
  let resolveOld!: (value: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve; }));
  void client.refetchQueries({ queryKey: getGetMt5StatusQueryKey(), exact: true }); await flush(1);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" })); await flush(1);
  const before = personalCalls().length; view.unmount();
  resolveOld(response(persisted)); await flush(50); expect(personalCalls()).toHaveLength(before);
});
