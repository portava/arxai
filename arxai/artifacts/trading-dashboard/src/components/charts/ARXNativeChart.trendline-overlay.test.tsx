// ARX Native Chart structural trendline overlay — render-proof acceptance test
// (Task #669).
//
// WHAT THIS LOCKS
//   The backend that DECIDES which trendlines to draw (the Chart Intelligence
//   `trendlineOverlay` verdict) is already covered by api-server unit tests. The
//   surface this test pins is the on-screen DRAWING path that lives only in the
//   React component: the structural-overlay effect in ARXNativeChart that turns
//   `intelligenceState.trendlineOverlay` into `adapter.setStructureLines(...)`.
//
//   A regression there could draw stale or duplicate trendlines on a non-live
//   feed, or fail to clear them when the user switches symbols — silently
//   undermining the chart-honesty rules. This test proves the FRONTEND re-gates:
//     1. lines render ONLY when overlay.visible AND the feed-confidence verdict
//        (aiUsable) AND the live-price affordance are all true,
//     2. lines are CLEARED (setStructureLines([], [])) when any gate is false,
//     3. lines are CLEARED across a symbol switch (the old engine is destroyed
//        and structure for instrument A never bleeds onto instrument B).
//
// WHY A jsdom RENDER TEST (not Playwright against the running app)
//   The chart sits behind the app's session wall (the headless browser cannot
//   inject the arx_user_session cookie) and a "live" feed requires a real
//   mt5_broker tick stream that CI cannot guarantee, so a live browser run would
//   be flaky and prove nothing repeatable. Instead we render the REAL
//   ARXNativeChart and drive its REAL structural-overlay effect with a fixture
//   intelligence state + feed status, following the existing render-proof
//   pattern in this repo (ARXNativeChart.tick-stream.test.tsx). Only the network
//   data hooks and the imperative chart engine are stubbed — there is NO
//   QueryClientProvider; every data hook is mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type {
  ChartCandle,
  ChartCandlesResponse,
  ChartFeedStatus,
  ChartIntelligenceResponse,
  ChartTrendlineOverlay,
} from "@workspace/api-client-react";

// ── Controllable data the mocked hooks read on each render ───────────────────
let currentCandleResponse: ChartCandlesResponse | undefined;
let currentIntelligence: ChartIntelligenceResponse | undefined;

// ── Spy chart-engine adapter ────────────────────────────────────────────────
// The structural-overlay effect early-returns unless `setStructureLines` exists,
// so the spy MUST expose it. All methods are no-op spies; the real adapter's
// draw behavior is covered by the engine's own unit tests + typecheck.
const adapterSpies = {
  init: vi.fn(),
  destroy: vi.fn(),
  setSymbol: vi.fn(),
  setTimeframe: vi.fn(),
  setFeedState: vi.fn(),
  setCandles: vi.fn(),
  updateActiveCandle: vi.fn(),
  setOverlays: vi.fn(),
  setStructureLines: vi.fn(),
  resetScale: vi.fn(),
  setReachStartHandler: vi.fn(),
  priceToCoordinate: vi.fn(() => null),
};

vi.mock("@/lib/chart-engine", () => ({
  createChartEngineAdapter: () => adapterSpies,
}));

// Deep-history scroll-back is irrelevant here — inert, empty hook.
vi.mock("@/lib/useChartDeepHistory", () => ({
  useChartDeepHistory: () => ({
    olderCandles: [],
    loading: false,
    hasMore: false,
    providerCapped: false,
    limitationReason: null,
    coverageDays: 0,
    depthTargetDays: 0,
    loadedAny: false,
    loadOlder: vi.fn(),
    reset: vi.fn(),
  }),
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetChartCandles: () => ({
    data: currentCandleResponse,
    isLoading: false,
    isError: false,
    isFetching: false,
  }),
  getGetChartCandlesQueryKey: () => ["chart-candles"],
  // The structural-overlay effect reads `intelligenceQuery.data?.state` — this
  // is the verdict source under test.
  useGetMeChartIntelligence: () => ({ data: currentIntelligence, error: null }),
  getGetMeChartIntelligenceQueryKey: () => ["chart-intelligence"],
  GetChartCandlesTimeframe: {
    M1: "M1",
    M5: "M5",
    M15: "M15",
    M30: "M30",
    H1: "H1",
    H4: "H4",
    D1: "D1",
  },
}));

