import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Analytics from "./analytics";

import { getGetMt5StatusQueryKey } from "@workspace/api-client-react";

const performanceFixture = vi.hoisted(() => ({ value: undefined as undefined | { maxDrawdown: number; totalTrades: number } }));
vi.mock("@workspace/api-client-react", async importOriginal => ({
 ...await importOriginal<typeof import("@workspace/api-client-react")>(),
 useGetPerformanceSummary: () => ({ data: performanceFixture.value }), useGetDailyPerformance: () => ({ data: [] }),
 useGetStrategies: () => ({ data: [] }), useGetMeSharedAccountPositions: () => ({ data: { rows: [] } }),
}));
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
const summary = { balance: 111111, equity: 222222, pnl: 333333, masterAccess: false, accounts: [], allocationView: { hasAllocation: false, availableAllocation: null } };
let client: QueryClient;
let persisted: Record<string, unknown>;
let fetcher: ReturnType<typeof vi.fn>;
let personalFailure: boolean;
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
beforeEach(() => {
  performanceFixture.value = undefined;
  vi.useFakeTimers(); vi.setSystemTime(NOW); localStorage.clear(); Stream.instances = []; personalFailure = false;
  Object.defineProperty(document, "hidden", { configurable: true, value: false }); vi.stubGlobal("EventSource", Stream);
  persisted = { connected: true, accountSnapshot: { broker: "Personal fixture", account: "12345678" }, nativeAccountReport: report("1000.123"), openPositions: [] };
  fetcher = vi.fn(async (url: unknown) => {
    if (String(url).endsWith("/api/mt5/status")) { if (personalFailure) throw Error("Synthetic account read failure"); return response(persisted); }
    if (String(url).endsWith("/api/me/shared-account/summary")) return response(summary);
    throw Error("Unexpected endpoint " + String(url));
  });
  vi.stubGlobal("fetch", fetcher);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const personalCalls = () => fetcher.mock.calls.filter(([url]) => String(url).endsWith("/api/mt5/status"));
const mount = () => render(<QueryClientProvider client={client}><div data-testid="surface-0"><Analytics /></div></QueryClientProvider>);

it("actual Analytics consumes the existing personal hint before polling, without a second stream or duplicate money read", async () => {
  mount(); await flush(1);
  expect(Stream.instances).toHaveLength(1); expect(personalCalls()).toHaveLength(1);
  for (const n of [0]) expect(within(screen.getByTestId(`surface-${n}`)).getByTestId("native-money-balance").textContent).toBe("KWD 1,000.123");
  persisted = { ...persisted, nativeAccountReport: report("9007199254740993.123", "-9.625") };
  const before = Date.now(); act(() => Stream.instances[0]!.emit({ type: "personal_account_changed" })); await flush(30);
  expect(Date.now() - before).toBeLessThan(5000); expect(personalCalls()).toHaveLength(2);
  for (const n of [0]) {
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

it("does not use legacy scalar money or invent account health, low risk, or current equity from history", async () => {
 mount(); await flush(1);
 expect(screen.getByTestId("native-money-balance").textContent).toBe("KWD 1,000.123");
 expect(screen.queryByText(/111111|222222|333333/)).toBeNull();
 expect(screen.queryAllByText("Healthy")).toHaveLength(0);
 expect(screen.queryByText("Low")).toBeNull();
 expect(screen.queryByText("Current Equity")).toBeNull();
});

it("a recorded 99 percent drawdown cannot certify Low current account risk", async () => {
 performanceFixture.value = { maxDrawdown: 99, totalTrades: 2 };
 mount(); await flush(1);
 fireEvent.click(screen.getByRole("button", { name: "Risk", exact: true }));
 expect(screen.queryByText("Low")).toBeNull();
 expect(screen.getByText("Not assessed")).toBeTruthy();
});
