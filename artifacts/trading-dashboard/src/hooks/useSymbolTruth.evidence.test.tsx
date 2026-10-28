import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { MarketTruthResponse } from "@workspace/api-client-react";
import { getGetMeMarketTruthQueryKey } from "@workspace/api-client-react";
import { useSymbolTruth } from "./useSymbolTruth";
import { useScannerReadGate } from "./useScannerReadGate";
import { chartCandlesQueryKey } from "@/lib/chartCandlesQuery";
import { selectedMarketQueryOptions } from "@/lib/selectedMarketQuery";

vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => ({ isLoading: false, envelope: null }) }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
const NOW = Date.parse("2026-10-26T14:00:01Z");
const CLOSE = "2026-10-26T14:00:00.000Z";
let client: QueryClient;
const requests: Array<{ url: string; signal: AbortSignal; resolve: (r: Response) => void }> = [];
function snapshot(): MarketTruthResponse {
  const component = { present: true, alignment: "BULLISH" as const, label: "Bullish", asOf: CLOSE };
  return {
    symbol: "EURUSD", displaySymbol: "EUR/USD", timeframe: "M1", generatedAt: new Date(NOW).toISOString(),
    data: { state: "LIVE_CONFIRMED", source: "mt5_broker", sourceLabel: "Live broker feed", price: 1.1, lastCandleAt: CLOSE, lastTickAt: CLOSE },
    components: { scanner: component, flame: component, scalp: component, timing: component },
    news: { providerConnected: true, events: [], riskLabel: "No high impact window", highImpactWindowActive: false, disclaimer: null },
    levels: { entryFrom: 1.1, entryTo: 1.11, stopLoss: 1.09, invalidation: 1.09, takeProfit: [1.12], withheld: false, withheldReason: null },
    verdict: { stage: "ALIGNED", bias: "BULLISH", headline: "Bullish", evidenceFor: ["Scanner is bullish"], evidenceAgainst: [], bestAction: "BUY", bestActionText: "Buy", invalidation: { price: 1.09, side: "BELOW" } },
  };
}
function candlePayload() {
  return {
    candles: Array.from({ length: 200 }, (_, index) => ({ openTime: new Date(Date.parse(CLOSE) - (200 - index) * 60_000).toISOString(), closeTime: new Date(Date.parse(CLOSE) - (199 - index) * 60_000).toISOString(), open: 1.1, high: 1.11, low: 1.09, close: 1.1 })),
    feedStatus: { symbol: "EURUSD", source: "mt5_broker", quality: "clean", isLive: true, aiUsable: true, stale: false, lastCandleTime: CLOSE },
  };
}
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  requests.length = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["me"], { id: 7 });
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => new Promise<Response>((resolve) => {
    requests.push({ url: String(url), signal: init.signal as AbortSignal, resolve });
  })));
});
afterEach(() => { cleanup(); client.clear(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
async function respond(request: typeof requests[number], body: unknown, status = 200) {
  await act(async () => request.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));
}
async function loadCurrent() {
  for (const request of requests.slice()) {
    if (request.url.includes("/market/truth/")) await respond(request, snapshot());
    else if (request.url.includes("/chart/candles")) await respond(request, candlePayload());
    else if (request.url.includes("selected-market")) await respond(request, { ok: true, symbol: "EURUSD", timeframe: "M1", highlights: {}, explanation: {} });
  }
}

it("does not expose an early BUY until the actual candle and header queries confirm the same source/bar", async () => {
  const { result } = renderHook(() => ({ ...useSymbolTruth("EURUSD", "M1"), gate: useScannerReadGate("EURUSD", "M1") }), { wrapper });
  expect(result.current.gate.downgraded).toBe(true);
  await respond(requests.find((r) => r.url.includes("/market/truth/"))!, snapshot());
  await waitFor(() => expect(result.current.verdict?.bestAction).toBe("WATCH_ONLY"));
  expect(result.current.scannerTruth).toBeNull();
  expect(result.current.levels?.withheld).toBe(true);
  expect(result.current.gate.downgraded).toBe(true);
  await respond(requests.find((r) => r.url.includes("/chart/candles"))!, candlePayload());
  await respond(requests.find((r) => r.url.includes("selected-market"))!, { ok: true, symbol: "EURUSD", timeframe: "M1", highlights: {}, explanation: {} });
  await waitFor(() => expect(result.current.verdict?.bestAction).toBe("BUY"));
  expect(result.current.actionCapped).toBe(false);
  expect(result.current.gate.isFull).toBe(true);
});

it("withdraws cached advice immediately after a failed refresh", async () => {
  const { result } = renderHook(() => useSymbolTruth("EURUSD", "M1"), { wrapper });
  await loadCurrent();
  await waitFor(() => expect(result.current.verdict?.bestAction).toBe("BUY"));
  act(() => result.current.refetch());
  const refresh = requests.filter((r) => r.url.includes("/market/truth/")).at(-1)!;
  await respond(refresh, { error: "unavailable" }, 503);
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.snapshot).toBeNull();
  expect(result.current.verdict).toBeNull();
  expect(result.current.levels).toBeNull();
  // A failed refresh with cached data is NOT loading: event risk was not checked.
  expect(result.current.newsState).toBe("unavailable");
});

it("says loading only while the first truth fetch is in flight", async () => {
  const { result } = renderHook(() => useSymbolTruth("EURUSD", "M1"), { wrapper });
  await waitFor(() => expect(requests.some((r) => r.url.includes("/market/truth/"))).toBe(true));
  expect(result.current.news).toBeNull();
  expect(result.current.newsState).toBe("loading");
  await loadCurrent();
  await waitFor(() => expect(result.current.newsState).toBe("available"));
});

it("never reports loading when the query is disabled (no signed-in user)", () => {
  client.setQueryData(["me"], null);
  const { result } = renderHook(() => useSymbolTruth("EURUSD", "M1"), { wrapper });
  expect(result.current.news).toBeNull();
  expect(result.current.newsState).toBe("unavailable");
});

it("isolates users even when identity changes without a full query-cache clear", async () => {
  const { result } = renderHook(() => useSymbolTruth("EURUSD", "M1"), { wrapper });
  await loadCurrent();
  await waitFor(() => expect(result.current.verdict?.bestAction).toBe("BUY"));
  act(() => client.setQueryData(["me"], { id: 8 }));
  await waitFor(() => expect(requests.filter((r) => r.url.includes("/market/truth/"))).toHaveLength(2));
  expect(result.current.snapshot).toBeNull();
  expect(result.current.verdict).toBeNull();
});

it("hides existing evidence when this consumer is disabled and replaces symbol context immediately", async () => {
  const { result, rerender } = renderHook(({ symbol, enabled }) => ({ ...useSymbolTruth(symbol, "M1", { enabled }), gate: useScannerReadGate(symbol, "M1") }), { wrapper, initialProps: { symbol: "EURUSD", enabled: true } });
  await loadCurrent(); await waitFor(() => expect(result.current.verdict?.bestAction).toBe("BUY"));
  rerender({ symbol: "EURUSD", enabled: false });
  expect(result.current.snapshot).toBeNull();
  rerender({ symbol: "GBPUSD", enabled: true });
  expect(result.current.snapshot).toBeNull();
  expect(result.current.gate.downgraded).toBe(true);
  expect(result.current.gate.isFull).toBe(false);
});

it("replaces a confirmed timeframe with a pending read cap immediately", async () => {
  const { result, rerender } = renderHook(({ timeframe }) => ({ ...useSymbolTruth("EURUSD", timeframe), gate: useScannerReadGate("EURUSD", timeframe) }), { wrapper, initialProps: { timeframe: "M1" } });
  await loadCurrent(); await waitFor(() => expect(result.current.verdict?.bestAction).toBe("BUY"));
  rerender({ timeframe: "M15" });
  expect(result.current.snapshot).toBeNull();
  expect(result.current.gate.downgraded).toBe(true);
  expect(result.current.gate.isFull).toBe(false);
});

it("expires cached advice after two normal polls even while coarse candle evidence stays fresh", async () => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  const value = snapshot(); value.timeframe = "M15";
  client.setQueryData([...getGetMeMarketTruthQueryKey("EURUSD", { tf: "M15" }), { userId: 7 }], value);
  const payload = candlePayload();
  // The query cache stores adapted candles, as fetchChartCandles does.
  client.setQueryData(chartCandlesQueryKey("EURUSD", "M15", 200), {
    ...payload, candles: payload.candles.map((c) => ({ ...c, time: Date.parse(c.openTime) })),
  });
  client.setQueryData(selectedMarketQueryOptions(7, "EURUSD", "M15").queryKey,
    { ok: true, symbol: "EURUSD", timeframe: "M15", highlights: {}, explanation: {} });
  const { result } = renderHook(() => useSymbolTruth("EURUSD", "M15", { refetchInterval: 3_600_000 }), { wrapper });
  expect(result.current.verdict?.bestAction).toBe("BUY");
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(result.current.verdict?.bestAction).toBe("BUY");
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(result.current.scannerTruth?.actionable).toBe(true);
  expectExpiredAdviceKeepsCalendar(result.current);
  // The calendar state is not kept forever: past its bound the read is withdrawn
  // and event risk reads as not checked — never as loading.
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(result.current.snapshot).toBeNull();
  expect(result.current.news).toBeNull();
  expect(result.current.newsState).toBe("unavailable");
  expect(requests.filter((r) => r.url.includes("/market/truth/"))).toHaveLength(0);
});

