import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { useScannerTruth } from "./useScannerTruth";
import { useScannerReadGate } from "./useScannerReadGate";
import { useEvidenceDeadline } from "./useEvidenceDeadline";
import { chartCandlesQueryKey } from "@/lib/chartCandlesQuery";

vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => ({ isLoading: false, envelope: null }) }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@/hooks/useSelectedMarketSnapshot", () => ({ useSelectedMarketSnapshot: () => ({ data: { ok: true }, isError: false }) }));
const NOW = Date.parse("2026-10-26T14:00:00Z");
let client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(["me"], { id: 7 });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected request"))));
});
afterEach(() => { cleanup(); client.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("expires stationary candle truth at its deadline without another render or request", async () => {
  const lastOpen = NOW - 89_000;
  client.setQueryData(chartCandlesQueryKey("EURUSD", "M1", 200), {
    sourceClockQualified: true, // Cached normalized-query clock evidence.
    candles: Array.from({ length: 200 }, (_, index) => ({ time: lastOpen - (199 - index) * 60_000, open: 1.1, high: 1.11, low: 1.09, close: 1.1 })),
    feedStatus: { symbol: "EURUSD", source: "mt5_broker", quality: "clean", isLive: true, aiUsable: true, stale: false },
  });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, unmount } = renderHook(() => useScannerTruth("EURUSD", "M1", { refetchInterval: 3_600_000 }), { wrapper });
  expect(result.current.truth?.actionable).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(result.current.truth?.actionable).toBe(true); // inclusive age budget
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(result.current.truth?.actionable).toBe(false);
  expect(result.current.truth?.candles.status).toBe("stale");
  expect(result.current.truth?.displayStatus).toBe("STALE");
  expect(fetch).not.toHaveBeenCalled();
  unmount(); expect(vi.getTimerCount()).toBe(0);
});

it("rechecks evidence after a suspended tab resumes even before throttled timers fire", () => {
  const { result } = renderHook(() => useEvidenceDeadline(NOW + 1_000));
  expect(result.current).toBe(NOW);
  vi.setSystemTime(NOW + 2_000); // advance wall time, not timer callbacks
  act(() => window.dispatchEvent(new Event("focus")));
  expect(result.current).toBe(NOW + 2_000);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps out-of-range timestamps unconfirmed without crashing the scanner", () => {
  client.setQueryData(chartCandlesQueryKey("EURUSD", "M1", 200), {
    sourceClockQualified: true, // Cached normalized-query clock evidence.
    candles: Array.from({ length: 200 }, () => ({ time: 1e20, open: 1.1, high: 1.11, low: 1.09, close: 1.1 })),
    feedStatus: { symbol: "EURUSD", source: "mt5_broker", quality: "clean", isLive: true, aiUsable: true, stale: false },
  });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useScannerTruth("EURUSD", "M1"), { wrapper });
  expect(result.current.truth?.actionable).toBe(false);
  expect(result.current.truth?.candles.lastTime).toBeNull();
});

it("withdraws live truth after a failed refresh while retaining the historical candle context", async () => {
  client.setQueryData(chartCandlesQueryKey("EURUSD", "M1", 200), {
    sourceClockQualified: true, // Cached normalized-query clock evidence.
    candles: Array.from({ length: 200 }, (_, index) => ({ time: NOW - (200 - index) * 60_000, open: 1.1, high: 1.11, low: 1.09, close: 1.1 })),
    feedStatus: { symbol: "EURUSD", source: "mt5_broker", quality: "clean", isLive: true, aiUsable: true, stale: false },
  });
  vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 503 }));
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => ({ ...useScannerTruth(" eurusd ", "M1"), gate: useScannerReadGate("EURUSD", "M1") }), { wrapper });
  expect(result.current.truth?.actionable).toBe(true);
  await act(async () => { result.current.refetch(); await vi.advanceTimersByTimeAsync(1); });
  expect(result.current.isError).toBe(true);
  expect(result.current.truth?.actionable).toBe(false);
  expect(result.current.truth?.isLivePrice).toBe(false);
  expect(result.current.gate.downgraded).toBe(true);
  expect(result.current.gate.isFull).toBe(false);
  expect(result.current.truth?.candles).toMatchObject({ count: 200, lastClose: 1.1, status: "historical_only" });
});

it("replaces and cleans up deadlines, including long timeframes without a fast timer loop", async () => {
  let renders = 0;
  const { rerender, unmount } = renderHook(({ deadline }) => { renders++; return useEvidenceDeadline(deadline); }, { initialProps: { deadline: NOW + 3_000_000_000 } });
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(renders).toBe(1);
  expect(vi.getTimerCount()).toBe(1);
  rerender({ deadline: NOW + 20_000 });
  expect(vi.getTimerCount()).toBe(1);
  unmount(); expect(vi.getTimerCount()).toBe(0);
});

it('does not promote recent green provider flags when the normalized candle clock is unqualified',()=>{
 client.setQueryData(chartCandlesQueryKey('V25_1S','M15',200),{
  sourceClockQualified:false,
  candles:Array.from({length:200},(_,index)=>({time:NOW-(200-index)*900000,open:940000,high:941000,low:939000,close:939791.4})),
  feedStatus:{symbol:'V25_1S',source:'deriv_public',quality:'clean',isLive:true,aiUsable:true,stale:false},
 });
 const wrapper=({children}:{children:ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>;
 const {result}=renderHook(()=>useScannerTruth('V25_1S','15m'),{wrapper});
 expect(result.current.truth?.candles.lastClose).toBe(939791.4);expect(result.current.truth?.isLivePrice).toBe(false);expect(result.current.truth?.candles.reason).toMatch(/UTC mapping unverified/);expect(result.current.truth?.consolidated.rubyReadStatus).not.toBe('FULL_READ');expect(result.current.truth?.readiness.dataFreshness).not.toBe('LIVE_CONFIRMED');
});