// useScannerTruth needs react-query this hermetic render does not set up; the
// badge it feeds is suppressed (showFeedStatus={false}). Stub it inert.
vi.mock("@/hooks/useScannerTruth", () => ({
  useScannerTruth: () => ({
    truth: null,
    feedStatus: null,
    isLoading: false,
    isError: false,
    refetch: () => {},
  }),
}));

// Import AFTER the mocks are registered.
import { ARXNativeChart } from "./ARXNativeChart";

// ── Fixtures ────────────────────────────────────────────────────────────────
const TF = "M15";
const NEWEST_OPEN_MS = 1_700_000_000_000;
const M15_MS = 15 * 60_000;

function makeCandle(symbol: string, openMs: number, close: number): ChartCandle {
  return {
    symbol,
    displaySymbol: symbol,
    timeframe: TF,
    openTime: new Date(openMs).toISOString(),
    closeTime: new Date(openMs + M15_MS).toISOString(),
    open: close - 0.001,
    high: close + 0.001,
    low: close - 0.002,
    close,
    volume: 100,
    tickVolume: 100,
    source: "mt5_broker",
    isComplete: true,
    isForming: false,
    sourceMode: "live",
    priceBasis: "BID",
    isFinal: true,
    receivedAt: new Date(openMs + M15_MS).toISOString(),
    qualityFlags: [],
  } as unknown as ChartCandle;
}

// A clean + live feed → resolveDisplayStatus === "LIVE" → live-price affordance
// ON and feedConfidence.aiUsable === true. Both structural-overlay gates pass.
function liveFeedStatus(symbol: string): ChartFeedStatus {
  return {
    symbol,
    displaySymbol: symbol,
    assetClass: "forex",
    source: "mt5_broker",
    isLive: true,
    lastTickTime: new Date(NEWEST_OPEN_MS).toISOString(),
    lastCandleTime: new Date(NEWEST_OPEN_MS).toISOString(),
    latencyMs: 50,
    missingCandleCount: 0,
    duplicateCount: 0,
    outOfOrderCount: 0,
    invalidOhlcCount: 0,
    stale: false,
    quality: "clean",
    warning: null,
    aiUsable: true,
    message: "live",
  } as unknown as ChartFeedStatus;
}

// A stale feed → resolveDisplayStatus === "STALE" → live-price affordance OFF
// AND feedConfidence.aiUsable === false. Both gates fail.
function staleFeedStatus(symbol: string): ChartFeedStatus {
  return {
    ...liveFeedStatus(symbol),
    isLive: false,
    stale: true,
    quality: "stale",
    aiUsable: false,
    message: "stale",
  } as unknown as ChartFeedStatus;
}

// Adversarial isolation feed: aiUsable forced true but quality "delayed", so
// resolveDisplayStatus === "FALLBACK_COMPOSITE" (NOT live). This proves the
// FRONTEND re-gates on the live-price affordance INDEPENDENTLY of aiUsable — a
// delayed/composite feed can never show structure even if aiUsable is set.
function delayedButAiUsableFeedStatus(symbol: string): ChartFeedStatus {
  return {
    ...liveFeedStatus(symbol),
    isLive: false,
    stale: false,
    quality: "delayed",
    aiUsable: true,
    message: "delayed",
  } as unknown as ChartFeedStatus;
}

