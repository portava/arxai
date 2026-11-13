import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useScannerTruth } from "./useScannerTruth";
import { sharedChartResponse } from "@/lib/chart-engine/sharedChartResponse";
import { captureSmartChartBars } from "@/lib/chart-engine/smartChartCapture";
import { selectSmartChartWindow } from "@/lib/chart-engine/smartChartAnalysis";

vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => ({ isLoading: false, envelope: null }) }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Eleanor" }) }));
vi.mock("@/hooks/useSelectedMarketSnapshot", () => ({ useSelectedMarketSnapshot: () => ({ data: { ok: true }, isError: false }) }));

const NOW = Date.parse("2026-11-13T14:00:30Z");
let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function response() {
  const end = Math.floor(NOW / 60_000) * 60_000;
  return {
    symbol: "EURUSD", timeframe: "M1", source: "deriv_public", quality: "clean", aiUsable: true,
    feedStatus: { assetClass: "forex", symbol: "EURUSD", source: "deriv_public", quality: "clean", isLive: true, aiUsable: true, stale: false },
    marketEvidence: { symbol: "EURUSD", timeframe: "M1", source: "deriv_public", sourceIdentity: "a".repeat(64), lastClosedCandleAt: new Date(end).toISOString() },
    candles: Array.from({ length: 200 }, (_, i) => ({
      symbol: "EURUSD", timeframe: "M1", source: "deriv_public", sourceMode: "live", qualityFlags: [] as string[],
      openTime: new Date(end - (200 - i) * 60_000).toISOString(),
      closeTime: new Date(end - (199 - i) * 60_000).toISOString(),
      open: 1.1, high: 1.11, low: 1.09, close: 1.1,
      isComplete: true, isForming: false, isFinal: true,
      timeBasisEvidence: { kind: "original_utc", basis: "UTC", reason: null, authority: "deriv_public" },
    })),
  };
}

async function read(raw: ReturnType<typeof response>, now = NOW) {
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(raw))));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useScannerTruth("EURUSD", "M1", { refetchInterval: 3_600_000 }), { wrapper });
  await waitFor(() => expect(hook.result.current.truth).not.toBeNull());
  return hook.result;
}

it("uses confirmed original closed bars for the positive scanner read", async () => {
  const result = (await read(response())).current;
  expect(result.truth?.actionable).toBe(true);
  expect(result.lastClosedCandleAt).toBe("2026-11-13T14:00:00.000Z");
});

it.each(["symbol", "timeframe", "source"] as const)("does not affirm a response Smart Chart rejects for wrong %s", async (field) => {
  const raw = response();
  if (field === "source") raw.candles[0]!.source = "mt5_broker";
  else raw[field] = field === "symbol" ? "GBPUSD" : "M5";
  expect(sharedChartResponse(raw, "EURUSD", "M1")).toBeUndefined();
  expect((await read(raw)).current.truth?.actionable).toBe(false);
});

it("does not count provisional bars as closed evidence", async () => {
  const raw = response();
  raw.candles.forEach(c => { c.isFinal = false; });
  const result = (await read(raw)).current;
  expect(result.truth?.actionable).toBe(false);
  expect(result.lastClosedCandleAt).toBeNull();
});

it("does not count a future scheduled close as an observed closed bar", async () => {
  const raw = response();
  raw.candles.forEach(c => { c.closeTime = new Date(NOW + 60_000).toISOString(); });
  const result = (await read(raw)).current;
  expect(result.truth?.actionable).toBe(false);
  expect(result.lastClosedCandleAt).toBeNull();
});

it("does not use old display-only cached projections as confirmed original evidence", async () => {
  const result = await read(response());
  expect(result.current.truth?.actionable).toBe(true);
  await act(async () => client.setQueryData(["chart-candles", "EURUSD", "M1", 200], (old: Record<string, unknown>) => {
    const { originalResponse: _discarded, ...legacy } = old;
    return legacy;
  }));
  await waitFor(() => expect(result.current.truth?.actionable).toBe(false));
  expect(result.current.sourceIdentity).toBeNull();
});

it("requires the closed-bar floor after filtering provisional evidence", async () => {
  const raw = response();
  raw.candles.slice(149).forEach(c => { c.isFinal = false; });
  expect((await read(raw)).current.truth?.actionable).toBe(false);
});

it("keeps source-clock labels unqualified when UTC mapping is unavailable", async () => {
  const raw = response();
  raw.candles.forEach(c => { Reflect.deleteProperty(c, "timeBasisEvidence"); });
  const result = (await read(raw, Date.parse("2026-11-14T12:00:00Z"))).current;
  expect(result.truth?.actionable).toBe(false);
  expect(result.truth?.candles.reason).toContain("source clock (UTC unverified)");
});

it.each(["missing", "malformed"])("withholds a confirmed read when original source identity is %s", async mode => {
  const raw = response();
  if (mode === "missing") Reflect.deleteProperty(raw, "marketEvidence");
  else raw.marketEvidence.sourceIdentity = "unproven";
  expect((await read(raw)).current.truth?.actionable).toBe(false);
});

const mutations: Record<string, (raw: ReturnType<typeof response>) => void> = {
  "duplicate open": r => { r.candles[1] = { ...r.candles[0]! }; },
  "out of order": r => { [r.candles[1], r.candles[2]] = [r.candles[2]!, r.candles[1]!]; },
  "high below low": r => { r.candles[1]!.high = 1; },
  "close outside range": r => { r.candles[1]!.close = 5; },
  "nonpositive price": r => { r.candles[1]!.low = -1; },
  "simulation": r => { r.candles[1]!.sourceMode = "simulation"; },
  "mock flag": r => { r.candles[1]!.qualityFlags = ["MOCK_DATA"]; },
  "provisional middle bar": r => { r.candles[1]!.isFinal = false; },
  "wrong interval close": r => { r.candles[1]!.closeTime = new Date(Date.parse(r.candles[1]!.openTime) + 30_000).toISOString(); },
};
it.each(Object.keys(mutations))("agrees with the production Smart Chart window on %s", async name => {
  const raw = response(); mutations[name]!(raw);
  const capture = captureSmartChartBars(sharedChartResponse(raw, "EURUSD", "M1"), { symbol: "EURUSD", timeframe: "M1" }, [], null, NOW);
  const window = selectSmartChartWindow({ ...capture.context, bars: capture.bars, asOfMs: NOW });
  expect(capture.status === "unavailable" || window.status === "unavailable").toBe(true);
  expect((await read(raw)).current.truth?.actionable).toBe(false);
});

it("reads source/account identity and prices from the original response, not mutable adapter metadata", async () => {
  const result = await read(response());
  await act(async () => client.setQueryData(["chart-candles", "EURUSD", "M1", 200], (old: Record<string, unknown>) => ({
    ...old,
    marketEvidence: { ...response().marketEvidence, sourceIdentity: "b".repeat(64) },
    candles: [{ time: NOW, open: 99, high: 100, low: 98, close: 99 }],
  })));
  await waitFor(() => expect(client.getQueryData<{candles: unknown[]}>(["chart-candles", "EURUSD", "M1", 200])?.candles).toHaveLength(1));
  expect(result.current.sourceIdentity).toBe("a".repeat(64));
  expect(result.current.truth?.candles.lastClose).toBe(1.1);
  expect(result.current.truth?.actionable).toBe(true);
});