function expectExpiredAdviceKeepsCalendar(current: ReturnType<typeof useSymbolTruth>) {
  expect(current.verdict?.bestAction).toBe("WATCH_ONLY");
  expect(current.actionCapped).toBe(true);
  expect(current.levels?.withheld).toBe(true);
  expect(current.news).toEqual(snapshot().news);
  expect(current.newsState).toBe("available");
  expect(current.data?.lastCandleAt).toBe(CLOSE);
}


function seedDeadlineSnapshot(validUntil: string) {
  const value = { ...snapshot(), timeframe: "M15", validUntil };
  client.setQueryData([...getGetMeMarketTruthQueryKey("EURUSD", { tf: "M15" }), { userId: 7 }], value);
  const payload = candlePayload();
  client.setQueryData(chartCandlesQueryKey("EURUSD", "M15", 200), { ...payload, candles: payload.candles.map(c => ({ ...c, time: Date.parse(c.openTime) })) });
  client.setQueryData(selectedMarketQueryOptions(7, "EURUSD", "M15").queryKey, { ok: true, symbol: "EURUSD", timeframe: "M15", highlights: {}, explanation: {} });
}

it("expires at the earlier server deadline without a network poll or a busy timer", async () => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  seedDeadlineSnapshot(new Date(NOW + 2000).toISOString());
  const { result } = renderHook(() => useSymbolTruth("EURUSD", "M15", { refetchInterval: 3_600_000 }), { wrapper });
  expect(result.current.verdict?.bestAction).toBe("BUY");
  await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
  expect(result.current.verdict?.bestAction).toBe("BUY");
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expectExpiredAdviceKeepsCalendar(result.current);
  expect(result.current.scannerTruth?.actionable).toBe(true);
  expect(requests).toHaveLength(0);
});

it("focus rechecks a server deadline after the browser clock jumps forward", async () => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  seedDeadlineSnapshot(new Date(NOW + 2000).toISOString());
  const { result } = renderHook(() => useSymbolTruth("EURUSD", "M15", { refetchInterval: 3_600_000 }), { wrapper });
  expect(result.current.verdict?.bestAction).toBe("BUY");
  act(() => { vi.setSystemTime(NOW + 3000); window.dispatchEvent(new Event("focus")); });
  expectExpiredAdviceKeepsCalendar(result.current);
  expect(requests).toHaveLength(0);
});