function makeResponse(symbol: string, feedStatus: ChartFeedStatus): ChartCandlesResponse {
  const candles = [
    makeCandle(symbol, NEWEST_OPEN_MS - 2 * M15_MS, 1.1),
    makeCandle(symbol, NEWEST_OPEN_MS - M15_MS, 1.101),
    makeCandle(symbol, NEWEST_OPEN_MS, 1.102),
  ];
  return { candles, feedStatus, warning: null } as unknown as ChartCandlesResponse;
}

// A trendline overlay carrying ONE detected dominant line + ONE break marker.
// `visible` is the backend's own fail-closed verdict; the frontend re-gates on
// top of it.
function makeOverlay(visible: boolean): ChartTrendlineOverlay {
  return {
    visible,
    contextOnly: !visible,
    insufficient: false,
    status: "confirmed",
    bias: "bullish",
    lines: [
      {
        id: "tl-1",
        name: "Rising support",
        category: "support",
        bias: "bullish",
        status: "confirmed",
        dominant: true,
        start: { time: Math.floor((NEWEST_OPEN_MS - 2 * M15_MS) / 1000), price: 1.099 },
        end: { time: Math.floor(NEWEST_OPEN_MS / 1000), price: 1.102 },
      },
    ],
    markers: [
      {
        time: Math.floor((NEWEST_OPEN_MS - M15_MS) / 1000),
        price: 1.101,
        kind: "break",
        bias: "bullish",
        label: "Break",
      },
    ],
    note: null,
  } as unknown as ChartTrendlineOverlay;
}

// The structural-overlay effect only reads `state.trendlineOverlay`; everything
// else on the intelligence state is irrelevant to the draw path, so a minimal
// partial state is sufficient and honest for this render proof.
function intelligenceWith(overlay: ChartTrendlineOverlay): ChartIntelligenceResponse {
  return { state: { trendlineOverlay: overlay } } as unknown as ChartIntelligenceResponse;
}

// Stable empty overlays reference — an inline `[]` default is a fresh array each
// render and would spin the P/L-bubble effect into an infinite render loop.
const NO_OVERLAYS: never[] = [];

function renderChart(symbol: string) {
  return render(
    <ARXNativeChart
      symbol={symbol}
      timeframe={TF}
      showFeedStatus={false}
      overlays={NO_OVERLAYS}
      // Triggers the intelligence query path; the hook itself is mocked, but the
      // component enables the query only when this callback is present.
      onIntelligenceChange={() => {}}
    />,
  );
}

// Helper: the most-recent setStructureLines call's [lines, markers] args.
function lastStructureCall(): { lines: unknown[]; markers: unknown[] } | null {
  const calls = adapterSpies.setStructureLines.mock.calls;
  if (calls.length === 0) return null;
  const [lines, markers] = calls[calls.length - 1]! as [unknown[], unknown[]];
  return { lines, markers };
}

beforeEach(() => {
  for (const fn of Object.values(adapterSpies)) (fn as ReturnType<typeof vi.fn>).mockClear();
  adapterSpies.priceToCoordinate.mockReturnValue(null);
  // EventSource is opened by the unrelated tick-stream wiring; stub it so the
  // structural-overlay path under test renders without a real network stream.
  (globalThis as unknown as { EventSource: unknown }).EventSource = class {
    onmessage: unknown = null;
    onerror: unknown = null;
    close() {}
  };
  currentCandleResponse = makeResponse("EURUSD", liveFeedStatus("EURUSD"));
  currentIntelligence = intelligenceWith(makeOverlay(true));
});

