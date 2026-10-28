import { useLayoutEffect } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  timeframe: "8h", candles: null as any, intelligence: null as any,
  intelligenceHook: vi.fn(), layersHook: vi.fn(), applyStructure: vi.fn(),
  surface: { chart: {}, series: { createPriceLine: vi.fn(), removePriceLine: vi.fn() }, container: null as HTMLElement | null },
}));
vi.mock("@/lib/use-chart-symbol", () => ({ useChartSymbol: () => ["EURUSD", vi.fn()], bareSymbol: (value: string) => value }));
vi.mock("@/hooks/useScannerTimeframe", () => ({ useScannerTimeframe: () => [h.timeframe, vi.fn()] }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@/hooks/useScannerTruth", () => ({ useScannerTruth: () => ({ truth: null }) }));
vi.mock("@/hooks/useSymbolTruth", () => ({ useSymbolTruth: () => ({ news: null, verdict: null }) }));
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => ({ isPaper: true, canManualTrade: false, isFrozen: true }) }));
vi.mock("@/hooks/useProductRole", () => ({ useProductRole: () => ({ isInvestor: true }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("./selectedActionStore", () => ({ useSelectedActionStore: () => ({ get: () => null }) }));
vi.mock("./rubyReadStore", () => ({ useRubyReadStore: () => ({ get: () => null }) }));
vi.mock("./RubyChartRead", () => ({ RubyChartRead: () => null }));
vi.mock("@/components/mt5/OneClickArmedBadge", () => ({ OneClickArmedBadge: () => null }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: any) => ({ data: queryKey[0] === "chart-candles" ? h.candles : undefined, refetch: vi.fn(), isError: false, isLoading: false, isFetching: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@workspace/api-client-react", async importOriginal => ({
  ...await importOriginal<any>(),
  useGetMeChartIntelligence: (params: any, options: any) => { h.intelligenceHook(params, options); return { data: h.intelligence }; },
  useGetMeChartSmartLayers: (params: any, options: any) => { h.layersHook(params, options); return { data: undefined }; },
  useGetMeChartAnnotations: () => ({ data: { annotations: [] } }),
  usePostMeChartAnnotation: () => ({ mutate: vi.fn() }),
  useDeleteMeChartAnnotation: () => ({ mutate: vi.fn() }),
  usePostMeChartAiAlertsScan: () => ({ mutate: vi.fn() }),
  useGetAlertPreferences: () => ({ data: undefined }),
  useGetMeTradeHealth: () => ({ data: undefined }),
  useGetTimingBrain: () => ({ data: undefined }),
}));
vi.mock("@/lib/chart-engine/structureLines", () => ({
  EMPTY_STRUCTURE_HANDLES: { series: [], markersApi: null },
  clearStructureLines: vi.fn(),
  applyStructureLines: (...args: any[]) => { h.applyStructure(...args); return { series: [], markersApi: null }; },
}));
vi.mock("@/components/charts/ARXNativeChart", () => ({
  ARXNativeChart: ({ onScannerSurfaceChange, timeframe }: any) => {
    useLayoutEffect(() => { onScannerSurfaceChange(h.surface); return () => onScannerSurfaceChange(null); }, [onScannerSurfaceChange]);
    return <div data-testid="native-chart">{timeframe}</div>;
  },
}));

import { ScannerChartPanel } from "./ScannerChartPanel";
function fixture(timeframe: string, identity = "source-A") {
  const source = "mt5_broker", symbol = "EURUSD";
  const feedStatus = { source, quality: "clean", isLive: true, stale: false, aiUsable: true };
  const bar = { symbol, timeframe, source, openTime: "2026-01-01T00:00:00Z", open: 1, high: 2, low: 0.5, close: 1.5 };
  const marketEvidence = { symbol, timeframe, source, sourceIdentity: identity, lastClosedCandleAt: null };
  h.candles = { candles: [{ ...bar, time: Date.parse(bar.openTime) }], feedStatus, marketEvidence,
    originalResponse: { symbol, timeframe, candles: [bar], feedStatus, marketEvidence, quality: "clean", aiUsable: true } };
  h.intelligence = { marketEvidence, state: { symbol, timeframe, trendlineOverlay: { visible: true,
    lines: [{ id: "trend", bias: "bullish", start: { time: 1, price: 1 }, end: { time: 2, price: 2 } }], markers: [] } } };
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); h.timeframe = "8h"; h.surface.container = document.createElement("div"); fixture("H8");
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ live: [], demo: [], drafts: [] }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("requests and renders exact H8 intelligence while the seven-interval smart-layer service remains disabled", async () => {
  render(<ScannerChartPanel />);
  await waitFor(() => expect(h.applyStructure).toHaveBeenCalled());
  expect(h.intelligenceHook.mock.calls.at(-1)?.[0]).toMatchObject({ symbol: "EURUSD", timeframe: "H8" });
  expect(h.intelligenceHook.mock.calls.at(-1)?.[1].query.enabled).toBe(true);
  expect(h.layersHook.mock.calls.at(-1)?.[1].query.enabled).toBe(false);
  expect(h.applyStructure.mock.calls.at(-1)?.[2]).toEqual([expect.objectContaining({ id: "trend" })]);
  expect(screen.getByTestId("scanner-overlay-interval-unavailable").textContent).toContain("Smart layers, saved notes and receipts");
});

it("retains the source-change evidence hold before H8 structure can return", async () => {
  const view = render(<ScannerChartPanel />);
  await waitFor(() => expect(h.applyStructure).toHaveBeenCalled());
  const old = h.intelligence;
  fixture("H8", "source-B"); h.intelligence = old; h.applyStructure.mockClear();
  view.rerender(<ScannerChartPanel />);
  expect(h.intelligenceHook.mock.calls.at(-1)?.[1].query.enabled).toBe(true);
  expect(h.applyStructure).not.toHaveBeenCalled();
  expect(screen.getByTestId("scanner-overlay-source-pending")).toBeTruthy();
  h.intelligence = { ...old, marketEvidence: h.candles.marketEvidence };
  view.rerender(<ScannerChartPanel />);
  await waitFor(() => expect(h.applyStructure).toHaveBeenCalled());
});

it.each([["1w", "W1"], ["1mo", "MN1"]])("withholds cached calendar intelligence on %s", async (display, api) => {
  h.timeframe = display; fixture(api);
  render(<ScannerChartPanel />);
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(h.intelligenceHook.mock.calls.at(-1)?.[0].timeframe).toBe(api);
  expect(h.intelligenceHook.mock.calls.at(-1)?.[1].query.enabled).toBe(false);
  expect(h.layersHook.mock.calls.at(-1)?.[1].query.enabled).toBe(false);
  expect(h.applyStructure).not.toHaveBeenCalled();
  expect(screen.getByTestId("native-chart").textContent).toBe(api);
});

it.each([{ symbol: "GBPUSD" }, { timeframe: "H4" }])("withholds a foreign intelligence state %j despite the requested query key", async foreign => {
  h.intelligence.state = { ...h.intelligence.state, ...foreign };
  render(<ScannerChartPanel />);
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(h.intelligenceHook.mock.calls.at(-1)?.[1].query.enabled).toBe(true);
  expect(h.applyStructure).not.toHaveBeenCalled();
});
