// ARXNativeChart — every header / mirror-layer / empty-state label must
// describe what was actually observed (truth upgrade, 2026-10-28).
//
// Each block below pins one inaccuracy that used to reach the screen:
//   - a "Reconnecting — prices delayed" badge on charts that never opened a
//     tick stream (third-party candle source, or no feed at all).
//   - an AI chip reading "No AI" while the same panel kept AI overlays live
//     (the "Not AI-confirmed" badge and the aiUsable context reported to the
//     page used the uncapped raw feed flag).
//   - a "Mirror Layer" strip that read "Mirrored" over delayed/partial data,
//     flipped to "Refreshing" on every poll (hiding "Stale"/"Conflict"), read
//     "Syncing · Waiting for data" when every provider had declined, and showed
//     a "Lock ON/OFF" toggle that locked nothing.
//
// The harness renders the REAL ARXNativeChart with the candle query, the
// chart engine and the scanner-truth hook replaced by controllable stubs.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, screen } from "@testing-library/react";
import type { ChartCandle, ChartCandlesResponse, ChartFeedStatus } from "@workspace/api-client-react";

interface CandleQueryStub {
  data: ChartCandlesResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
}

let candleQuery: CandleQueryStub;

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
  setScaleMode: vi.fn(),
  setReachStartHandler: vi.fn(),
  priceToCoordinate: vi.fn(() => null),
};

vi.mock("@/lib/chart-engine", () => ({
  createChartEngineAdapter: () => adapterSpies,
}));

