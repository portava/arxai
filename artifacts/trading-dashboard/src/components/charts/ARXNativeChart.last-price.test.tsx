// Truth regression: the header last-price badge must not read as a live price
// when the board itself has graded the feed not live (stale / invalid), and its
// digit count must match the axis (candleDisplayPrecision), not a magnitude guess.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, screen } from "@testing-library/react";
import type { ChartCandle, ChartCandlesResponse, ChartFeedStatus } from "@workspace/api-client-react";

let currentCandleResponse: ChartCandlesResponse | undefined;

const adapterSpies = {
  init: vi.fn(),
  destroy: vi.fn(),
  setSymbol: vi.fn(),
  setTimeframe: vi.fn(),
  setFeedState: vi.fn(),
  setCandles: vi.fn(),
  updateActiveCandle: vi.fn(),
  setOverlays: vi.fn(),
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
  useGetMeChartIntelligence: () => ({ data: undefined, error: null }),
  getGetMeChartIntelligenceQueryKey: () => ["chart-intelligence"],
  GetChartCandlesTimeframe: { M1: "M1", M5: "M5", M15: "M15", M30: "M30", H1: "H1", H4: "H4", D1: "D1" },
}));

vi.mock("@/hooks/useScannerTruth", () => ({
  useScannerTruth: () => ({
    truth: null,
    feedStatus: null,
    isLoading: false,
    isError: false,
    refetch: () => {},
  }),
}));

import { ARXNativeChart } from "./ARXNativeChart";

interface OpenedStream {
  url: string;
  emit: (payload: unknown) => void;
  fail: () => void;
  closed: boolean;
}
let openedStreams: OpenedStream[] = [];

class MockEventSource {
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly entry: OpenedStream;
  constructor(url: string) {
    this.entry = {
      url,
      closed: false,
      emit: (payload: unknown) => this.onmessage?.({ data: JSON.stringify(payload) }),
      fail: () => this.onerror?.({}),
    };
    openedStreams.push(this.entry);
  }
  close() {
    this.entry.closed = true;
  }
}

let SYMBOL = "EURUSD";
const TF = "M5";
const NEWEST_OPEN_MS = 1_700_000_000_000;
const M5_MS = 5 * 60_000;
const BADGE = "arx-native-stream-reconnecting";

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

function makeResponse(closes: number[] = [1.1, 1.101, 1.102], feed: Record<string, unknown> = {}): ChartCandlesResponse {
  return {
    symbol:SYMBOL,timeframe:TF,
    candles: [
      ...closes.map((close, i) => makeCandle(NEWEST_OPEN_MS - (closes.length - 1 - i) * M5_MS, close)),
    ],
    feedStatus: {
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
      ...feed,
    } as unknown as ChartFeedStatus,
    warning: null,
  } as unknown as ChartCandlesResponse;
}

const NO_OVERLAYS: never[] = [];
const LAST = "arx-native-last";

beforeEach(() => {
  openedStreams = [];
  SYMBOL = "EURUSD";
  Object.values(adapterSpies).forEach((s) => s.mockClear?.());
  vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

function renderChart() {
  return render(<ARXNativeChart symbol={SYMBOL} timeframe={TF} showFeedStatus={false} overlays={NO_OVERLAYS} />);
}

describe("header last-price badge", () => {
  it("shows a plain last price on a live-confirmed feed", () => {
    currentCandleResponse = makeResponse();
    renderChart();
    const badge = screen.getByTestId(LAST);
    expect(badge.textContent).toBe("1.10200");
    expect(badge.textContent).not.toMatch(/last known/i);
  });

  it.each([
    { quality: "stale", stale: true, isLive: false },
    { quality: "invalid", stale: false, isLive: false, aiUsable: false },
  ])("qualifies the price as last-known on a $quality feed", (feed) => {
    currentCandleResponse = makeResponse(undefined, feed);
    renderChart();
    const badge = screen.getByTestId(LAST);
    expect(badge.textContent).toMatch(/last known/i);
    expect(badge.getAttribute("title") ?? "").toMatch(/not live/i);
  });

  it("uses the same digit count as the price axis", () => {
    SYMBOL = "XAUUSD";
    currentCandleResponse = makeResponse([2345.6, 2346.12, 2347.125]);
    renderChart();
    // candleDisplayPrecision → 3 digits (2347.125); the old magnitude guess gave 2.
    expect(screen.getByTestId(LAST).textContent).toBe("2347.125");
  });
});