afterEach(() => {
  cleanup();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

describe("ARXNativeChart structural trendline overlay drawing (Task #669)", () => {
  it("DRAWS trendlines when overlay.visible AND feed confidence (aiUsable + live price) are all true", () => {
    renderChart("EURUSD");

    const last = lastStructureCall();
    expect(last).not.toBeNull();
    // A real line + marker were pushed to the engine.
    expect(last!.lines.length).toBe(1);
    expect(last!.markers.length).toBe(1);
    // The drawn line keeps the backend's real time/price anchors (no fabrication).
    const line = last!.lines[0] as { id: string; start: { price: number }; end: { price: number } };
    expect(line.id).toBe("tl-1");
    expect(line.start.price).toBe(1.099);
    expect(line.end.price).toBe(1.102);
  });

  it("CLEARS the structure when overlay.visible is false (backend fold), even on a live feed", () => {
    currentIntelligence = intelligenceWith(makeOverlay(false));
    renderChart("EURUSD");

    const last = lastStructureCall();
    expect(last).not.toBeNull();
    expect(last!.lines).toEqual([]);
    expect(last!.markers).toEqual([]);
  });

  it("CLEARS the structure on a non-live (stale) feed even when overlay.visible is true", () => {
    currentCandleResponse = makeResponse("EURUSD", staleFeedStatus("EURUSD"));
    currentIntelligence = intelligenceWith(makeOverlay(true));
    renderChart("EURUSD");

    const last = lastStructureCall();
    expect(last).not.toBeNull();
    expect(last!.lines).toEqual([]);
    expect(last!.markers).toEqual([]);
  });

  it("re-gates on the live-price affordance INDEPENDENTLY of aiUsable — a delayed/composite feed never shows structure", () => {
    // Adversarial: aiUsable forced true but the feed resolves NOT-LIVE (delayed).
    currentCandleResponse = makeResponse("EURUSD", delayedButAiUsableFeedStatus("EURUSD"));
    currentIntelligence = intelligenceWith(makeOverlay(true));
    renderChart("EURUSD");

    const last = lastStructureCall();
    expect(last).not.toBeNull();
    expect(last!.lines).toEqual([]);
    expect(last!.markers).toEqual([]);
  });

  it("CLEARS the structure when the overlay hides after being drawn (live update)", () => {
    const view = renderChart("EURUSD");
    // Baseline: lines were drawn.
    expect(lastStructureCall()!.lines.length).toBe(1);

    // The next intelligence poll folds the overlay closed.
    adapterSpies.setStructureLines.mockClear();
    currentIntelligence = intelligenceWith(makeOverlay(false));
    view.rerender(
      <ARXNativeChart
        symbol="EURUSD"
        timeframe={TF}
        showFeedStatus={false}
        overlays={NO_OVERLAYS}
        onIntelligenceChange={() => {}}
      />,
    );

    const last = lastStructureCall();
    expect(last).not.toBeNull();
    expect(last!.lines).toEqual([]);
    expect(last!.markers).toEqual([]);
  });

  it("CLEARS the structure across a symbol switch — instrument A's lines never bleed onto B", () => {
    const view = renderChart("EURUSD");
    // Baseline: EURUSD drew structure.
    expect(lastStructureCall()!.lines.length).toBe(1);
    const destroysBefore = adapterSpies.destroy.mock.calls.length;

    // Switch to GBPUSD. The new symbol's feed is not yet live-confirmed (e.g.
    // still warming up), so its overlay must NOT draw — proving EURUSD's lines
    // are gone, not carried over.
    adapterSpies.setStructureLines.mockClear();
    currentCandleResponse = makeResponse("GBPUSD", staleFeedStatus("GBPUSD"));
    currentIntelligence = intelligenceWith(makeOverlay(true));
    view.rerender(
      <ARXNativeChart
        symbol="GBPUSD"
        timeframe={TF}
        showFeedStatus={false}
        overlays={NO_OVERLAYS}
        onIntelligenceChange={() => {}}
      />,
    );

    // The engine was rebuilt for the new instrument (old engine destroyed).
    expect(adapterSpies.destroy.mock.calls.length).toBeGreaterThan(destroysBefore);
    // And no structure is drawn for the new, non-live symbol.
    const last = lastStructureCall();
    expect(last).not.toBeNull();
    expect(last!.lines).toEqual([]);
    expect(last!.markers).toEqual([]);
  });
});
