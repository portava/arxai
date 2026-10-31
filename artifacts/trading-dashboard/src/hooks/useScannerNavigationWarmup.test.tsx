import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { type ReactNode } from "react";
import { useScannerNavigationWarmup } from "./useScannerNavigationWarmup";
import { chartCandlesQueryKey, fetchChartCandles } from "@/lib/chartCandlesQuery";
import { preloadMarketScannerPage } from "@/lib/scannerRoute";
import { useScannerTimeframe } from "./useScannerTimeframe";

vi.mock("@/lib/scannerRoute", () => ({ preloadMarketScannerPage: vi.fn() }));
vi.mock("@/lib/chartCandlesQuery", async (original) => ({
  ...await original<typeof import("@/lib/chartCandlesQuery")>(), fetchChartCandles: vi.fn(),
}));
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
const response = { candles: [], feedStatus: null, originalResponse: { source: "unavailable" } };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); localStorage.clear();
  localStorage.setItem("highroll.chartSymbol", "FX:EURUSD");
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchChartCandles).mockResolvedValue(response);
});
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("warms code at idle without fetching any market data", async () => {
  renderHook(() => useScannerNavigationWarmup(true), { wrapper });
  expect(preloadMarketScannerPage).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(1500));
  expect(preloadMarketScannerPage).toHaveBeenCalledOnce();
  expect(fetchChartCandles).not.toHaveBeenCalled();
});

it("starts candles before the page import resolves and deduplicates focus, pointer and mount", async () => {
  let resolve!: (value: typeof response) => void;
  vi.mocked(fetchChartCandles).mockReturnValue(new Promise(r => { resolve = r; }));
  const h = renderHook(() => useScannerNavigationWarmup(true, false), { wrapper });
  act(() => { h.result.current("/market-scanner"); h.result.current("/market-scanner"); });
  expect(fetchChartCandles).toHaveBeenCalledOnce();
  expect(fetchChartCandles).toHaveBeenCalledWith("EURUSD", "M15", 200, expect.any(AbortSignal));
  const mountedRead = client.fetchQuery({ queryKey: chartCandlesQueryKey("EURUSD", "M15", 200), queryFn: () => fetchChartCandles("EURUSD", "M15", 200), staleTime: 5000 });
  resolve(response);
  expect(await mountedRead).toBe(response);
  expect(fetchChartCandles).toHaveBeenCalledOnce();
  expect(client.getQueryData(chartCandlesQueryKey("EURUSD", "M15", 200))).toBe(response);
});

it("respects the five-second cache budget; warming never resets evidence or its timestamp", async () => {
  const h = renderHook(() => useScannerNavigationWarmup(true, false), { wrapper });
  await act(async () => h.result.current("/market-scanner"));
  const key = chartCandlesQueryKey("EURUSD", "M15", 200);
  const updatedAt = client.getQueryState(key)!.dataUpdatedAt;
  await act(async () => { vi.advanceTimersByTime(4000); h.result.current("/market-scanner"); });
  expect(fetchChartCandles).toHaveBeenCalledOnce();
  expect(client.getQueryState(key)!.dataUpdatedAt).toBe(updatedAt);
  await act(async () => { vi.advanceTimersByTime(1001); h.result.current("/market-scanner"); });
  expect(fetchChartCandles).toHaveBeenCalledTimes(2);
});

it("does nothing for denied roles or other destinations and cancels idle work on loss of access", async () => {
  const h = renderHook(({ allowed }) => useScannerNavigationWarmup(allowed), { wrapper, initialProps: { allowed: true } });
  act(() => h.result.current("/settings"));
  h.rerender({ allowed: false });
  await act(async () => { h.result.current("/market-scanner"); vi.advanceTimersByTime(5000); });
  expect(preloadMarketScannerPage).not.toHaveBeenCalled();
  expect(fetchChartCandles).not.toHaveBeenCalled();
});

it("uses the latest in-memory timeframe even when storage writes are denied", async () => {
  const h = renderHook(() => ({ warm: useScannerNavigationWarmup(true, false), tf: useScannerTimeframe() }), { wrapper });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("denied"); });
  act(() => h.result.current.tf[1]("M2"));
  await act(async () => h.result.current.warm("/market-scanner"));
  expect(fetchChartCandles).toHaveBeenCalledWith("EURUSD", "M2", 200, expect.any(AbortSignal));
  act(() => h.result.current.tf[1]("W1"));
  await act(async () => h.result.current.warm("/market-scanner"));
  expect(fetchChartCandles).toHaveBeenCalledOnce();
});

it("survives blocked storage and failed prefetch without retries or fabricated data", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw Error("denied"); });
  vi.mocked(fetchChartCandles).mockRejectedValue(Error("offline"));
  const h = renderHook(() => useScannerNavigationWarmup(true, false), { wrapper });
  await act(async () => h.result.current("/market-scanner"));
  expect(fetchChartCandles).toHaveBeenCalledWith("V75", "M15", 200, expect.any(AbortSignal));
  expect(client.getQueryData(chartCandlesQueryKey("V75", "M15", 200))).toBeUndefined();
  expect(fetchChartCandles).toHaveBeenCalledOnce();
});

it("does not start idle imports with data saver or a hidden document", async () => {
  Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } });
  const a = renderHook(() => useScannerNavigationWarmup(true), { wrapper });
  await act(async () => vi.advanceTimersByTime(2000));
  a.unmount();
  Object.defineProperty(navigator, "connection", { configurable: true, value: undefined });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  renderHook(() => useScannerNavigationWarmup(true), { wrapper });
  await act(async () => vi.advanceTimersByTime(2000));
  expect(preloadMarketScannerPage).not.toHaveBeenCalled();
});
