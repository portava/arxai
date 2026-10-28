// Live Chart real-time ticking — client-wiring acceptance test (Task #508).
//
// WHAT THIS LOCKS
//   The server-side forming-bar / freshness logic is covered by the api-server
//   unit tests (formingBar.test.ts, formingTickStreamLatency.test.ts). The NEW
//   surface this test pins is the CLIENT wiring in ARXNativeChart: it subscribes
//   to GET /api/chart/tick-stream (SSE) and applies each forming-bar event
//   through the chart-engine adapter's updateActiveCandle() — NOT setCandles —
//   so the current candle ticks in real time WITHOUT a full repaint.
//
// WHY A jsdom RENDER TEST (not Playwright against the running app)
//   A real browser e2e is not viable in this environment: the Live Chart sits
//   behind the app's session wall (the headless browser cannot inject the
//   arx_user_session cookie), and — more fundamentally — a forming tip only
//   applies when the feed is genuinely LIVE, which requires an active mt5_broker
//   tick stream for the symbol under test. Neither can be guaranteed in CI, so a
//   live browser run would be flaky and would prove nothing repeatable.
//
//   Instead we render the REAL ARXNativeChart and drive the REAL es.onmessage
//   handler with events shaped EXACTLY like the server's chartTickStream.ts
//   emits. This is NOT a parallel path: it opens the same /api/chart/tick-stream
//   URL (asserted) and runs the component's own honesty gates (frozen,
//   out-of-order, live-price-affordance). Only the network transport
//   (EventSource), the candle data hook, and the imperative chart engine are
//   stubbed — everything CI cannot supply headlessly.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { ChartViewLink } from "@/lib/chart-engine/chartViewLink";
import { ChartLinkContext } from "./ChartLinkContext";
import type { ChartOverlay } from "@/lib/chart-overlays";
import type {
  ChartCandle,
  ChartCandlesResponse,
  ChartFeedStatus,
} from "@workspace/api-client-react";

// ── Controllable candle-query data ──────────────────────────────────────────
// The mocked useGetChartCandles reads this each render, so a test can simulate
// the 8s reconciliation poll by updating it and re-rendering.
let currentCandleResponse: ChartCandlesResponse | undefined;
let standaloneEnabled: boolean | undefined;
let cachedIntelligence: unknown;

// ── Spy chart-engine adapter ────────────────────────────────────────────────
// We assert against updateActiveCandle (the live tip) and setCandles (the full
// closed-window repaint). All methods are no-op spies; the real adapter's draw
// behavior is covered by the engine's own unit tests + typecheck.
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
  resize: vi.fn(),
  goToLatest: vi.fn(),
  fitHistory: vi.fn(),
  panBy: vi.fn(),
  zoomBy: vi.fn(),
  setViewLinkHandler: vi.fn(),
  setLinkedTimeRange: vi.fn(),
  setDrawings: vi.fn(),
  setDrawingHandler: vi.fn(),
  setDrawingInteraction: vi.fn(),
  setScaleMode: vi.fn(),
  setChartStyle: vi.fn(),
  getScannerOverlaySurface: vi.fn(() => null as unknown),
  setReachStartHandler: vi.fn(),
  priceToCoordinate: vi.fn(() => null),
};

vi.mock("@/lib/chart-engine", () => ({
  createChartEngineAdapter: () => adapterSpies,
}));

// Deep-history scroll-back is irrelevant here — return an inert, empty hook so
// the component renders without any /api/chart/history fetch.
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
  useGetChartCandles: (_params: unknown, options: {query: {enabled: boolean}}) => (standaloneEnabled = options.query.enabled, {
    data: currentCandleResponse,
    isLoading: false,
    isError: false,
    isFetching: false,
  }),
  getGetChartCandlesQueryKey: () => ["chart-candles"],
  useGetMeChartIntelligence: () => ({ data: cachedIntelligence, error: null }),
  getGetMeChartIntelligenceQueryKey: () => ["chart-intelligence"],
  GetChartCandlesTimeframe: { M1: "M1", M5: "M5", M15: "M15", M30: "M30", H1: "H1", H4: "H4", D1: "D1" },
}));

// useScannerTruth pulls in real @tanstack/react-query + useTradingMode queries
// that need a QueryClientProvider this hermetic render does not set up. The badge
// it feeds is suppressed here (showFeedStatus={false}), so stub it inert — the
// dedicated ChartFeedBadgeCap test covers the cap it applies.
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

// ── EventSource mock ────────────────────────────────────────────────────────
// Captures the URL the component opens and exposes a handle so a test can push
// SSE frames into the component's real es.onmessage handler.
interface OpenedStream {
  url: string;
  withCredentials: boolean;
  emit: (payload: unknown) => void;
  closed: boolean;
}
let openedStreams: OpenedStream[] = [];