vi.mock("@/lib/useChartDeepHistory", () => ({
  useChartDeepHistory: () => ({
    olderCandles: [],
    analysisEvidence: null,
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
  useGetChartCandles: () => ({ ...candleQuery, refetch: vi.fn() }),
  getGetChartCandlesQueryKey: () => ["chart-candles"],
  useGetMeChartIntelligence: () => ({ data: undefined, error: null }),
  getGetMeChartIntelligenceQueryKey: () => ["chart-intelligence"],
  GetChartCandlesTimeframe: { M1: "M1", M5: "M5", M15: "M15", M30: "M30", H1: "H1", H4: "H4", D1: "D1" },
}));

// The scanner-truth hook is the cap source. Each test sets the analysis level
// it resolves to; every call's arguments are recorded.
let truthLevel: "full" | "limited" | "historical_only" | "blocked" | null = "full";
const scannerTruthCalls: unknown[][] = [];
vi.mock("@/hooks/useScannerTruth", () => ({
  useScannerTruth: (...args: unknown[]) => {
    scannerTruthCalls.push(args);
    return {
      truth: truthLevel == null ? null : { analysis: { level: truthLevel } },
      feedStatus: null,
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
  },
}));

import { ARXNativeChart } from "./ARXNativeChart";

let openedStreams: string[] = [];
let openedSources: MockEventSource[] = [];
class MockEventSource {
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(url: string) {
    openedStreams.push(url);
    openedSources.push(this);
  }
  close() {}
}

const SYMBOL = "EURUSD";
const TF = "M5";
const NEWEST_OPEN_MS = 1_700_000_000_000;
const M5_MS = 5 * 60_000;
const RECONNECTING = "arx-native-stream-reconnecting";

function makeCandle(openMs: number, close: number, source: string): ChartCandle {
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
    source,
    isComplete: true,
    isForming: false,
    sourceMode: "live",
    priceBasis: "BID",
    isFinal: true,
    receivedAt: new Date(openMs + M5_MS).toISOString(),
    qualityFlags: [],
  } as unknown as ChartCandle;
}

function makeFeedStatus(over: Partial<ChartFeedStatus> = {}): ChartFeedStatus {
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
    ...over,
  } as unknown as ChartFeedStatus;
}

function makeResponse(over: Partial<ChartFeedStatus> = {}): ChartCandlesResponse {
  const feedStatus = makeFeedStatus(over);
  const source = String(feedStatus.source);
  return {
    symbol: SYMBOL,
    timeframe: TF,
    candles: [
      makeCandle(NEWEST_OPEN_MS - 2 * M5_MS, 1.1, source),
      makeCandle(NEWEST_OPEN_MS - M5_MS, 1.101, source),
      makeCandle(NEWEST_OPEN_MS, 1.102, source),
    ],
    feedStatus,
    warning: null,
  } as unknown as ChartCandlesResponse;
}

function emptyResponse(over: Partial<ChartFeedStatus>): ChartCandlesResponse {
  return {
    symbol: SYMBOL,
    timeframe: TF,
    candles: [],
    feedStatus: makeFeedStatus({ isLive: false, aiUsable: false, ...over }),
    warning: over.warning ?? null,
  } as unknown as ChartCandlesResponse;
}

function setResponse(data: ChartCandlesResponse | undefined, over: Partial<CandleQueryStub> = {}) {
  candleQuery = { data, isLoading: false, isError: false, isFetching: false, ...over };
}

const NO_OVERLAYS: never[] = [];

function renderChart(props: Partial<Parameters<typeof ARXNativeChart>[0]> = {}) {
  return render(
    <ARXNativeChart symbol={SYMBOL} timeframe={TF} showFeedStatus overlays={NO_OVERLAYS} {...props} />,
  );
}

beforeEach(() => {
  openedStreams = [];
  openedSources = [];
  scannerTruthCalls.length = 0;
  truthLevel = "full";
  setResponse(makeResponse());
  Object.values(adapterSpies).forEach((s) => s.mockClear?.());
  vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
});

describe("reconnecting badge only describes a tick stream that exists", () => {
  it("never claims a reconnect on a third-party candle source (no stream is opened)", () => {
    vi.useFakeTimers();
    setResponse(makeResponse({ source: "assistant_real:twelve_data" }));
    renderChart();
    act(() => { vi.advanceTimersByTime(31_000); });
    expect(openedStreams).toHaveLength(0);
    expect(screen.queryByTestId(RECONNECTING)).toBeNull();
  });

  it("never claims a reconnect when there is no feed at all", () => {
    vi.useFakeTimers();
    setResponse(undefined);
    renderChart();
    act(() => { vi.advanceTimersByTime(31_000); });
    expect(openedStreams).toHaveLength(0);
    expect(screen.queryByTestId(RECONNECTING)).toBeNull();
  });

  it("still flags a real broker stream that reports an error", () => {
    renderChart();
    expect(openedStreams).toHaveLength(1);
    act(() => { openedSources[0]!.onerror?.({}); });
    expect(screen.queryByTestId(RECONNECTING)).not.toBeNull();
  });
});

describe("AI usability is one verdict across chip, badge and page context", () => {
  it.each([["historical_only"], ["limited"], [null]] as const)(
    "a %s scanner truth over a clean feed reads not-AI everywhere",
    (level) => {
      truthLevel = level;
      const onChartContextChange = vi.fn();
      renderChart({ onChartContextChange });
      const chip = screen.getByTestId("arx-feed-badge");
      expect(chip.getAttribute("data-ai-usable")).toBe("false");
      // The badge must agree with the chip, not with the raw feed flag.
      expect(screen.queryByTestId("arx-native-not-ai")).not.toBeNull();
      // The page sources AI overlays from this context: it must be told "no".
      const last = onChartContextChange.mock.calls.at(-1)?.[0] as { aiUsable: boolean };
      expect(last.aiUsable).toBe(false);
    },
  );

  it("a full scanner truth over a clean feed keeps AI usable", () => {
    const onChartContextChange = vi.fn();
    renderChart({ onChartContextChange });
    expect(screen.getByTestId("arx-feed-badge").getAttribute("data-ai-usable")).toBe("true");
    expect(screen.queryByTestId("arx-native-not-ai")).toBeNull();
    const last = onChartContextChange.mock.calls.at(-1)?.[0] as { aiUsable: boolean };
    expect(last.aiUsable).toBe(true);
  });
});

describe("feed strip says what the server graded, never an unmeasured mirror", () => {
  const strip = () => screen.getByTestId("arx-mirror-status").textContent ?? "";

  it.each([
    ["delayed", "Delayed"],
    ["partial", "Partial"],
  ] as const)("a %s feed is not shown as mirrored", (quality, label) => {
    setResponse(makeResponse({ quality, isLive: false, aiUsable: false }));
    renderChart();
    expect(strip()).not.toMatch(/mirror/i);
    expect(strip()).toBe(label);
  });

  it("a background refetch does not hide a stale verdict", () => {
    setResponse(makeResponse({ quality: "stale", stale: true, isLive: false, aiUsable: false }), { isFetching: true });
    renderChart();
    expect(strip()).toBe("Stale");
    expect(screen.queryByTestId("arx-mirror-stale")).not.toBeNull();
  });

  it("a background refetch does not hide an integrity failure", () => {
    setResponse(makeResponse({ quality: "invalid", isLive: false, aiUsable: false }), { isFetching: true });
    renderChart();
    expect(screen.queryByTestId("arx-mirror-conflict")).not.toBeNull();
  });

  it("an unavailable feed is not described as syncing or waiting", () => {
    setResponse(emptyResponse({ quality: "unavailable", source: null, warning: "No live feed is available for this symbol right now." }));
    renderChart();
    const layer = screen.getByTestId("arx-mirror-layer").textContent ?? "";
    expect(layer).not.toMatch(/syncing|waiting for data/i);
    expect(strip()).toBe("Unavailable");
  });

  it("a clean feed the shared truth has not confirmed reads the same as the chip", () => {
    truthLevel = "historical_only";
    renderChart();
    expect(strip()).toBe("Unconfirmed");
  });

  it("offers no lock toggle or inspection mode that changes nothing", () => {
    renderChart();
    expect(screen.queryByTestId("arx-mirror-lock")).toBeNull();
    expect(screen.queryByTestId("arx-mirror-inspection")).toBeNull();
    expect(screen.getByTestId("arx-mirror-layer").textContent).not.toMatch(/mirror|lock/i);
  });
});