class MockEventSource {
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly entry: OpenedStream;
  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.entry = {
      url,
      withCredentials: init?.withCredentials ?? false,
      closed: false,
      emit: (payload: unknown) => {
        this.onmessage?.({ data: JSON.stringify(payload) });
      },
    };
    openedStreams.push(this.entry);
  }
  close() {
    this.entry.closed = true;
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
const SYMBOL = "EURUSD";
const TF = "M5";
// A fixed M5 bucket so newestBarSec is deterministic across runs.
const NEWEST_OPEN_MS = 1_700_000_000_000; // arbitrary fixed epoch ms (M5-aligned enough for the test)
const NEWEST_OPEN_SEC = Math.floor(NEWEST_OPEN_MS / 1000);
const M5_MS = 5 * 60_000;

function makeCandle(openMs: number, close: number): ChartCandle {
  return {
    symbol: SYMBOL,
    displaySymbol: SYMBOL,
    timeframe: TF,
    openTime: new Date(openMs).toISOString(),
    closeTime: new Date(openMs + M5_MS).toISOString(),
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
    receivedAt: new Date(openMs + M5_MS).toISOString(),
    qualityFlags: [],
  } as unknown as ChartCandle;
}

// A clean + live feed → resolveDisplayStatus === "LIVE" → live-price affordance
// is ON, so the component is ALLOWED to apply forming tips.
function liveFeedStatus(): ChartFeedStatus {
  return {
    symbol: SYMBOL,
    displaySymbol: SYMBOL,
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

function makeResponse(feedStatus: ChartFeedStatus): ChartCandlesResponse {
  const candles = [
    makeCandle(NEWEST_OPEN_MS - 2 * M5_MS, 1.1),
    makeCandle(NEWEST_OPEN_MS - M5_MS, 1.101),
    makeCandle(NEWEST_OPEN_MS, 1.102),
  ];
  return { symbol:SYMBOL,timeframe:TF,candles:candles.map(c=>({...c,source:feedStatus.source})), feedStatus, warning: null } as unknown as ChartCandlesResponse;
}

// Exactly the wire shape chartTickStream.ts emits for an accepted tick.
function formingBarEvent(opts: {
  openTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  frozen?: boolean;
}) {
  return {
    type: "forming_bar",
    source: "mt5_broker",
    symbol: SYMBOL,
    timeframe: TF,
    bar: {
      openTimeMs: opts.openTimeMs,
      closeTimeMs: opts.openTimeMs + M5_MS,
      open: opts.open,
      high: opts.high,
      low: opts.low,
      close: opts.close,
      isForming: true,
    },
    tickAgeMs: 200,
    tickWallMs: Date.now(),
    frozen: opts.frozen ?? false,
    ts: Date.now(),
  };
}

// Exactly the wire shape chartTickStream.ts emits for the closed-market verdict.
// Display/telemetry only — it sets the "Market closed" badge and touches no tip,
// gate, or execution path.
function feedStatusEvent(opts: { marketFrozen: boolean; lastBrokerTimeMs: number | null }) {
  return {
    type: "feed_status",
    source: "mt5_broker",
    symbol: SYMBOL,
    timeframe: TF,
    marketFrozen: opts.marketFrozen,
    lastBrokerTimeMs: opts.lastBrokerTimeMs,
    brokerStaleMs: opts.marketFrozen ? 11 * 60_000 : 2_000,
    wallStaleMs: 3_000,
    ts: Date.now(),
  };
}

// A STABLE empty overlays reference. The component's P/L-bubble effect depends
// on `overlays`; an inline `[]` default would be a fresh array each render and
// spin the effect (it calls setBubbles) into an infinite render loop under test.
const NO_OVERLAYS: never[] = [];

function renderChart() {
  return render(
    <ARXNativeChart symbol={SYMBOL} timeframe={TF} showFeedStatus={false} overlays={NO_OVERLAYS} />,
  );
}

beforeEach(() => {
  localStorage.clear();
  cachedIntelligence = undefined;
  openedStreams = [];
  for (const fn of Object.values(adapterSpies)) (fn as ReturnType<typeof vi.fn>).mockClear();
  adapterSpies.priceToCoordinate.mockReturnValue(null);
  adapterSpies.getScannerOverlaySurface.mockReturnValue(null);
  adapterSpies.setChartStyle.mockImplementation(() => {});
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  currentCandleResponse = makeResponse(liveFeedStatus());
});

afterEach(() => {
  cleanup();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

describe("ARXNativeChart live tick-stream wiring (Task #508)", () => {
  it("subscribes to the same /api/chart/tick-stream SSE endpoint for the resolved symbol + timeframe", () => {
    renderChart();
    expect(openedStreams).toHaveLength(1);
    const { url, withCredentials } = openedStreams[0]!;
    expect(url).toContain("/api/chart/tick-stream");
    expect(url).toContain("source=mt5_broker");
    expect(url).toContain(`symbol=${SYMBOL}`);
    expect(url).toContain(`timeframe=${TF}`);
    // The component sends the session cookie with the stream.
    expect(withCredentials).toBe(true);
  });

  it("applies a live forming-bar tick through updateActiveCandle WITHOUT a full repaint", () => {
    renderChart();
    const stream = openedStreams[0]!;

    // Baseline: setCandles has already painted the closed window on mount.
    const repaintsBeforeTick = adapterSpies.setCandles.mock.calls.length;
    expect(adapterSpies.updateActiveCandle).not.toHaveBeenCalled();

    act(() => {
      stream.emit(
        formingBarEvent({
          openTimeMs: NEWEST_OPEN_MS,
          open: 1.102,
          high: 1.1035, // new high vs the closed bar
          low: 1.1018,
          close: 1.103,
        }),
      );
    });

    // The forming tip moved the active candle…
    expect(adapterSpies.updateActiveCandle).toHaveBeenCalledTimes(1);
    expect(adapterSpies.updateActiveCandle).toHaveBeenCalledWith({
      time: NEWEST_OPEN_SEC,
      open: 1.102,
      high: 1.1035,
      low: 1.1018,
      close: 1.103,
    });
    // …without re-running the full setCandles repaint (zoom/scroll preserved).
    expect(adapterSpies.setCandles.mock.calls.length).toBe(repaintsBeforeTick);
  });

  it("rejects a FROZEN tip — a stale stream never ticks a fake bar", () => {
    renderChart();
    const stream = openedStreams[0]!;

    act(() => {
      stream.emit(
        formingBarEvent({
          openTimeMs: NEWEST_OPEN_MS,
          open: 1.102,
          high: 1.104,
          low: 1.101,
          close: 1.1039,
          frozen: true,
        }),
      );
    });

    expect(adapterSpies.updateActiveCandle).not.toHaveBeenCalled();
  });

  it("rejects an OUT-OF-ORDER tip older than the newest bar", () => {
    renderChart();
    const stream = openedStreams[0]!;

    act(() => {
      stream.emit(
        formingBarEvent({
          openTimeMs: NEWEST_OPEN_MS - M5_MS, // one interval behind the newest bar
          open: 1.10,
          high: 1.105,
          low: 1.099,
          close: 1.104,
        }),
      );
    });

    expect(adapterSpies.updateActiveCandle).not.toHaveBeenCalled();
  });

  // Theme C3.3 — this test previously asserted the opposite: that a non-LIVE
  // closed-feed grade suppressed EVERY tip. That gate is what froze the chart.
  // `isLivePriceAffordance` is a verdict about the CLOSED-candle feed and it is
  // sticky, so a feed graded stale once (e.g. a Deriv-fed symbol whose closed
  // bars trail) killed every subsequent frame even while ticks flowed normally.
  //
  // The honest gate is the one each frame carries: `frozen`, computed
  // server-side from the REAL age of the tick behind it. It is stricter (true
  // the moment ticks actually stop) and current rather than sticky. The Scanner
  // has always gated this way; the two surfaces now agree.
  it("applies a FRESH tip even when the closed-feed grade is not LIVE (the frame's own marker rules)", () => {
    // Feed reports stale closed bars → live-price affordance OFF …
    currentCandleResponse = makeResponse({
      ...liveFeedStatus(),
      isLive: false,
      stale: true,
      quality: "stale",
      aiUsable: false,
      message: "stale",
    } as unknown as ChartFeedStatus);

    renderChart();
    const stream = openedStreams[0]!;

    act(() => {
      // … but THIS frame is not frozen: a real, recent tick is behind it.
      stream.emit(
        formingBarEvent({
          openTimeMs: NEWEST_OPEN_MS,
          open: 1.102,
          high: 1.104,
          low: 1.101,
          close: 1.1039,
        }),
      );
    });

    expect(adapterSpies.updateActiveCandle).toHaveBeenCalledTimes(1);
    expect(adapterSpies.updateActiveCandle).toHaveBeenCalledWith(
      expect.objectContaining({ time: NEWEST_OPEN_SEC, close: 1.1039 }),
    );
  });

  it("still rejects a FROZEN tip when the closed-feed grade is not LIVE (no fake motion)", () => {
    currentCandleResponse = makeResponse({
      ...liveFeedStatus(),
      isLive: false,
      stale: true,
      quality: "stale",
      aiUsable: false,
      message: "stale",
    } as unknown as ChartFeedStatus);

    renderChart();
    const stream = openedStreams[0]!;

    act(() => {
      stream.emit(
        formingBarEvent({
          openTimeMs: NEWEST_OPEN_MS,
          open: 1.102,
          high: 1.104,
          low: 1.101,
          close: 1.1039,
          frozen: true,
        }),
      );
    });

    expect(adapterSpies.updateActiveCandle).not.toHaveBeenCalled();
  });

  it("still suppresses the live-price affordance on a non-LIVE feed", () => {
    currentCandleResponse = makeResponse({
      ...liveFeedStatus(),
      isLive: false,
      stale: true,
      quality: "stale",
      aiUsable: false,
      message: "stale",
    } as unknown as ChartFeedStatus);

    renderChart();

    // The closed-feed grade still governs the last-price label / dashed "Last"
    // line — only the tick gate moved off it.
    expect(adapterSpies.setFeedState).toHaveBeenCalledWith({ livePriceAffordance: false, source: "mt5_broker" });
  });

  it("ignores malformed / wrong-type events without ticking the bar", () => {
    renderChart();
    const stream = openedStreams[0]!;

    act(() => {
      stream.emit({ type: "heartbeat", ts: Date.now() }); // keepalive, not a bar
      stream.emit({ type: "forming_bar" }); // missing bar
      stream.emit({ type: "forming_bar", bar: { openTimeMs: NEWEST_OPEN_MS } }); // missing OHLC
    });
    // The component also tolerates non-JSON frames.
    act(() => {
      stream.onmessage?.({ data: "not-json{" });
    });

    expect(adapterSpies.updateActiveCandle).not.toHaveBeenCalled();
  });

  it("an authoritative closed bar from the poll supersedes the tip cleanly (advances newest, later stale tip is rejected — no duplicate)", () => {
    const view = renderChart();
    const stream = openedStreams[0]!;

    // 1) A live tip for the current interval ticks the active candle.
    act(() => {
      stream.emit(
        formingBarEvent({
          openTimeMs: NEWEST_OPEN_MS + M5_MS, // the still-forming next interval
          open: 1.103,
          high: 1.1041,
          low: 1.1029,
          close: 1.104,
        }),
      );
    });
    expect(adapterSpies.updateActiveCandle).toHaveBeenCalledTimes(1);

    // 2) The 8s reconciliation poll now carries the CLOSED bar for that interval.
    const repaintsBefore = adapterSpies.setCandles.mock.calls.length;
    currentCandleResponse = {
      ...makeResponse(liveFeedStatus()),
      candles: [
        makeCandle(NEWEST_OPEN_MS - M5_MS, 1.101),
        makeCandle(NEWEST_OPEN_MS, 1.102),
        makeCandle(NEWEST_OPEN_MS + M5_MS, 1.104), // authoritative close of the tip's interval
      ],
    } as unknown as ChartCandlesResponse;
    act(() => {
      view.rerender(
        <ARXNativeChart symbol={SYMBOL} timeframe={TF} showFeedStatus={false} overlays={NO_OVERLAYS} />,
      );
    });
    // The poll repainted the full closed window (the closed bar replaces the tip).
    expect(adapterSpies.setCandles.mock.calls.length).toBeGreaterThan(repaintsBefore);

    // 3) A late tip for the now-CLOSED interval must be rejected as out-of-order
    //    — proving the closed bar wins and no stale duplicate keeps ticking.
    adapterSpies.updateActiveCandle.mockClear();
    act(() => {
      stream.emit(
        formingBarEvent({
          openTimeMs: NEWEST_OPEN_MS, // behind the new newest (NEWEST_OPEN_MS + M5_MS)
          open: 1.102,
          high: 1.1099,
          low: 1.10,
          close: 1.109,
        }),
      );
    });
    expect(adapterSpies.updateActiveCandle).not.toHaveBeenCalled();
  });

  it("closes the SSE stream on unmount (no leaked subscription)", () => {
    const view = renderChart();
    const stream = openedStreams[0]!;
    expect(stream.closed).toBe(false);
    act(() => {
      view.unmount();
    });
    expect(stream.closed).toBe(true);
  });
});

// Closed-market / frozen-quote badge — client wiring for the feed_status event.
// The server derives `marketFrozen` from real per-tick broker-time staleness
// (formingBar.test.ts section [E]); this locks that the component (1) surfaces
// the badge on a frozen verdict — even though it applies NO live tip then —, and
// (2) CLEARS it when the stream key changes, so a prior symbol's "Market closed"
// verdict can never linger on a freshly-selected symbol (architect fix).
describe("ARXNativeChart closed-market badge wiring", () => {
  const BADGE = '[data-testid="arx-native-market-closed"]';

  it("shows the closed-market badge on a frozen feed_status verdict (no tip applied)", () => {
    const view = renderChart();
    const stream = openedStreams[0]!;
    expect(view.container.querySelector(BADGE)).toBeNull();

    act(() => {
      stream.emit(feedStatusEvent({ marketFrozen: true, lastBrokerTimeMs: NEWEST_OPEN_MS }));
    });

    expect(view.container.querySelector(BADGE)).not.toBeNull();
    // A frozen verdict surfaces the badge WITHOUT ticking a synthesized bar.
    expect(adapterSpies.updateActiveCandle).not.toHaveBeenCalled();
  });

  it("clears the badge when a later verdict reports the market is no longer frozen", () => {
    const view = renderChart();
    const stream = openedStreams[0]!;
    act(() => {
      stream.emit(feedStatusEvent({ marketFrozen: true, lastBrokerTimeMs: NEWEST_OPEN_MS }));
    });
    expect(view.container.querySelector(BADGE)).not.toBeNull();

    act(() => {
      stream.emit(feedStatusEvent({ marketFrozen: false, lastBrokerTimeMs: NEWEST_OPEN_MS }));
    });
    expect(view.container.querySelector(BADGE)).toBeNull();
  });

  it("clears a stale closed-market badge when the symbol changes (no lingering verdict)", () => {
    const view = renderChart();
    const stream = openedStreams[0]!;
    act(() => {
      stream.emit(feedStatusEvent({ marketFrozen: true, lastBrokerTimeMs: NEWEST_OPEN_MS }));
    });
    expect(view.container.querySelector(BADGE)).not.toBeNull();

    // Switch to a different symbol: the effect re-runs, resets the badge, and
    // opens a fresh stream that has emitted no feed_status yet → badge gone.
    act(() => {
      currentCandleResponse={...currentCandleResponse!,symbol:"GBPUSD",candles:currentCandleResponse!.candles.map(c=>({...c,symbol:"GBPUSD"}))};
      view.rerender(
        <ARXNativeChart symbol="GBPUSD" timeframe={TF} showFeedStatus={false} overlays={NO_OVERLAYS} />,
      );
    });
    expect(view.container.querySelector(BADGE)).toBeNull();
    expect(openedStreams.length).toBeGreaterThan(1);
    expect(openedStreams[openedStreams.length - 1]!.url).toContain("symbol=GBPUSD");
  });
});


describe("Smart Chart view controls", () => {
  it("restores a linked peer range after each context reset without recreating the renderer",()=>{
    const link=new ChartViewLink();link.configure({crosshair:false,range:true});let publish:any;
    link.register("peer",{setViewLinkHandler:(fn:any)=>{publish=fn;}} as any);
    const range={from:NEWEST_OPEN_SEC-600,to:NEWEST_OPEN_SEC};publish({kind:"range",range});
    const tree=(symbol:string)=><ChartLinkContext.Provider value={link}><ARXNativeChart symbol={symbol} timeframe={TF} showFeedStatus={false} overlays={NO_OVERLAYS}/></ChartLinkContext.Provider>;
    const view=render(tree(SYMBOL));expect(adapterSpies.setLinkedTimeRange).toHaveBeenLastCalledWith(range);
    const clearIndex=adapterSpies.setCandles.mock.calls.length;
    currentCandleResponse={...currentCandleResponse!,symbol:"GBPUSD",candles:currentCandleResponse!.candles.map(c=>({...c,symbol:"GBPUSD"}))};
    view.rerender(tree("GBPUSD"));expect(adapterSpies.setLinkedTimeRange).toHaveBeenCalledTimes(2);
    const clear=adapterSpies.setCandles.mock.calls.findIndex((args,index)=>index>=clearIndex&&args[0].length===0);
    expect(adapterSpies.setLinkedTimeRange.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(adapterSpies.setCandles.mock.invocationCallOrder[clear]!);
    expect(adapterSpies.init).toHaveBeenCalledOnce();
  });
  it("does not reapply another instrument or explicit timeframe's overlays",()=>{
    const rows=[{id:"same",symbol:SYMBOL},{id:"different-symbol",symbol:"GBPUSD"},{id:"different-tf",symbol:SYMBOL,timeframe:"H1"}].map(o=>({...o,type:"line",source:"position",price:1.1,label:o.id})) as ChartOverlay[];
    const view=render(<ARXNativeChart symbol={SYMBOL} timeframe={TF} showFeedStatus={false} overlays={rows}/>);
    expect(adapterSpies.setOverlays.mock.lastCall?.[0].map((o:ChartOverlay)=>o.id)).toEqual(["same"]);
    currentCandleResponse={...currentCandleResponse!,symbol:"GBPUSD",candles:currentCandleResponse!.candles.map(c=>({...c,symbol:"GBPUSD"}))};
    view.rerender(<ARXNativeChart symbol="GBPUSD" timeframe={TF} showFeedStatus={false} overlays={rows}/>);
    expect(adapterSpies.setOverlays.mock.lastCall?.[0].map((o:ChartOverlay)=>o.id)).toEqual(["different-symbol"]);
  });
  it("reports timeframe selection in the click turn without a debounce timer",()=>{
    const changed=vi.fn();
    const view=render(<ARXNativeChart symbol={SYMBOL} timeframe={TF} onTimeframeChange={changed} showFeedStatus={false} overlays={NO_OVERLAYS}/>);
    fireEvent.click(view.getByTestId("arx-native-tf-M15"));
    expect(changed).toHaveBeenLastCalledWith("M15");
    fireEvent.click(view.getByTestId("arx-native-tf-H1"));
    expect(changed.mock.calls).toEqual([["M15"],["H1"]]);
    expect(adapterSpies.init).toHaveBeenCalledOnce();
  });
  it("updates an uncontrolled selection immediately while retaining the chart instance",()=>{
    const view=render(<ARXNativeChart symbol={SYMBOL} showFeedStatus={false} overlays={NO_OVERLAYS}/>);
    fireEvent.click(view.getByTestId("arx-native-tf-M15"));
    expect(view.getByTestId("arx-native-tf-M15").getAttribute("aria-pressed")).toBe("true");
    expect(adapterSpies.setTimeframe).toHaveBeenLastCalledWith("M15");
    fireEvent.click(view.getByTestId("arx-native-tf-H1"));
    expect(view.getByTestId("arx-native-tf-H1").getAttribute("aria-pressed")).toBe("true");
    expect(adapterSpies.init).toHaveBeenCalledOnce();
  });
  it("renders safely without an overlays prop", () => {
    render(<ARXNativeChart symbol={SYMBOL} timeframe={TF} showFeedStatus={false} />);
    expect(adapterSpies.init).toHaveBeenCalledTimes(1);
    expect(adapterSpies.setCandles.mock.calls.length).toBeLessThan(4);
  });
  it("changes viewport and scale without restarting the renderer or stream", () => {
    const view = renderChart();
    fireEvent.click(view.getByRole("button", {name:"Latest",exact:true}));
    fireEvent.click(view.getByRole("button", {name:"Fit history",exact:true}));
    fireEvent.change(view.getByLabelText("Price scale"), {target:{value:"log"}});
    expect(adapterSpies.goToLatest).toHaveBeenCalledOnce();
    expect(adapterSpies.fitHistory).toHaveBeenCalledOnce();
    expect(adapterSpies.setScaleMode).toHaveBeenLastCalledWith("log");
    fireEvent.click(view.getByRole("button", {name:"Fullscreen",exact:true}));
    expect(view.getByRole("button", {name:"Exit fullscreen",exact:true})).toBeTruthy();
    fireEvent.keyDown(window,{key:"Escape"});
    expect(view.getByRole("button", {name:"Fullscreen",exact:true})).toBeTruthy();
    expect(adapterSpies.init).toHaveBeenCalledTimes(1);
    expect(openedStreams).toHaveLength(1);
  });
  it("closes the templates dialog before exiting fullscreen on Escape", async () => {
    const view = renderChart();
    fireEvent.click(view.getByRole("button", {name:"Fullscreen",exact:true}));
    fireEvent.click(view.getByRole("button", {name:"Templates",exact:true}));
    const dialog = view.getByRole("dialog", {name:"Chart templates"});
    fireEvent.keyDown(dialog, {key:"Escape"});
    await waitFor(() => expect(view.queryByRole("dialog", {name:"Chart templates"})).toBeNull());
    expect(view.getByRole("button", {name:"Exit fullscreen",exact:true})).toBeTruthy();
    fireEvent.keyDown(window, {key:"Escape"});
    expect(view.getByRole("button", {name:"Fullscreen",exact:true})).toBeTruthy();
    expect(adapterSpies.init).toHaveBeenCalledTimes(1);
  });
  it("supports Home and End only inside the focused chart", () => {
    const view = renderChart();
    const chart=view.getByTestId("arx-native-canvas");
    fireEvent.keyDown(chart,{key:"Home"});
    fireEvent.keyDown(chart,{key:"End"});
    expect(adapterSpies.fitHistory).toHaveBeenCalledOnce();
    expect(adapterSpies.goToLatest).toHaveBeenCalledOnce();
  });
  it("pans/zooms on focused chart keys without intercepting modified or child input keys",()=>{
    const view=renderChart(),chart=view.getByTestId("arx-native-canvas");
    for(const key of ["ArrowLeft","ArrowRight","+","-"])fireEvent.keyDown(chart,{key});
    expect(adapterSpies.panBy.mock.calls).toEqual([[-0.25],[0.25]]);expect(adapterSpies.zoomBy.mock.calls).toEqual([[0.75],[4/3]]);
    fireEvent.keyDown(chart,{key:"+",ctrlKey:true});const input=document.createElement("input");chart.append(input);fireEvent.keyDown(input,{key:"ArrowLeft"});
    expect(adapterSpies.panBy).toHaveBeenCalledTimes(2);expect(adapterSpies.zoomBy).toHaveBeenCalledTimes(2);
  });
});

describe("source-bound chart ticks", () => {
  const event = () => formingBarEvent({ openTimeMs: NEWEST_OPEN_MS, open: 1.1, high: 1.2, low: 1.0, close: 1.15 });
  it("clears a retained wrong-context response instead of relabeling its candles",()=>{
    const view=renderChart(),old=openedStreams[0]!;
    view.rerender(<ARXNativeChart symbol="GBPUSD" timeframe={TF} showFeedStatus={false} overlays={NO_OVERLAYS}/>);
    expect(adapterSpies.init).toHaveBeenCalledOnce();expect(adapterSpies.destroy).not.toHaveBeenCalled();
    expect(adapterSpies.setCandles).toHaveBeenLastCalledWith([]);expect(old.closed).toBe(true);
    expect(openedStreams).toHaveLength(1);
  });
  it("fences an old stream during the layout phase before its passive cleanup",()=>{
    let old:MockEventSource|undefined,wasClosed:boolean|undefined;
    function Probe({symbol}:{symbol:string}){
      useLayoutEffect(()=>{if(old){wasClosed=old.closed;old.emit(event());}},[symbol]);
      return <ARXNativeChart symbol={symbol} timeframe={TF} showFeedStatus={false} overlays={NO_OVERLAYS}/>;
    }
    const view=render(<Probe symbol={SYMBOL}/>);old=openedStreams[0]!;
    currentCandleResponse={...currentCandleResponse!,symbol:"GBPUSD",candles:currentCandleResponse!.candles.map(c=>({...c,symbol:"GBPUSD"}))};
    view.rerender(<Probe symbol="GBPUSD"/>);
    expect(wasClosed).toBe(false);expect(adapterSpies.updateActiveCandle).not.toHaveBeenCalled();expect(old.closed).toBe(true);
    expect(adapterSpies.init).toHaveBeenCalledOnce();
  });
  it("rebinds a same-provider source identity without recreating the chart",()=>{
    const proof={symbol:SYMBOL,timeframe:TF,source:"mt5_broker",sourceIdentity:"a".repeat(64),lastClosedCandleAt:new Date(NEWEST_OPEN_MS+M5_MS).toISOString()};
    currentCandleResponse={...currentCandleResponse!,marketEvidence:proof};const view=renderChart(),old=openedStreams[0]!;
    const first=adapterSpies.setCandles.mock.calls.length;
    currentCandleResponse={...currentCandleResponse!,marketEvidence:{...proof,sourceIdentity:"b".repeat(64)}};
    view.rerender(<ARXNativeChart symbol={SYMBOL} timeframe={TF} showFeedStatus={false} overlays={NO_OVERLAYS}/>);
    expect(old.closed).toBe(true);expect(openedStreams).toHaveLength(2);expect(adapterSpies.init).toHaveBeenCalledOnce();
    expect(adapterSpies.setCandles.mock.calls.slice(first).some(([rows])=>rows.length===0)).toBe(true);
    act(()=>old!.emit(event()));expect(adapterSpies.updateActiveCandle).not.toHaveBeenCalled();
  });
  it("discards a half-finished drawing when the observed source identity changes",()=>{
    const proof={symbol:SYMBOL,timeframe:TF,source:"mt5_broker",sourceIdentity:"a".repeat(64),lastClosedCandleAt:new Date(NEWEST_OPEN_MS+M5_MS).toISOString()};
    currentCandleResponse={...currentCandleResponse!,marketEvidence:proof};const view=renderChart();
    fireEvent.change(view.getByRole("combobox",{name:"Drawing tool"}),{target:{value:"trend"}});
    act(()=>adapterSpies.setDrawingHandler.mock.lastCall?.[0]?.({time:NEWEST_OPEN_SEC-600,price:1.1}));
    currentCandleResponse={...currentCandleResponse!,marketEvidence:{...proof,sourceIdentity:"b".repeat(64)}};
    view.rerender(<ARXNativeChart symbol={SYMBOL} timeframe={TF} showFeedStatus={false} overlays={NO_OVERLAYS}/>);
    expect(adapterSpies.setDrawingHandler).toHaveBeenLastCalledWith(null);
    fireEvent.change(view.getByRole("combobox",{name:"Drawing tool"}),{target:{value:"trend"}});
    act(()=>adapterSpies.setDrawingHandler.mock.lastCall?.[0]?.({time:NEWEST_OPEN_SEC-300,price:1.2}));
    expect(adapterSpies.setDrawings).toHaveBeenLastCalledWith([]);
    act(()=>adapterSpies.setDrawingHandler.mock.lastCall?.[0]?.({time:NEWEST_OPEN_SEC,price:1.3}));
    expect(adapterSpies.setDrawings.mock.lastCall?.[0]).toEqual([expect.objectContaining({start:{time:NEWEST_OPEN_SEC-300,price:1.2},end:{time:NEWEST_OPEN_SEC,price:1.3}})]);
  });
  it("rejects missing, wrong-source and wrong-context prices and status", () => {
    renderChart();
    const stream = openedStreams[0]!;
    act(() => {
      for (const patch of [{ source: undefined }, { source: "deriv_public" }, { source: "deriv" },
        { symbol: "V75" }, { timeframe: "M1" }]) {
        stream.emit({ ...event(), ...patch });
        stream.emit({ ...feedStatusEvent({ marketFrozen: true, lastBrokerTimeMs: 0 }), ...patch });
      }
    });
    expect(adapterSpies.updateActiveCandle).not.toHaveBeenCalled();
  });
  it("rebinds on provider switch and ignores already queued frames from the old stream", () => {
    const view = renderChart();
    const oldStream = openedStreams[0]!;
    currentCandleResponse = makeResponse({ ...liveFeedStatus(), source: "deriv_public" } as ChartFeedStatus);
    view.rerender(<ARXNativeChart symbol={SYMBOL} timeframe={TF} showFeedStatus={false} overlays={NO_OVERLAYS} />);
    expect(oldStream.closed).toBe(true);
    expect(adapterSpies.setFeedState).toHaveBeenLastCalledWith(expect.objectContaining({ source: "deriv_public" }));
    expect(openedStreams[1]!.url).toContain("source=deriv_public");
    act(() => { oldStream.emit(event()); openedStreams[1]!.emit(event()); });
    expect(adapterSpies.updateActiveCandle).not.toHaveBeenCalled();
    act(() => { openedStreams[1]!.emit({ ...event(), source: "deriv_public" }); });
    expect(adapterSpies.updateActiveCandle).toHaveBeenCalledTimes(1);
  });
  it("does not subscribe before an identified candle source exists", () => {
    currentCandleResponse = makeResponse({ ...liveFeedStatus(), source: null } as unknown as ChartFeedStatus);
    renderChart();
    expect(openedStreams).toHaveLength(0);
  });
});


describe("Scanner shared Smart Chart ownership", () => {
  it("uses the Scanner response, disables duplicate fetch and never upgrades its live-price cap", () => {
    const scannerResponse = makeResponse(liveFeedStatus());
    currentCandleResponse = { ...scannerResponse, candles: scannerResponse.candles.map(c=>({...c,close:99})) };
    render(<ARXNativeChart symbol={SYMBOL} timeframe={TF} showFeedStatus={false} externalFeed={{data:scannerResponse,isLoading:false,isFetching:false,isError:false,refetch:vi.fn(),livePriceAllowed:false}} />);
    expect(standaloneEnabled).toBe(false);
    expect(adapterSpies.setCandles.mock.calls.at(-1)?.[0].at(-1).close).toBe(1.102);
    expect(adapterSpies.setFeedState.mock.calls.at(-1)?.[0].livePriceAffordance).toBe(false);
    expect(openedStreams).toHaveLength(1);
  });
  it("ignores cached standalone intelligence when Scanner owns server overlays", () => {
    cachedIntelligence={state:{symbol:SYMBOL,timeframe:TF,truthState:{source:"mt5_broker"},trendlineOverlay:{visible:true,
      lines:[{id:"cached",start:{time:1,price:1},end:{time:2,price:2},bias:"bullish",dominant:true}],markers:[]}}};
    const report=vi.fn();
    render(<ARXNativeChart symbol={SYMBOL} timeframe={TF} showFeedStatus={false} onIntelligenceChange={report}
      externalFeed={{data:currentCandleResponse,isLoading:false,isFetching:false,isError:false,refetch:vi.fn(),livePriceAllowed:true}} />);
    expect(report).not.toHaveBeenCalled();
    expect(adapterSpies.setStructureLines.mock.calls.every(call=>call[0].length===0)).toBe(true);
  });
  it("revokes overlay handles before replacing the price series, then publishes the selected style", () => {
    const operations: string[]=[];
    const surface={chart:{},series:{name:"candles"},container:document.createElement("div")};
    adapterSpies.getScannerOverlaySurface.mockImplementation(()=>surface);
    adapterSpies.setChartStyle.mockImplementation((style: string)=>{operations.push(`style:${style}`);surface.series={name:style};});
    const bind=vi.fn((value:any)=>{operations.push(value ? `bind:${value.style}:${value.series.name}` : "revoke");});
    const view=render(<ARXNativeChart symbol={SYMBOL} timeframe={TF} showFeedStatus={false} onScannerSurfaceChange={bind} />);
    operations.length=0;
    fireEvent.change(view.getByLabelText("Chart style"),{target:{value:"line"}});
    expect(operations.indexOf("revoke")).toBeLessThan(operations.indexOf("style:line"));
    expect(operations.indexOf("bind:line:line")).toBeGreaterThan(operations.indexOf("style:line"));
    operations.length=0;currentCandleResponse=undefined;
    view.rerender(<ARXNativeChart symbol="GBPUSD" timeframe={TF} showFeedStatus={false} onScannerSurfaceChange={bind} />);
    expect(bind.mock.calls.at(-1)?.[0]).toBeNull();
    view.unmount();expect(bind.mock.calls.at(-1)?.[0]).toBeNull();
  });
});
